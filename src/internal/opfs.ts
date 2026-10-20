import { OfflibraryError } from '../errors.js';

/**
 * Origin Private File System helpers for the `storage: 'opfs'` backend.
 *
 * Layout: `/offlibrary/<namespace>/<collection>/<file>` plus `<file>.meta.json` (url, etag,
 * last-modified, size, integrity). The data file is written in place and resumed in place: an
 * interrupted download keeps its prefix, and the next attempt appends from that byte offset.
 * @internal
 */

export const ROOT_DIR = 'offlibrary';

type SyncHandle = {
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
};
type FileHandle = FileSystemFileHandle & { createSyncAccessHandle?: () => Promise<SyncHandle> };

/** @internal `true` when this context can use OPFS at all (pages, all workers). */
export function opfsAvailable(): boolean {
  const n = typeof navigator === 'undefined' ? undefined : navigator;
  return typeof n?.storage?.getDirectory === 'function';
}

/** @internal The collection's directory (created on demand). */
export async function collectionDir(namespace: string, collection: string, create = true): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    let dir = await navigator.storage.getDirectory();
    for (const name of [ROOT_DIR, namespace, collection]) dir = await dir.getDirectoryHandle(name, { create });
    return dir;
  } catch (err) {
    if (!create && (err as DOMException)?.name === 'NotFoundError') return undefined;
    throw err;
  }
}

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** @internal A file name that is safe on every OPFS implementation and stable for an id + index. */
export function fileNameOf(id: string, index: number): string {
  const safe = encodeURIComponent(id).replace(/[%*]/g, '_').slice(0, 80);
  return `${safe}~${hash(id)}.${index}.bin`;
}

export const metaNameOf = (file: string): string => `${file}.meta.json`;

/** @internal Sidecar written next to each OPFS file. */
export interface OpfsMeta {
  url: string;
  etag?: string;
  lastModified?: string;
  size?: number;
  type?: string;
  integrity?: string;
  complete?: boolean;
  updatedAt: number;
}

export async function readMeta(dir: FileSystemDirectoryHandle, file: string): Promise<OpfsMeta | undefined> {
  try {
    const f = await (await dir.getFileHandle(metaNameOf(file))).getFile();
    return JSON.parse(await f.text()) as OpfsMeta;
  } catch {
    return undefined;
  }
}

export async function writeMeta(dir: FileSystemDirectoryHandle, file: string, meta: OpfsMeta): Promise<void> {
  const handle = (await dir.getFileHandle(metaNameOf(file), { create: true })) as FileHandle;
  const text = new TextEncoder().encode(JSON.stringify(meta));
  // Workers: a tiny sync write. Pages: a writable stream (the meta file is small, so the swap copy is free).
  if (typeof handle.createSyncAccessHandle === 'function' && isDedicatedWorker()) {
    try {
      const sync = await handle.createSyncAccessHandle();
      try {
        sync.truncate(0);
        sync.write(text, { at: 0 });
        sync.flush();
      } finally {
        sync.close();
      }
      return;
    } catch {
      /* fall through */
    }
  }
  const w = await handle.createWritable();
  await w.write(text);
  await w.close();
}

export async function removeEntry(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  await dir.removeEntry(name).catch(() => undefined);
}

export async function fileOf(dir: FileSystemDirectoryHandle, name: string): Promise<File | undefined> {
  try {
    return await (await dir.getFileHandle(name)).getFile();
  } catch {
    return undefined;
  }
}

/** @internal `true` inside a dedicated worker (the only place `createSyncAccessHandle` works). */
export function isDedicatedWorker(): boolean {
  const g = globalThis as Record<string, unknown>;
  return typeof g.DedicatedWorkerGlobalScope === 'function' && globalThis instanceof (g.DedicatedWorkerGlobalScope as typeof Object);
}

/** @internal Why storage did not take the bytes. */
export type RefusalReason = 'quota' | 'short-write' | 'unavailable';

/** @internal Thrown by the writer when storage refuses bytes. `written` bytes of the chunk landed. */
export class StorageRefusal extends OfflibraryError {
  readonly reason: RefusalReason;
  constructor(reason: RefusalReason, message: string, cause?: unknown) {
    super('quota-exceeded', message, cause === undefined ? {} : { cause });
    this.reason = reason;
  }
}

const isQuota = (e: unknown) => (e as { name?: string })?.name === 'QuotaExceededError';

/** Bytes written through a stream before it is committed again (doubles with the file, see `checkpoint`). */
const STREAM_COMMIT_MIN = 16 * 1024 * 1024;

/**
 * @internal Writes a download into one OPFS file from a byte offset.
 *
 * - `sync` mode (dedicated workers): `createSyncAccessHandle()`, writes in place, every write's
 *   return value is checked (Chromium returns a short count instead of throwing when a private
 *   profile's storage fills up), `flush()` makes a checkpoint durable. Exactly 1× disk writes.
 * - `stream` mode (pages, or when the sync handle is refused): `createWritable({ keepExistingData })`.
 *   Bytes only become durable on `close()`, and reopening copies the file into a swap file, so
 *   commits happen when the uncommitted part is as big as the committed part (≈1 extra copy in
 *   total, not one per checkpoint). After each commit the file size is verified.
 */
export class OpfsWriter {
  mode: 'sync' | 'stream';
  private _handle: FileHandle;
  private _sync: SyncHandle | undefined;
  private _stream: FileSystemWritableFileStream | undefined;
  private _cursor: number;
  private _committed: number;
  private _closed = false;

  private constructor(handle: FileHandle, startAt: number, mode: 'sync' | 'stream') {
    this._handle = handle;
    this._cursor = startAt;
    this._committed = startAt;
    this.mode = mode;
  }

  /** Open `handle` for writing at `startAt`; bytes before it are kept (that is the resume). */
  static async open(handle: FileSystemFileHandle, startAt: number, preferSync = true): Promise<OpfsWriter> {
    const h = handle as FileHandle;
    if (preferSync && typeof h.createSyncAccessHandle === 'function') {
      try {
        const sync = await h.createSyncAccessHandle();
        try {
          sync.truncate(startAt);
        } catch (err) {
          sync.close();
          throw err;
        }
        const w = new OpfsWriter(h, startAt, 'sync');
        w._sync = sync;
        return w;
      } catch {
        // Not a dedicated worker, or another context holds the file's exclusive lock.
      }
    }
    const w = new OpfsWriter(h, startAt, 'stream');
    await w._openStream();
    return w;
  }

  private async _openStream(): Promise<void> {
    const keep = this._committed > 0;
    const stream = await this._handle.createWritable({ keepExistingData: keep });
    if (keep) {
      await stream.truncate(this._committed);
      await stream.seek(this._committed);
    }
    this._stream = stream;
  }

  /** Bytes written (including the resume offset). */
  get position(): number {
    return this._cursor;
  }

  /** Bytes verified durable at the last checkpoint. */
  get durable(): number {
    return this._committed;
  }

  /** Bytes written but not yet committed (stream mode keeps them in a swap file until close). */
  get pending(): number {
    return this._cursor - this._committed;
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this._closed) throw new Error('OPFS writer is closed.');
    if (this._sync) {
      let done = 0;
      while (done < chunk.byteLength) {
        const view = done === 0 ? chunk : chunk.subarray(done);
        let count: number;
        try {
          count = this._sync.write(view, { at: this._cursor });
        } catch (err) {
          if (isQuota(err)) throw new StorageRefusal('quota', 'Storage is full.', err);
          throw err;
        }
        if (!Number.isInteger(count) || count <= 0 || count > view.byteLength) {
          throw new StorageRefusal('short-write', `Storage accepted ${done} of ${chunk.byteLength} bytes (short write).`);
        }
        done += count;
        this._cursor += count;
      }
      return;
    }
    try {
      await this._stream!.write(chunk as unknown as ArrayBuffer);
    } catch (err) {
      if (isQuota(err)) throw new StorageRefusal('quota', 'Storage is full.', err);
      throw err;
    }
    this._cursor += chunk.byteLength;
  }

  /** `true` when a checkpoint is due (stream mode commits on a doubling schedule). */
  checkpointDue(flushBytes: number): boolean {
    const pending = this.pending;
    if (this.mode === 'sync') return pending >= flushBytes;
    return pending >= Math.max(STREAM_COMMIT_MIN, flushBytes, this._committed);
  }

  /** Make everything written so far durable and verify it is all there. */
  async checkpoint(): Promise<void> {
    if (this._closed) return;
    if (this._sync) {
      this._sync.flush();
      const size = this._sync.getSize();
      if (size < this._cursor) throw new StorageRefusal('short-write', `The file holds ${size} of ${this._cursor} bytes.`);
      this._committed = this._cursor;
      return;
    }
    await this._commitStream();
    await this._openStream();
  }

  private async _commitStream(): Promise<void> {
    const stream = this._stream!;
    this._stream = undefined;
    try {
      await stream.close();
    } catch (err) {
      if (isQuota(err)) throw new StorageRefusal('quota', 'Storage is full.', err);
      throw err;
    }
    const size = (await this._handle.getFile()).size;
    if (size !== this._cursor) {
      throw new StorageRefusal('short-write', `The file holds ${size} of ${this._cursor} bytes after commit.`);
    }
    this._committed = this._cursor;
  }

  /** Commit, verify, release. */
  async close(): Promise<void> {
    if (this._closed) return;
    if (this._sync) {
      try {
        await this.checkpoint();
      } finally {
        this._closed = true;
        this._sync.close();
        this._sync = undefined;
      }
      return;
    }
    this._closed = true;
    await this._commitStream();
  }

  /**
   * Release the file and keep what was written (pause, error, tab closing): the prefix is exactly
   * what the next attempt resumes from. Returns the durable byte count.
   */
  async abandon(): Promise<number> {
    if (this._closed) return this._committed;
    this._closed = true;
    if (this._sync) {
      try {
        this._sync.flush();
        this._committed = Math.min(this._cursor, this._sync.getSize());
      } catch {
        /* keep the last verified checkpoint */
      }
      this._sync.close();
      this._sync = undefined;
      return this._committed;
    }
    const stream = this._stream;
    this._stream = undefined;
    if (stream) {
      const ok = await stream.close().then(
        () => true,
        () => false,
      );
      if (ok) {
        const size = await this._handle.getFile().then((f) => f.size, () => this._committed);
        this._committed = Math.min(size, this._cursor);
      }
    }
    return this._committed;
  }
}
