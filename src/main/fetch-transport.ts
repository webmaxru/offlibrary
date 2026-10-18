import { OfflibraryError, isAbortError, toOfflibraryError } from '../errors.js';
import { partKeyOf } from '../internal/ids.js';
import { verifyIntegrity } from '../internal/integrity.js';
import { parseContentRange } from '../internal/range.js';
import { store } from '../internal/store.js';
import { sleep } from '../internal/util.js';
import type { StoredPart } from '../types.js';

/** Bytes buffered in memory before a segment is persisted for resuming. */
export const FLUSH_BYTES = 4 * 1024 * 1024;

/** @internal */
export interface FetchJob {
  key: string;
  urls: string[];
  cacheName: string;
  integrity?: (string | undefined)[];
  requestInit?: Pick<RequestInit, 'credentials' | 'headers' | 'referrerPolicy' | 'cache'>;
  /** Persist segments to IndexedDB so the download survives reloads. */
  resumable: boolean;
  retries: number;
  retryDelay: number;
  signal: AbortSignal;
  /** Called with cumulative bytes and best-known total (0 = unknown). */
  onProgress: (downloaded: number, total: number) => void;
  /** Known total from config / HEAD, used until servers tell us better. */
  total: number;
  /** Bytes buffered before a segment is persisted. Default {@link FLUSH_BYTES}. */
  flushBytes?: number;
  /** Injected for tests. */
  fetch?: typeof fetch;
}

/** @internal Result of a completed fetch download. */
export interface FetchResult {
  bytes: number;
}

const retryableStatus = (s: number) => s === 408 || s === 429 || s >= 500;

function freshPart(key: string, index: number): StoredPart {
  return { key: partKeyOf(key, index), itemKey: key, index, blobs: [], received: 0, total: 0, done: false };
}

/**
 * Download every URL of an item with streaming `fetch`, report progress, retry with
 * exponential backoff, resume with `Range`/`If-Range`, verify integrity and store the
 * result in the Cache API under the original URL.
 * @internal
 */
export async function runFetchDownload(job: FetchJob): Promise<FetchResult> {
  const doFetch = job.fetch ?? fetch.bind(globalThis);
  const cache = await caches.open(job.cacheName);
  const parts: StoredPart[] = [];
  for (let i = 0; i < job.urls.length; i++) {
    parts.push((job.resumable && (await store.getPart(partKeyOf(job.key, i)))) || freshPart(job.key, i));
  }
  const totalOf = () => {
    const known = parts.reduce((sum, p) => sum + (p.total || 0), 0);
    return parts.every((p) => p.total > 0) ? known : Math.max(job.total, known);
  };
  const receivedOf = () => parts.reduce((sum, p) => sum + p.received, 0);
  const report = () => job.onProgress(receivedOf(), totalOf());

  for (let i = 0; i < job.urls.length; i++) {
    const url = job.urls[i]!;
    let part = parts[i]!;
    if (part.done) continue;
    let attempt = 0;
    let buffer: Uint8Array[] = [];
    let buffered = 0;
    const flush = () => {
      if (buffered > 0) {
        part.blobs.push(new Blob(buffer as BlobPart[]));
        buffer = [];
        buffered = 0;
      }
    };
    const persist = async () => {
      flush();
      if (job.resumable) await store.putPart(part);
    };
    const reset = () => {
      part = parts[i] = freshPart(job.key, i);
      buffer = [];
      buffered = 0;
    };

    for (;;) {
      try {
        if (job.signal.aborted) throw job.signal.reason;
        const headers = new Headers(job.requestInit?.headers);
        const validator = part.etag ?? part.lastModified;
        if (part.received > 0) {
          if (validator) {
            headers.set('Range', `bytes=${part.received}-`);
            headers.set('If-Range', validator);
          } else reset();
        }
        const res = await doFetch(url, {
          credentials: 'same-origin',
          ...job.requestInit,
          headers,
          mode: 'cors',
          signal: job.signal,
        });
        if (res.type === 'opaque' || res.type === 'opaqueredirect') {
          throw new OfflibraryError('opaque-response', `${url} returned an opaque response. Cross-origin assets need CORS headers (Access-Control-Allow-Origin).`);
        }
        if (res.status === 206 && part.received > 0) {
          const cr = parseContentRange(res.headers.get('Content-Range'));
          if (!cr || cr.start !== part.received) {
            // The server answered a different range than asked: start over cleanly.
            await res.body?.cancel();
            reset();
            continue;
          }
          if (cr.total) part.total = cr.total;
        } else if (res.ok) {
          if (part.received > 0) reset(); // validator changed or ranges unsupported
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
        report();

        if (res.body) {
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer.push(value);
            buffered += value.byteLength;
            part.received += value.byteLength;
            report();
            if (buffered >= (job.flushBytes ?? FLUSH_BYTES)) await persist();
          }
        }
        flush();
        if (part.total && part.received < part.total) {
          throw new OfflibraryError('network-error', `${url} ended early (${part.received} of ${part.total} bytes).`, { retryable: true });
        }
        const blob = new Blob(part.blobs, part.type ? { type: part.type } : undefined);
        const integrity = job.integrity?.[i];
        if (integrity) await verifyIntegrity(blob, integrity, url);
        const headersOut = new Headers({ 'Content-Length': String(blob.size) });
        if (part.type) headersOut.set('Content-Type', part.type);
        if (part.etag) headersOut.set('ETag', part.etag);
        if (part.lastModified) headersOut.set('Last-Modified', part.lastModified);
        await cache.put(url, new Response(blob, { status: 200, headers: headersOut }));
        part.total = blob.size;
        part.received = blob.size;
        part.done = true;
        part.blobs = [];
        if (job.resumable && job.urls.length > 1) await store.putPart(part);
        report();
        break;
      } catch (err) {
        const error = job.signal.aborted ? job.signal.reason : err;
        if (job.signal.aborted || isAbortError(error)) {
          await persist().catch(() => undefined);
          throw toOfflibraryError(error);
        }
        const e = toOfflibraryError(error);
        if (e.code === 'integrity') {
          reset();
          if (job.resumable) await store.deleteParts(job.key).catch(() => undefined);
          throw e;
        }
        await persist().catch(() => undefined);
        if (!e.retryable || attempt >= job.retries) throw e;
        const delay = job.retryDelay * 2 ** attempt * (0.75 + Math.random() * 0.5);
        attempt++;
        await sleep(delay, job.signal).catch((reason) => {
          throw toOfflibraryError(reason);
        });
      }
    }
  }
  const bytes = receivedOf();
  if (job.resumable) await store.deleteParts(job.key);
  return { bytes };
}
