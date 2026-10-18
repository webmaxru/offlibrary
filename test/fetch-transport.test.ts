import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runFetchDownload } from '../src/main/fetch-transport.js';
import type { FetchJob } from '../src/main/fetch-transport.js';
import { store } from '../src/internal/store.js';
import { bytes, mockServer } from './helpers.js';

const URL1 = 'https://cdn.test/ep1.mp3';
const URL2 = 'https://cdn.test/ep1.vtt';

function job(overrides: Partial<FetchJob> & Pick<FetchJob, 'fetch'>): FetchJob {
  return {
    key: 'default/episodes/ep1',
    urls: [URL1],
    cacheName: 'offlibrary:default:episodes',
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
  const res = await (await caches.open('offlibrary:default:episodes')).match(url);
  return res ? new Uint8Array(await res.arrayBuffer()) : undefined;
}

describe('runFetchDownload', () => {
  it('streams into the cache and reports progress', async () => {
    const file = bytes(10_000);
    const server = mockServer({ [URL1]: file }, { chunk: 1000 });
    const progress: [number, number][] = [];
    const result = await runFetchDownload(job({ fetch: server.fetch, onProgress: (d, t) => progress.push([d, t]) }));
    expect(result.bytes).toBe(10_000);
    expect(await cached(URL1)).toEqual(file);
    expect(progress.at(-1)).toEqual([10_000, 10_000]);
    expect(progress.length).toBeGreaterThan(5);
    const res = await (await caches.open('offlibrary:default:episodes')).match(URL1);
    expect(res!.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(res!.headers.get('Content-Length')).toBe('10000');
  });

  it('downloads multi-URL items with aggregate progress', async () => {
    const a = bytes(3000, 1);
    const b = bytes(500, 2);
    const server = mockServer({ [URL1]: a, [URL2]: b });
    let last: [number, number] = [0, 0];
    await runFetchDownload(job({ fetch: server.fetch, urls: [URL1, URL2], onProgress: (d, t) => (last = [d, t]) }));
    expect(await cached(URL1)).toEqual(a);
    expect(await cached(URL2)).toEqual(b);
    expect(last).toEqual([3500, 3500]);
  });

  it('resumes after an abort with Range + If-Range and keeps earlier bytes', async () => {
    const flush = 64 * 1024;
    const size = flush * 4 + 20_000;
    const file = bytes(size);
    const server = mockServer({ [URL1]: file }, { chunk: 16 * 1024 });
    const controller = new AbortController();
    let seen = 0;
    const first = runFetchDownload(
      job({
        fetch: server.fetch,
        flushBytes: flush,
        signal: controller.signal,
        onProgress: (d) => {
          seen = d;
          if (d >= flush * 2 + 16 * 1024) controller.abort(new DOMException('Paused', 'AbortError'));
        },
      }),
    );
    await expect(first).rejects.toMatchObject({ code: 'aborted' });
    const part = await store.getPart('default/episodes/ep1#0');
    expect(part?.received).toBe(seen);
    expect(part?.etag).toBe('"v1"');

    await runFetchDownload(job({ fetch: server.fetch, flushBytes: flush }));
    const resumeReq = server.requests.at(-1)!;
    expect(resumeReq.range).toBe(`bytes=${seen}-`);
    expect(resumeReq.ifRange).toBe('"v1"');
    expect(await cached(URL1)).toEqual(file);
    expect(await store.getPart('default/episodes/ep1#0')).toBeUndefined();
  });

  it('restarts cleanly when the server ignores the range (validator changed)', async () => {
    const file = bytes(5000);
    const s1 = mockServer({ [URL1]: file }, { chunk: 1000 });
    const c = new AbortController();
    await expect(
      runFetchDownload(job({ fetch: s1.fetch, signal: c.signal, onProgress: (d) => d >= 2000 && c.abort() })),
    ).rejects.toMatchObject({ code: 'aborted' });
    const changed = bytes(4000, 9);
    const s2 = mockServer({ [URL1]: changed }, { etag: '"v2"' });
    await runFetchDownload(job({ fetch: s2.fetch }));
    expect(s2.requests[0]!.range).toBe('bytes=2000-');
    expect(await cached(URL1)).toEqual(changed);
  });

  it('retries network drops and resumes mid-file within one call', async () => {
    const file = bytes(20_000);
    const server = mockServer({ [URL1]: file }, { chunk: 1000, dropAfter: 7000, dropOn: [1, 2] });
    await runFetchDownload(job({ fetch: server.fetch, retries: 3 }));
    expect(await cached(URL1)).toEqual(file);
    const gets = server.requests.filter((r) => r.method === 'GET');
    expect(gets).toHaveLength(3);
    expect(gets[1]!.range).toBe('bytes=7000-');
  });

  it('retries 503 but not 404', async () => {
    const file = bytes(100);
    const ok = mockServer({ [URL1]: file }, { statuses: [503, 503] });
    await runFetchDownload(job({ fetch: ok.fetch, retries: 2 }));
    expect(await cached(URL1)).toEqual(file);

    const missing = mockServer({});
    await expect(runFetchDownload(job({ fetch: missing.fetch, retries: 5 }))).rejects.toMatchObject({ code: 'http-error', status: 404 });
    expect(missing.requests).toHaveLength(1);
  });

  it('gives up after the configured retries', async () => {
    const server = mockServer({ [URL1]: bytes(10) }, { statuses: [500, 500, 500] });
    await expect(runFetchDownload(job({ fetch: server.fetch, retries: 2 }))).rejects.toMatchObject({ code: 'http-error', status: 500 });
    expect(server.requests).toHaveLength(3);
  });

  it('verifies integrity and stores nothing on mismatch', async () => {
    const file = bytes(2048);
    const good = `sha256-${createHash('sha256').update(file).digest('base64')}`;
    await runFetchDownload(job({ fetch: mockServer({ [URL1]: file }).fetch, integrity: [good] }));
    expect(await cached(URL1)).toEqual(file);

    await (await caches.open('offlibrary:default:episodes')).delete(URL1);
    await expect(
      runFetchDownload(job({ fetch: mockServer({ [URL1]: file }).fetch, integrity: ['sha256-AAAA'] })),
    ).rejects.toMatchObject({ code: 'integrity' });
    expect(await cached(URL1)).toBeUndefined();
  });

  it('rejects opaque responses with a CORS hint', async () => {
    const opaque = (async () => {
      const r = new Response(null, { status: 200 });
      Object.defineProperty(r, 'type', { value: 'opaque' });
      return r;
    }) as unknown as typeof fetch;
    await expect(runFetchDownload(job({ fetch: opaque }))).rejects.toMatchObject({ code: 'opaque-response' });
  });

  it('skips files already finished in an earlier attempt of a multi-URL item', async () => {
    const a = bytes(1000, 1);
    const b = bytes(1000, 2);
    const failing = mockServer({ [URL1]: a });
    await expect(runFetchDownload(job({ fetch: failing.fetch, urls: [URL1, URL2] }))).rejects.toMatchObject({ code: 'http-error' });
    const server = mockServer({ [URL1]: a, [URL2]: b });
    await runFetchDownload(job({ fetch: server.fetch, urls: [URL1, URL2] }));
    expect(server.requests.map((r) => r.url)).toEqual([URL2]);
    expect(await cached(URL2)).toEqual(b);
  });
});
