import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOfflibrary, OfflibraryError } from '../src/index.js';
import type { Offlibrary, OfflibraryConfig, OfflibraryEventMap } from '../src/index.js';
import { store } from '../src/internal/store.js';
import { FakeBackgroundFetch } from './bgfetch-fake.js';
import { bytes, mockServer, tick, until } from './helpers.js';

const A = 'https://cdn.test/a.mp3';
const B = 'https://cdn.test/b.mp3';
const C = 'https://cdn.test/c.mp3';

const libs: Offlibrary[] = [];
function make(config: Partial<OfflibraryConfig> = {}, collection: OfflibraryConfig['collections'][string] = {}) {
  const lib = createOfflibrary({
    serviceWorker: false,
    persist: 'never',
    progressInterval: 0,
    collections: { episodes: { retryDelay: 1, ...collection } },
    ...config,
  });
  libs.push(lib);
  return lib;
}
function record(lib: Offlibrary) {
  const events: { type: string; id: string; status: string }[] = [];
  for (const type of ['progress', 'complete', 'error', 'abort', 'delete', 'evict'] as const) {
    lib.on(type, ({ item }: OfflibraryEventMap[typeof type]) => events.push({ type, id: item.id, status: item.status }));
  }
  return events;
}

afterEach(() => {
  for (const l of libs.splice(0)) l.destroy();
  vi.unstubAllGlobals();
});

describe('fetch transport (no Background Fetch)', () => {
  it('downloads, reports progress and stores the file', async () => {
    const file = bytes(50_000);
    const server = mockServer({ [A]: file }, { chunk: 5000 });
    vi.stubGlobal('fetch', server.fetch);
    const lib = make();
    const events = record(lib);
    const episodes = lib.collection('episodes');

    const started = await episodes.download({ id: 'a', url: A, title: 'Episode A', meta: { n: 1 } });
    expect(started.status).toBe('downloading');
    expect(started.strategy).toBe('fetch');
    const done = await episodes.done('a');
    expect(done).toMatchObject({ status: 'completed', bytes: 50_000, progress: 1, title: 'Episode A', meta: { n: 1 } });
    expect(await episodes.has('a')).toBe(true);
    expect(new Uint8Array(await (await episodes.blob('a'))!.arrayBuffer())).toEqual(file);
    expect(await episodes.usage()).toEqual({ count: 1, bytes: 50_000 });
    expect(events.filter((e) => e.type === 'progress').length).toBeGreaterThan(3);
    expect(events.at(-1)).toMatchObject({ type: 'complete', id: 'a' });
    // HEAD measured the size up front.
    expect(server.requests[0]).toMatchObject({ method: 'HEAD' });
  });

  it('keeps snapshots referentially stable until something changes', async () => {
    vi.stubGlobal('fetch', mockServer({ [A]: bytes(10) }).fetch);
    const lib = make();
    await lib.ready;
    const episodes = lib.collection('episodes');
    const s1 = episodes.snapshot();
    expect(episodes.snapshot()).toBe(s1);
    await episodes.download({ id: 'a', url: A });
    await episodes.done('a');
    const s2 = episodes.snapshot();
    expect(s2).not.toBe(s1);
    expect(s2.map((i) => i.id)).toEqual(['a']);
    expect(episodes.snapshot()).toBe(s2);
  });

  it('is idempotent for the same version and re-downloads a new version', async () => {
    const server = mockServer({ [A]: bytes(100) });
    vi.stubGlobal('fetch', server.fetch);
    const episodes = make().collection('episodes');
    await episodes.download({ id: 'a', url: A, version: '1', size: 100 });
    await episodes.done('a');
    const before = server.requests.length;
    await episodes.download({ id: 'a', url: A, version: '1', size: 100 });
    expect(server.requests.length).toBe(before);
    await episodes.download({ id: 'a', url: A, version: '2', size: 100 });
    expect((await episodes.done('a')).version).toBe('2');
    expect(server.requests.length).toBe(before + 1);
  });

  it('cancels a running download and forgets it', async () => {
    vi.stubGlobal('fetch', mockServer({ [A]: bytes(100_000) }, { chunk: 1000, delay: 2 }).fetch);
    const lib = make();
    const events = record(lib);
    const episodes = lib.collection('episodes');
    await episodes.download({ id: 'a', url: A, size: 100_000 });
    await until(() => (episodes.peek('a')?.downloaded ?? 0) > 5000);
    await episodes.cancel('a');
    expect(episodes.peek('a')).toBeUndefined();
    expect(await store.getItem('default/episodes/a')).toBeUndefined();
    expect(await store.getPart('default/episodes/a#0')).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: 'abort', id: 'a' });
    await expect(episodes.done('a')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('pauses and resumes with a Range request', async () => {
    const file = bytes(60_000);
    const server = mockServer({ [A]: file }, { chunk: 1000, delay: 1 });
    vi.stubGlobal('fetch', server.fetch);
    const episodes = make().collection('episodes');
    await episodes.download({ id: 'a', url: A, size: 60_000 });
    await until(() => (episodes.peek('a')?.downloaded ?? 0) > 10_000);
    const paused = await episodes.pause('a');
    expect(paused.status).toBe('paused');
    const at = paused.downloaded;
    expect(at).toBeGreaterThan(10_000);
    await episodes.resume('a');
    await episodes.done('a');
    expect(server.requests.at(-1)!.range).toBe(`bytes=${at}-`);
    expect(new Uint8Array(await (await episodes.blob('a'))!.arrayBuffer())).toEqual(file);
  });

  it('marks failures, emits error, and retries', async () => {
    const server = mockServer({ [A]: bytes(10) }, { statuses: [500, 500] });
    vi.stubGlobal('fetch', server.fetch);
    const lib = make({}, { retries: 0 });
    const errors: OfflibraryEventMap['error'][] = [];
    lib.on('error', (d) => errors.push(d));
    const episodes = lib.collection('episodes');
    await episodes.download({ id: 'a', url: A, size: 10 });
    await expect(episodes.done('a')).rejects.toMatchObject({ code: 'http-error', status: 500 });
    expect(episodes.peek('a')).toMatchObject({ status: 'failed', error: { code: 'http-error', status: 500 } });
    expect(errors[0]!.error).toBeInstanceOf(OfflibraryError);
    await episodes.retry('a'); // second 500
    await expect(episodes.done('a')).rejects.toMatchObject({ code: 'http-error' });
    await episodes.retry('a');
    expect((await episodes.done('a')).attempts).toBe(3);
  });

  it('evicts the least recently used item beyond maxItems (pinned and touched items survive)', async () => {
    vi.stubGlobal('fetch', mockServer({ [A]: bytes(10), [B]: bytes(10), [C]: bytes(10) }).fetch);
    const lib = make({}, { maxItems: 2 });
    const events = record(lib);
    const episodes = lib.collection('episodes');
    await episodes.download({ id: 'a', url: A, size: 10 });
    await episodes.done('a');
    await tick(2);
    await episodes.download({ id: 'b', url: B, size: 10 });
    await episodes.done('b');
    await tick(2);
    await episodes.touch('a'); // b is now least recently used
    await episodes.download({ id: 'c', url: C, size: 10 });
    await episodes.done('c');
    expect(episodes.snapshot().map((i) => i.id).sort()).toEqual(['a', 'c']);
    expect(events.find((e) => e.type === 'evict')).toMatchObject({ id: 'b' });
    expect(await (await caches.open('offlibrary:default:episodes')).match(B)).toBeUndefined();
  });

  it('throws limit-exceeded for items bigger than maxBytes, or when eviction is off', async () => {
    vi.stubGlobal('fetch', mockServer({ [A]: bytes(10), [B]: bytes(10) }).fetch);
    const episodes = make({}, { maxBytes: 15, evict: 'none' }).collection('episodes');
    await expect(episodes.download({ id: 'big', url: A, size: 100 })).rejects.toMatchObject({ code: 'limit-exceeded' });
    await episodes.download({ id: 'a', url: A, size: 10 });
    await episodes.done('a');
    await expect(episodes.download({ id: 'b', url: B, size: 10 })).rejects.toMatchObject({ code: 'limit-exceeded' });
  });

  it('checks the storage quota before downloading and evicts to make room', async () => {
    vi.stubGlobal('fetch', mockServer({ [A]: bytes(600), [B]: bytes(600) }).fetch);
    let usage = 0;
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ usage, quota: 1000 }) } });
    const episodes = make().collection('episodes');
    await expect(episodes.download({ id: 'x', url: A, size: 5000 })).rejects.toMatchObject({ code: 'quota-exceeded' });
    await episodes.download({ id: 'a', url: A, size: 600 });
    await episodes.done('a');
    usage = 600;
    await episodes.download({ id: 'b', url: B, size: 600 }); // needs a's space
    expect(episodes.peek('a')).toBeUndefined();
  });

  it('resumes interrupted downloads when a new instance starts (page reload)', async () => {
    const file = bytes(40_000);
    const server = mockServer({ [A]: file }, { chunk: 1000, delay: 1 });
    vi.stubGlobal('fetch', server.fetch);
    const first = make();
    const episodes = first.collection('episodes');
    await episodes.download({ id: 'a', url: A, size: 40_000 });
    await until(() => (episodes.peek('a')?.downloaded ?? 0) > 8000);
    // Simulate a crash: stop the transport but leave the record as "downloading".
    first.destroy();
    await tick(20);
    await store.updateItem('default/episodes/a', (r) => {
      r.status = 'downloading';
    });

    const second = make();
    const again = second.collection('episodes');
    await second.ready;
    const done = await again.done('a');
    expect(done.status).toBe('completed');
    expect(server.requests.filter((r) => r.range).length).toBeGreaterThan(0);
    expect(new Uint8Array(await (await again.blob('a'))!.arrayBuffer())).toEqual(file);
  });

  it('sync() updates metadata and prunes items that left the feed', async () => {
    vi.stubGlobal('fetch', mockServer({ [A]: bytes(10), [B]: bytes(10) }).fetch);
    const episodes = make().collection('episodes');
    await episodes.download({ id: 'a', url: A, title: 'Old', size: 10 });
    await episodes.download({ id: 'b', url: B, size: 10, pinned: true });
    await Promise.all([episodes.done('a'), episodes.done('b')]);
    const out = await episodes.sync([{ id: 'a', title: 'New' }, { id: 'z' }]);
    expect(out[0]!.title).toBe('New');
    expect(out[1]).toBeUndefined();
    await episodes.sync([{ id: 'z' }], { prune: true });
    expect(episodes.snapshot().map((i) => i.id)).toEqual(['b']); // pinned survives
  });

  it('rejects unknown collections and invalid items', async () => {
    const lib = make();
    expect(() => lib.collection('nope')).toThrow(/Unknown collection/);
    await expect(lib.collection('episodes').download({ id: '', url: A })).rejects.toMatchObject({ code: 'invalid-item' });
  });
});

describe('Background Fetch transport', () => {
  function bgLib(bg: FakeBackgroundFetch, collection: OfflibraryConfig['collections'][string] = {}) {
    return make({ serviceWorker: { backgroundFetch: bg } as unknown as ServiceWorkerRegistration }, { backgroundFetchThreshold: 0, ...collection });
  }

  it('starts a Background Fetch with a deterministic id and stores the result via the SW handler', async () => {
    const file = bytes(30_000);
    const server = mockServer({ [A]: file });
    vi.stubGlobal('fetch', server.fetch);
    const bg = new FakeBackgroundFetch(server);
    const lib = bgLib(bg, { ui: { icons: [{ src: '/i.png' }] } });
    const events = record(lib);
    const episodes = lib.collection('episodes');
    const item = await episodes.download({ id: 'a', url: A, title: 'Episode A' });
    expect(item.strategy).toBe('background-fetch');
    expect(bg.calls[0]).toMatchObject({ id: 'offlibrary:default/episodes/a', urls: [A], options: { title: 'Episode A', downloadTotal: 30_000, icons: [{ src: '/i.png' }] } });
    const done = await episodes.done('a');
    expect(done.bytes).toBe(30_000);
    expect(bg.updateUI).toHaveBeenCalledWith(expect.objectContaining({ title: 'Episode A is ready offline' }));
    expect(new Uint8Array(await (await episodes.blob('a'))!.arrayBuffer())).toEqual(file);
    expect(events.some((e) => e.type === 'progress')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'complete' });
  });

  it('uses fetch for items below the threshold under "auto"', async () => {
    const server = mockServer({ [A]: bytes(100) });
    vi.stubGlobal('fetch', server.fetch);
    const bg = new FakeBackgroundFetch(server);
    const episodes = bgLib(bg, { backgroundFetchThreshold: 1000 }).collection('episodes');
    expect((await episodes.download({ id: 'a', url: A, size: 100 })).strategy).toBe('fetch');
    expect(bg.calls).toHaveLength(0);
  });

  it('falls back to fetch when Background Fetch refuses to start', async () => {
    const server = mockServer({ [A]: bytes(100) });
    vi.stubGlobal('fetch', server.fetch);
    const bg = new FakeBackgroundFetch(server);
    bg.fetch = async () => {
      throw new TypeError('no active worker');
    };
    const episodes = bgLib(bg).collection('episodes');
    await episodes.download({ id: 'a', url: A, size: 100 });
    expect((await episodes.done('a')).strategy).toBe('fetch');
  });

  it('re-attaches to an in-flight Background Fetch after a reload', async () => {
    const server = mockServer({ [A]: bytes(1000) });
    vi.stubGlobal('fetch', server.fetch);
    const bg = new FakeBackgroundFetch(server, { hold: true });
    const first = bgLib(bg);
    await first.collection('episodes').download({ id: 'a', url: A, size: 1000 });
    first.destroy();

    const second = bgLib(bg);
    await second.ready;
    const episodes = second.collection('episodes');
    expect(episodes.peek('a')?.status).toBe('downloading');
    const done = episodes.done('a');
    bg.release();
    expect((await done).status).toBe('completed');
    expect(bg.calls).toHaveLength(1);
  });

  it('cancel() aborts the Background Fetch and removes the item', async () => {
    const server = mockServer({ [A]: bytes(1000) });
    vi.stubGlobal('fetch', server.fetch);
    const bg = new FakeBackgroundFetch(server, { hold: true });
    const episodes = bgLib(bg).collection('episodes');
    await episodes.download({ id: 'a', url: A, size: 1000 });
    const reg = bg.regs.get('offlibrary:default/episodes/a')!;
    await episodes.cancel('a');
    expect(reg.aborted).toBe(true);
    expect(episodes.peek('a')).toBeUndefined();
    await expect(episodes.pause('a')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('pause() is not supported for Background Fetch downloads', async () => {
    const server = mockServer({ [A]: bytes(1000) });
    vi.stubGlobal('fetch', server.fetch);
    const bg = new FakeBackgroundFetch(server, { hold: true });
    const episodes = bgLib(bg).collection('episodes');
    await episodes.download({ id: 'a', url: A, size: 1000 });
    await expect(episodes.pause('a')).rejects.toMatchObject({ code: 'not-supported' });
    bg.release();
    await episodes.done('a');
  });

  it('reports browser failures and retries once without a declared total on download-total-exceeded', async () => {
    const server = mockServer({ [A]: bytes(1000) });
    vi.stubGlobal('fetch', server.fetch);
    const bg = new FakeBackgroundFetch(server, { failWith: 'download-total-exceeded', failOnce: true });
    const lib = bgLib(bg);
    const episodes = lib.collection('episodes');
    // A second instance stands in for "the page" receiving the SW broadcast.
    const page = bgLib(bg);
    await page.ready;
    await episodes.download({ id: 'a', url: A, size: 10 });
    await until(() => page.collection('episodes').peek('a')?.status === 'completed');
    expect(bg.calls).toHaveLength(2);
    expect(bg.calls[1]!.options.downloadTotal).toBe(0);
  });

  it('marks other browser failures as failed with a mapped code', async () => {
    const server = mockServer({ [A]: bytes(1000) });
    vi.stubGlobal('fetch', server.fetch);
    const bg = new FakeBackgroundFetch(server, { failWith: 'bad-status' });
    const lib = bgLib(bg);
    const page = bgLib(bg);
    const errors: string[] = [];
    page.on('error', ({ error }) => errors.push(error.code));
    await page.ready;
    await lib.collection('episodes').download({ id: 'a', url: A, size: 1000 });
    await until(() => errors.length > 0);
    expect(errors).toEqual(['http-error']);
    expect(page.collection('episodes').peek('a')?.status).toBe('failed');
  });
});
