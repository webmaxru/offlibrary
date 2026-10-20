import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runFetchDownload } from '../src/main/fetch-transport.js';
import type { FetchJob } from '../src/main/fetch-transport.js';
import { store, openDB } from '../src/internal/store.js';
import { bytes, mockServer } from './helpers.js';

const URL1 = 'https://cdn.test/model.onnx';
const KEY = 'default/models/m1';
const sri = (b: Uint8Array) => `sha256-${createHash('sha256').update(b).digest('base64')}`;

function job(overrides: Partial<FetchJob> & Pick<FetchJob, 'fetch'>): FetchJob {
  return {
    key: KEY,
    urls: [URL1],
    cacheName: 'offlibrary:default:models',
    resumable: true,
    retries: 0,
    retryDelay: 1,
    signal: new AbortController().signal,
    onProgress: () => {},
    total: 0,
    ...overrides,
  };
}

async function cached(url: string): Promise<Uint8Array | undefined> {
  const res = await (await caches.open('offlibrary:default:models')).match(url);
  return res ? new Uint8Array(await res.arrayBuffer()) : undefined;
}

/** Count IndexedDB writes per store by wrapping IDBObjectStore.put. */
function countPuts() {
  const counts: Record<string, { n: number; bytes: number }> = {};
  const proto = (globalThis as any).IDBObjectStore.prototype;
  const orig = proto.put;
  proto.put = function (value: any, key?: any) {
    const c = (counts[this.name] ??= { n: 0, bytes: 0 });
    c.n++;
    if (value?.blob instanceof Blob) c.bytes += value.blob.size;
    if (Array.isArray(value?.blobs)) c.bytes += value.blobs.reduce((s: number, b: Blob) => s + b.size, 0);
    return orig.call(this, value, key);
  };
  return { counts, restore: () => (proto.put = orig) };
}

describe('append-only checkpoints (Cache backend)', () => {
  it('writes each byte to IndexedDB once: one small segment per checkpoint, metadata without data', async () => {
    const flush = 16 * 1024;
    const size = flush * 20 + 123;
    const file = bytes(size);
    const spy = countPuts();
    try {
      await runFetchDownload(job({ fetch: mockServer({ [URL1]: file }, { chunk: 4096 }).fetch, flushBytes: flush }));
    } finally {
      spy.restore();
    }
    expect(await cached(URL1)).toEqual(file);
    // 20 full segments plus the 123-byte tail: every byte written once.
    expect(spy.counts.segments!.n).toBe(21);
    expect(spy.counts.segments!.bytes).toBe(size);
    // Part records carry metadata only (the 0.2.0-dev code stored the growing Blob list here: 33x writes).
    expect(spy.counts.parts?.bytes ?? 0).toBe(0);
    // Everything is cleaned up afterwards.
    expect(await store.getSegments(`${KEY}#0`)).toEqual([]);
  });

  it('resumes from the appended segments after an abort', async () => {
    const flush = 8 * 1024;
    const file = bytes(flush * 10 + 5);
    const server = mockServer({ [URL1]: file }, { chunk: 2048 });
    const c = new AbortController();
    await expect(
      runFetchDownload(job({ fetch: server.fetch, flushBytes: flush, signal: c.signal, onProgress: (d) => d >= flush * 5 + 4096 && c.abort() })),
    ).rejects.toMatchObject({ code: 'aborted' });
    const segs = await store.getSegments(`${KEY}#0`);
    const part = await store.getPart(`${KEY}#0`);
    expect(segs.length).toBeGreaterThanOrEqual(5);
    expect(part!.received).toBe(segs.at(-1)!.end);
    expect(part!.segments).toBe(segs.length);

    let resumed = false;
    await runFetchDownload(job({ fetch: server.fetch, flushBytes: flush, onProgress: (_d, _t, info) => (resumed ||= !!info?.resumed) }));
    expect(server.requests.at(-1)!.range).toBe(`bytes=${part!.received}-`);
    expect(resumed).toBe(true);
    expect(await cached(URL1)).toEqual(file);
  });

  it('migrates v1 part records (Blob list) into segments on upgrade', async () => {
    // Build a v1 database by hand, then open it with the current code.
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('offlibrary', 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        db.createObjectStore('items', { keyPath: 'key' }).createIndex('scope', 'scope');
        db.createObjectStore('parts', { keyPath: 'key' }).createIndex('itemKey', 'itemKey');
        open.transaction!.objectStore('parts').put({ key: `${KEY}#0`, itemKey: KEY, index: 0, blobs: [new Blob(['abc']), new Blob(['defg'])], received: 7, total: 10, etag: '"v1"', done: false });
      };
      open.onsuccess = () => {
        open.result.close();
        resolve();
      };
      open.onerror = () => reject(open.error);
    });
    await openDB();
    const part = await store.getPart(`${KEY}#0`);
    expect(part).toMatchObject({ received: 7, segments: 2 });
    expect((part as any).blobs).toBeUndefined();
    const segs = await store.getSegments(`${KEY}#0`);
    expect(segs.map((s) => s.end)).toEqual([3, 7]);
  });
});

describe('streaming integrity', () => {
  it('verifies sha256 while streaming, also across a resume (hash state is checkpointed)', async () => {
    const flush = 8 * 1024;
    const file = bytes(flush * 6 + 77);
    const server = mockServer({ [URL1]: file }, { chunk: 1000 });
    const c = new AbortController();
    await expect(
      runFetchDownload(job({ fetch: server.fetch, flushBytes: flush, integrity: [sri(file)], signal: c.signal, onProgress: (d) => d >= flush * 3 + 500 && c.abort() })),
    ).rejects.toMatchObject({ code: 'aborted' });
    const part = await store.getPart(`${KEY}#0`);
    expect(part!.hash?.length).toBe(part!.received);
    await runFetchDownload(job({ fetch: server.fetch, flushBytes: flush, integrity: [sri(file)] }));
    expect(await cached(URL1)).toEqual(file);
  });

  it('rejects a corrupted file and keeps nothing to resume from', async () => {
    const file = bytes(50_000);
    await expect(
      runFetchDownload(job({ fetch: mockServer({ [URL1]: file }).fetch, flushBytes: 8192, integrity: [sri(bytes(50_000, 3))] })),
    ).rejects.toMatchObject({ code: 'integrity' });
    expect(await cached(URL1)).toBeUndefined();
    expect(await store.getPart(`${KEY}#0`)).toBeUndefined();
    expect(await store.getSegments(`${KEY}#0`)).toEqual([]);
  });
});

describe('resume correctness', () => {
  it('does not send If-Range with a weak ETag (it would never match): restarts cleanly instead', async () => {
    const file = bytes(30_000);
    const server = mockServer({ [URL1]: file }, { chunk: 1000, etag: 'W/"weak"' });
    const c = new AbortController();
    await expect(
      runFetchDownload(job({ fetch: server.fetch, flushBytes: 4096, signal: c.signal, onProgress: (d) => d >= 10_000 && c.abort() })),
    ).rejects.toMatchObject({ code: 'aborted' });
    await runFetchDownload(job({ fetch: server.fetch, flushBytes: 4096 }));
    const last = server.requests.at(-1)!;
    expect(last.range).toBeNull();
    expect(last.ifRange).toBeNull();
    expect(await cached(URL1)).toEqual(file);
  });

  it('treats 416 with a matching total as "already complete"', async () => {
    const file = bytes(8192 * 2);
    // State left by an attempt that stored every byte but stopped before finalising.
    const part = { key: `${KEY}#0`, itemKey: KEY, index: 0, received: 8192, total: file.length, etag: '"v1"', done: false, segments: 0, url: URL1 };
    await store.appendSegment(part, new Blob([file.subarray(0, 8192)]));
    part.received = 8192 * 2;
    await store.appendSegment(part, new Blob([file.subarray(8192)]));
    const seen: string[] = [];
    const f416 = (async (_u: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get('Range') ?? '');
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${file.length}` } });
    }) as unknown as typeof fetch;
    const out = await runFetchDownload(job({ fetch: f416, flushBytes: 8192 }));
    expect(seen).toEqual([`bytes=${8192 * 2}-`]);
    expect(out.bytes).toBe(file.length);
    expect(await cached(URL1)).toEqual(file);
  });

  it('keys resume on the logical URL: a different signed redirect target still resumes', async () => {
    const file = bytes(40_000);
    const server = mockServer({ [URL1]: file }, { chunk: 1000 });
    // Simulate redirects to a new signed URL per request (res.url differs, ETag is stable).
    let n = 0;
    const redirecting = (async (u: string, init: RequestInit) => {
      const res = await server.fetch(u, init);
      Object.defineProperty(res, 'url', { value: `https://cas-bridge.test/xet?sig=${++n}` });
      Object.defineProperty(res, 'redirected', { value: true });
      return res;
    }) as unknown as typeof fetch;
    const c = new AbortController();
    await expect(
      runFetchDownload(job({ fetch: redirecting, flushBytes: 4096, signal: c.signal, onProgress: (d) => d >= 20_000 && c.abort() })),
    ).rejects.toMatchObject({ code: 'aborted' });
    await runFetchDownload(job({ fetch: redirecting, flushBytes: 4096 }));
    expect(server.requests.at(-1)!.url).toBe(URL1);
    expect(server.requests.at(-1)!.range).toMatch(/^bytes=2\d{4}-$/);
    expect(await cached(URL1)).toEqual(file);
  });

  it('restarts from zero when the stored part belongs to another URL', async () => {
    const file = bytes(20_000);
    await store.putPart({ key: `${KEY}#0`, itemKey: KEY, index: 0, received: 5000, total: 20_000, etag: '"v1"', done: false, segments: 0, url: 'https://old.test/x' });
    const server = mockServer({ [URL1]: file });
    await runFetchDownload(job({ fetch: server.fetch }));
    expect(server.requests[0]!.range).toBeNull();
    expect(await cached(URL1)).toEqual(file);
  });
});

describe('storage refused → memory', () => {
  it('finishes in memory when cache.put throws QuotaExceededError (onStorageRefused: memory)', async () => {
    const file = bytes(30_000);
    const c = await caches.open('offlibrary:default:models');
    (c as any).put = async () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
    const reasons: string[] = [];
    const out = await runFetchDownload(
      job({ fetch: mockServer({ [URL1]: file }).fetch, flushBytes: 4096, onStorageRefused: 'memory', onStorageRefusedFallback: (r) => reasons.push(r) }),
    );
    expect(out.storage).toBe('memory');
    expect(out.refused).toBe('quota');
    expect(reasons).toEqual(['quota']);
    const data = out.memory!.get(URL1)!;
    expect(new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data)).toEqual(file);
  });

  it('fails with quota-exceeded by default', async () => {
    const c = await caches.open('offlibrary:default:models');
    (c as any).put = async () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
    await expect(runFetchDownload(job({ fetch: mockServer({ [URL1]: bytes(1000) }).fetch }))).rejects.toMatchObject({ code: 'quota-exceeded' });
  });

  it('memoryOnly skips storage and fills a preallocated buffer', async () => {
    const file = bytes(12_345);
    const out = await runFetchDownload(job({ fetch: mockServer({ [URL1]: file }).fetch, memoryOnly: true, onStorageRefused: 'memory', total: file.length }));
    expect(out.storage).toBe('memory');
    const data = out.memory!.get(URL1)!;
    expect(data).toBeInstanceOf(Uint8Array);
    expect(data).toEqual(file);
    expect(await cached(URL1)).toBeUndefined();
  });
});
