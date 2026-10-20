import { OfflibraryError, isAbortError, toOfflibraryError } from '../errors.js';
import { partKeyOf } from '../internal/ids.js';
import { IntegrityCheck } from '../internal/integrity-stream.js';
import { OpfsWriter, StorageRefusal, collectionDir, fileOf, metaNameOf, readMeta, removeEntry, writeMeta } from '../internal/opfs.js';
import type { RefusalReason } from '../internal/opfs.js';
import { parseContentRange } from '../internal/range.js';
import { store } from '../internal/store.js';
import { sleep } from '../internal/util.js';
import type { StorageKind, StoredPart } from '../types.js';

/** Bytes between checkpoints (an IndexedDB segment, or an OPFS flush). */
export const FLUSH_BYTES = 4 * 1024 * 1024;

/** @internal Extra facts reported with progress. */
export interface ProgressInfo {
  /** This attempt continued from stored bytes (a `206` to a `Range` request). */
  resumed: boolean;
}

/** @internal */
export interface FetchJob {
  key: string;
  urls: string[];
  cacheName: string;
  /** Where to store the bytes. Default `'cache'`. */
  storage?: 'cache' | 'opfs';
  /** OPFS location (required for `storage: 'opfs'`). */
  opfs?: { namespace: string; collection: string; files: string[] };
  /** What to do when storage refuses bytes (quota, private browsing). Default `'error'`. */
  onStorageRefused?: 'error' | 'memory';
  /** Skip storage entirely and keep the bytes in memory (quota pre-check already failed). */
  memoryOnly?: boolean;
  integrity?: (string | undefined)[];
  requestInit?: Pick<RequestInit, 'credentials' | 'headers' | 'referrerPolicy' | 'cache'>;
  /** Persist checkpoints so the download survives reloads. */
  resumable: boolean;
  retries: number;
  retryDelay: number;
  signal: AbortSignal;
  /** Called with cumulative bytes and best-known total (0 = unknown). */
  onProgress: (downloaded: number, total: number, info?: ProgressInfo) => void;
  /** Called once when storage refused the bytes and the download moved to memory. */
  onStorageRefusedFallback?: (reason: RefusalReason, error: OfflibraryError) => void;
  /** Known total from config / HEAD, used until servers tell us better. */
  total: number;
  /** Bytes between checkpoints. Default {@link FLUSH_BYTES}. */
  flushBytes?: number;
  /** Injected for tests. */
  fetch?: typeof fetch;
}

/** @internal Result of a completed fetch download. */
export interface FetchResult {
  bytes: number;
  storage: StorageKind;
  /** Per-URL bytes kept in memory (only when storage refused them). */
  memory?: Map<string, Uint8Array | Blob>;
  refused?: RefusalReason;
  resumed: boolean;
}

const retryableStatus = (s: number) => s === 408 || s === 429 || s >= 500;
const strongEtag = (etag: string | undefined) => (etag && !/^W\//i.test(etag) ? etag : undefined);

function freshPart(key: string, index: number, url: string): StoredPart {
  return { key: partKeyOf(key, index), itemKey: key, index, received: 0, total: 0, done: false, segments: 0, url };
}

/** Bytes held in memory: a preallocated buffer when the size is known, chunks otherwise. */
class MemorySink {
  private _buf: Uint8Array | undefined;
  private _chunks: Uint8Array[] = [];
  private _size = 0;
  constructor(total: number) {
    if (total > 0) this._buf = new Uint8Array(total);
  }
  get size(): number {
    return this._size;
  }
  write(chunk: Uint8Array): void {
    if (this._buf && this._size + chunk.byteLength <= this._buf.byteLength) this._buf.set(chunk, this._size);
    else {
      if (this._buf) {
        this._chunks.push(this._buf.subarray(0, this._size));
        this._buf = undefined;
      }
      this._chunks.push(chunk.slice());
    }
    this._size += chunk.byteLength;
  }
  /** Copy a blob (a stored prefix) in, 16 MiB at a time, without a second full copy. */
  async writeBlob(blob: Blob, end = blob.size): Promise<void> {
    for (let pos = 0; pos < end; pos += 16 * 1024 * 1024) {
      this.write(new Uint8Array(await blob.slice(pos, Math.min(end, pos + 16 * 1024 * 1024)).arrayBuffer()));
    }
  }
  reset(): void {
    this._chunks = [];
    this._size = 0;
  }
  result(type?: string): Uint8Array | Blob {
    if (this._buf && !this._chunks.length) return this._size === this._buf.byteLength ? this._buf : this._buf.subarray(0, this._size);
    return new Blob(this._chunks as BlobPart[], type ? { type } : undefined);
  }
}

/**
 * Download every URL of an item with streaming `fetch`: progress, retries with exponential backoff,
 * exact resume with `Range` + `If-Range`, streaming integrity, and storage in the Cache API
 * (append-only IndexedDB checkpoints) or straight into an OPFS file. When storage refuses bytes and
 * `onStorageRefused` is `'memory'`, the download continues in memory without fetching again.
 * @internal
 */
export async function runFetchDownload(job: FetchJob): Promise<FetchResult> {
  const doFetch = job.fetch ?? fetch.bind(globalThis);
  const flushBytes = job.flushBytes ?? FLUSH_BYTES;
  const backend = job.storage ?? 'cache';
  const allowMemory = job.onStorageRefused === 'memory';
  const memory = new Map<string, Uint8Array | Blob>();
  let refused: RefusalReason | undefined = job.memoryOnly ? 'quota' : undefined;
  let anyResumed = false;

  const parts: StoredPart[] = [];
  for (let i = 0; i < job.urls.length; i++) {
    const saved = job.resumable && !job.memoryOnly ? await store.getPart(partKeyOf(job.key, i)) : undefined;
    // Resume is keyed on the logical URL: a redirect to a fresh signed URL does not change it.
    parts.push(saved && (saved.url === undefined || saved.url === job.urls[i]) ? saved : freshPart(job.key, i, job.urls[i]!));
  }
  const live = parts.map((p) => p.received);
  const totalOf = () => {
    const known = parts.reduce((sum, p) => sum + (p.total || 0), 0);
    return parts.every((p) => p.total > 0) ? known : Math.max(job.total, known);
  };
  let resumedNow = false;
  const report = () => job.onProgress(live.reduce((a, b) => a + b, 0), totalOf(), { resumed: resumedNow });
  const dir = backend === 'opfs' && !job.memoryOnly ? await openDir(job) : undefined;
  const cache = backend === 'cache' && !job.memoryOnly ? await caches.open(job.cacheName) : undefined;

  for (let i = 0; i < job.urls.length; i++) {
    const url = job.urls[i]!;
    let part = parts[i]!;
    if (part.done && !job.memoryOnly) continue;
    const sri = job.integrity?.[i];
    const fileName = job.opfs?.files[i];
    let attempt = 0;

    // ---- per-part state
    let mem: MemorySink | undefined = job.memoryOnly ? new MemorySink(part.total || (job.urls.length === 1 ? job.total : 0)) : undefined;
    let writer: OpfsWriter | undefined;
    let fileHandle: FileSystemFileHandle | undefined;
    /** Cache backend: chunks since the last segment. Stream-mode OPFS + memory fallback: chunks since the last commit. */
    let buffer: Uint8Array[] = [];
    let buffered = 0;
    /** Cache backend without resumable: every Blob of this part (kept in memory, as in 0.1). */
    let blobs: Blob[] = [];
    let check = sri ? new IntegrityCheck(sri, part.hash) : undefined;
    /** Hash state at the last checkpoint, with its offset (to save next to a durable prefix). */
    let checkpointHash = { at: part.received, state: part.hash };
    let received = part.received;

    const setReceived = (n: number) => {
      received = n;
      live[i] = n;
    };

    // ---- establish the resume point
    if (mem) {
      setReceived(0);
      check = sri ? new IntegrityCheck(sri) : undefined;
    } else if (backend === 'cache') {
      if (job.resumable && received > 0) {
        const segs = await store.getSegments(part.key);
        const end = segs.at(-1)?.end ?? 0;
        if (end !== received) {
          // Metadata and segments disagree (should not happen: they are written together). Trust the data.
          part.hash = undefined;
          check = sri ? new IntegrityCheck(sri) : undefined;
        }
        setReceived(end);
        part.received = end;
        if (check && check.hashed < end) await check.catchUp(new Blob(segs.map((s) => s.blob)), end);
      }
    } else {
      fileHandle = await dir!.getFileHandle(fileName!, { create: true });
      const file = await fileHandle.getFile();
      let start = 0;
      if (job.resumable) {
        const meta = await readMeta(dir!, fileName!);
        const validator = strongEtag(part.etag ?? meta?.etag) ?? part.lastModified ?? meta?.lastModified;
        const sameUrl = (meta?.url ?? part.url) === url;
        const fits = !(part.total || meta?.size) || file.size <= (part.total || meta!.size!);
        if (file.size > 0 && sameUrl && validator && fits && !meta?.complete) {
          start = file.size;
          part.etag ??= meta?.etag;
          part.lastModified ??= meta?.lastModified;
          if (!part.total && meta?.size) part.total = meta.size;
          if (check) {
            if (part.hash && part.hash.length <= start) check = new IntegrityCheck(sri!, part.hash);
            else check = new IntegrityCheck(sri!);
            await check.catchUp(file, start); // hash only the bytes written after the last checkpoint
          }
        }
      }
      if (start === 0 && check) check.reset();
      setReceived(start);
      part.received = start;
    }

    const persistPart = async () => {
      if (!job.resumable || mem) return;
      part.received = received;
      const hashMatches = check?.hashed === received;
      if (hashMatches) part.hash = check!.state();
      else if (checkpointHash.at === received) part.hash = checkpointHash.state;
      else delete part.hash;
      if (backend === 'cache') {
        if (buffered > 0) {
          await store.appendSegment(part, new Blob(buffer as BlobPart[]));
          buffer = [];
          buffered = 0;
        } else await store.putPart(part);
      } else await store.putPart(part);
      checkpointHash = { at: received, state: part.hash };
    };

    const checkpoint = async () => {
      if (mem) return;
      if (backend === 'cache') {
        if (!job.resumable) {
          blobs.push(new Blob(buffer as BlobPart[]));
          buffer = [];
          buffered = 0;
          return;
        }
        await persistPart();
      } else {
        await writer!.checkpoint();
        if (writer!.mode === 'stream') {
          buffer = [];
          buffered = 0;
        }
        await persistPart();
      }
    };

    /** Move everything stored so far for this part into memory and continue there. */
    const spill = async (error: OfflibraryError, reason: RefusalReason, chunk?: Uint8Array, chunkLanded = 0) => {
      if (!allowMemory) throw error;
      const sink = new MemorySink(part.total || (job.urls.length === 1 ? job.total : 0));
      if (backend === 'cache') {
        if (job.resumable) {
          const segs = await store.getSegments(part.key).catch(() => []);
          for (const s of segs) await sink.writeBlob(s.blob);
        } else for (const b of blobs) await sink.writeBlob(b);
        for (const c of buffer) sink.write(c);
      } else {
        let durable = 0;
        if (writer?.mode === 'sync') {
          durable = writer.position;
          await writer.abandon();
        } else if (writer) await writer.abandon();
        const file = await fileHandle!.getFile();
        if (writer?.mode === 'stream') {
          const committed = Math.min(file.size, received - buffered);
          await sink.writeBlob(file, committed);
          for (const c of buffer) sink.write(c);
        } else await sink.writeBlob(file, Math.min(durable, file.size));
        await removeEntry(dir!, fileName!);
        await removeEntry(dir!, metaNameOf(fileName!));
      }
      if (chunk) sink.write(chunkLanded ? chunk.subarray(chunkLanded) : chunk);
      buffer = [];
      buffered = 0;
      blobs = [];
      writer = undefined;
      if (job.resumable) await store.deleteParts(job.key).catch(() => undefined);
      mem = sink;
      if (sink.size !== received + (chunk?.byteLength ?? 0)) {
        throw new OfflibraryError('quota-exceeded', `Storage refused the download and ${received + (chunk?.byteLength ?? 0) - sink.size} bytes could not be recovered.`, { retryable: true });
      }
      if (!refused) {
        refused = reason;
        job.onStorageRefusedFallback?.(reason, error);
      }
    };

    const refusalOf = (err: unknown): StorageRefusal | undefined => {
      if (err instanceof StorageRefusal) return err;
      const e = toOfflibraryError(err);
      return e.code === 'quota-exceeded' ? new StorageRefusal('quota', e.message, err) : undefined;
    };

    const restart = async () => {
      setReceived(0);
      part = parts[i] = { ...freshPart(job.key, i, url), etag: undefined };
      buffer = [];
      buffered = 0;
      blobs = [];
      check?.reset();
      checkpointHash = { at: 0, state: undefined };
      if (mem) mem.reset();
      else if (backend === 'cache') {
        if (job.resumable) await store.resetPart(part);
      } else {
        await writer?.abandon();
        writer = undefined;
        writer = await OpfsWriter.open(fileHandle!, 0);
        if (job.resumable) await store.putPart(part);
      }
    };

    for (;;) {
      try {
        if (job.signal.aborted) throw job.signal.reason;
        const headers = new Headers(job.requestInit?.headers);
        const validator = strongEtag(part.etag) ?? part.lastModified;
        if (received > 0) {
          if (validator) {
            headers.set('Range', `bytes=${received}-`);
            headers.set('If-Range', validator);
          } else await restart();
        }
        const res = await doFetch(url, {
          credentials: 'same-origin',
          ...job.requestInit,
          headers,
          mode: 'cors',
          redirect: 'follow',
          signal: job.signal,
        });
        if (res.type === 'opaque' || res.type === 'opaqueredirect') {
          throw new OfflibraryError('opaque-response', `${url} returned an opaque response. Cross-origin assets need CORS headers (Access-Control-Allow-Origin).`);
        }
        resumedNow = false;
        let complete = false;
        if (res.status === 416 && received > 0) {
          // Asked for bytes past the end: the stored copy may already be whole.
          await res.body?.cancel();
          const total = Number(/\/(\d+)\s*$/.exec(res.headers.get('Content-Range') ?? '')?.[1]);
          if (total === received) complete = true;
          else {
            await restart();
            continue;
          }
        } else if (res.status === 206 && received > 0) {
          const cr = parseContentRange(res.headers.get('Content-Range'));
          if (!cr || cr.start !== received) {
            // The server answered a different range than asked: start over cleanly.
            await res.body?.cancel();
            await restart();
            continue;
          }
          if (cr.total) part.total = cr.total;
          resumedNow = true;
          anyResumed = true;
        } else if (res.ok) {
          // 200: a fresh copy (first attempt, validator changed, or ranges unsupported).
          if (received > 0) await restart();
          part.etag = res.headers.get('ETag') ?? undefined;
          part.lastModified = res.headers.get('Last-Modified') ?? undefined;
          part.type = res.headers.get('Content-Type') ?? undefined;
          const len = Number(res.headers.get('Content-Length'));
          if (len > 0 && !res.headers.get('Content-Encoding')) part.total = len;
        } else {
          await res.body?.cancel();
          throw new OfflibraryError('http-error', `${url} responded ${res.status}.`, {
            status: res.status,
            retryable: retryableStatus(res.status),
          });
        }
        if (!part.type) part.type = res.headers.get('Content-Type') ?? undefined;

        if (!mem && backend === 'opfs') {
          if (!writer) {
            try {
              writer = await OpfsWriter.open(fileHandle!, received);
            } catch (err) {
              const r = refusalOf(err);
              if (!r) throw err;
              await spill(r, r.reason);
            }
          }
          if (!resumedNow && !complete && writer && job.resumable) {
            await writeMeta(dir!, fileName!, {
              url,
              ...(part.etag ? { etag: part.etag } : {}),
              ...(part.lastModified ? { lastModified: part.lastModified } : {}),
              ...(part.total ? { size: part.total } : {}),
              ...(part.type ? { type: part.type } : {}),
              ...(sri ? { integrity: sri } : {}),
              updatedAt: Date.now(),
            }).catch(async (err) => {
              const r = refusalOf(err);
              if (!r) throw err;
              await spill(r, r.reason);
            });
            await store.putPart(part);
          }
        }
        if (mem && part.total && !mem.size) mem = new MemorySink(part.total);
        report();

        if (res.body && !complete) {
          const reader = res.body.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (part.total && received + value.byteLength > part.total) {
                throw new OfflibraryError('network-error', `${url} sent more bytes than its declared ${part.total}.`, { retryable: true });
              }
              check?.update(value);
              if (mem) mem.write(value);
              else if (backend === 'cache') {
                buffer.push(value);
                buffered += value.byteLength;
              } else {
                const before = writer!.position;
                try {
                  await writer!.write(value);
                  if (writer!.mode === 'stream' && allowMemory) {
                    buffer.push(value);
                    buffered += value.byteLength;
                  }
                } catch (err) {
                  const r = refusalOf(err);
                  if (!r) throw err;
                  setReceived(received); // unchanged until the spill accounts for this chunk
                  await spill(r, r.reason, value, writer!.mode === 'sync' ? writer!.position - before : 0);
                  setReceived(received + value.byteLength);
                  report();
                  continue;
                }
              }
              setReceived(received + value.byteLength);
              report();
              const due = mem ? false : backend === 'cache' ? buffered >= flushBytes : writer!.checkpointDue(flushBytes);
              if (due) {
                try {
                  await checkpoint();
                } catch (err) {
                  const r = refusalOf(err);
                  if (!r) throw err;
                  await spill(r, r.reason);
                }
              }
            }
          } finally {
            reader.releaseLock();
          }
        }
        if (part.total && received < part.total) {
          throw new OfflibraryError('network-error', `${url} ended early (${received} of ${part.total} bytes).`, { retryable: true });
        }

        // ---- finish this part
        const type = part.type;
        if (mem) {
          await check?.verify(url, async () => toBlob(mem!.result(type)));
          memory.set(url, mem.result(type));
        } else if (backend === 'cache') {
          let blob: Blob;
          if (job.resumable) {
            if (buffered > 0) await persistPart().catch(async (err) => {
              const r = refusalOf(err);
              if (!r) throw err;
              await spill(r, r.reason);
            });
            if (mem) {
              await check?.verify(url, async () => toBlob(mem!.result(type)));
              memory.set(url, (mem as MemorySink).result(type));
              part.done = true;
              report();
              break;
            }
            const segs = await store.getSegments(part.key);
            blob = new Blob(segs.map((s) => s.blob), type ? { type } : undefined);
          } else {
            if (buffered > 0) blobs.push(new Blob(buffer as BlobPart[]));
            buffer = [];
            buffered = 0;
            blob = new Blob(blobs, type ? { type } : undefined);
          }
          if (blob.size !== received) {
            throw new OfflibraryError('quota-exceeded', `Stored ${blob.size} of ${received} bytes for ${url}.`, { retryable: true });
          }
          await check?.verify(url, async () => blob);
          const headersOut = new Headers({ 'Content-Length': String(blob.size) });
          if (type) headersOut.set('Content-Type', type);
          if (part.etag) headersOut.set('ETag', part.etag);
          if (part.lastModified) headersOut.set('Last-Modified', part.lastModified);
          try {
            await cache!.put(url, new Response(blob, { status: 200, headers: headersOut }));
          } catch (err) {
            const r = refusalOf(err);
            if (!r || !allowMemory) throw err;
            const sink = new MemorySink(blob.size);
            await sink.writeBlob(blob);
            memory.set(url, sink.result(type));
            if (!refused) {
              refused = r.reason;
              job.onStorageRefusedFallback?.(r.reason, r);
            }
          }
          blobs = [];
        } else {
          if (writer) {
            try {
              await writer.close();
            } catch (err) {
              const r = refusalOf(err);
              if (!r) throw err;
              await spill(r, r.reason);
            }
            writer = undefined;
          }
          if (mem) {
            await check?.verify(url, async () => toBlob(mem!.result(type)));
            memory.set(url, (mem as MemorySink).result(type));
          } else {
            const file = await fileHandle!.getFile();
            if (file.size !== received) {
              throw new OfflibraryError('quota-exceeded', `The stored file holds ${file.size} of ${received} bytes.`, { retryable: true });
            }
            await check?.verify(url, async () => file);
            await writeMeta(dir!, fileName!, {
              url,
              ...(part.etag ? { etag: part.etag } : {}),
              ...(part.lastModified ? { lastModified: part.lastModified } : {}),
              size: received,
              ...(type ? { type } : {}),
              ...(sri ? { integrity: sri } : {}),
              complete: true,
              updatedAt: Date.now(),
            });
          }
        }
        part.total = received;
        part.done = true;
        if (job.resumable && job.urls.length > 1 && !memory.has(url)) {
          delete part.hash;
          await store.putPart(part);
        }
        report();
        break;
      } catch (err) {
        const error = job.signal.aborted ? job.signal.reason : err;
        if (job.signal.aborted || isAbortError(error)) {
          await keepPrefix().catch(() => undefined);
          throw toOfflibraryError(error);
        }
        const e = toOfflibraryError(error);
        if (e.code === 'integrity') {
          await writer?.abandon().catch(() => undefined);
          writer = undefined;
          if (dir && fileName) {
            await removeEntry(dir, fileName);
            await removeEntry(dir, metaNameOf(fileName));
          }
          if (job.resumable) await store.deleteParts(job.key).catch(() => undefined);
          throw e;
        }
        if (!e.retryable || attempt >= job.retries) {
          await keepPrefix().catch(() => undefined);
          throw e;
        }
        if (backend === 'cache' && job.resumable && !mem) await persistPart().catch(() => undefined);
        const delay = job.retryDelay * 2 ** attempt * (0.75 + Math.random() * 0.5);
        attempt++;
        await sleep(delay, job.signal).catch(async (reason) => {
          await keepPrefix().catch(() => undefined);
          throw toOfflibraryError(reason);
        });
      }
    }

    /** Save what we have so the next attempt (or next page load) resumes from it. */
    async function keepPrefix(): Promise<void> {
      if (mem) return;
      if (backend === 'cache') {
        if (job.resumable) await persistPart();
        return;
      }
      if (writer) {
        const durable = await writer.abandon();
        writer = undefined;
        setReceived(durable);
      }
      await persistPart();
    }
  }

  const bytes = live.reduce((a, b) => a + b, 0);
  if (job.resumable) await store.deleteParts(job.key).catch(() => undefined);
  const storage: StorageKind = memory.size ? 'memory' : backend;
  const out: FetchResult = { bytes, storage, resumed: anyResumed };
  if (memory.size) out.memory = memory;
  if (refused && memory.size) out.refused = refused;
  return out;
}

const toBlob = (x: Uint8Array | Blob): Blob => (x instanceof Blob ? x : new Blob([x as BlobPart]));

async function openDir(job: FetchJob): Promise<FileSystemDirectoryHandle> {
  if (!job.opfs) throw new OfflibraryError('invalid-config', 'storage "opfs" needs a location.');
  const dir = await collectionDir(job.opfs.namespace, job.opfs.collection);
  return dir!;
}

/** @internal Read a completed OPFS file (undefined if missing). */
export async function opfsFile(namespace: string, collection: string, name: string): Promise<File | undefined> {
  const dir = await collectionDir(namespace, collection, false).catch(() => undefined);
  return dir ? fileOf(dir, name) : undefined;
}
