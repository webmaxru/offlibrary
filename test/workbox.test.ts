import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheFirst, CacheOnly, NetworkFirst, NetworkOnly } from 'workbox-strategies';
import { RangeRequestsPlugin } from 'workbox-range-requests';
import { _resetServe } from '../src/internal/serve.js';
import { store } from '../src/internal/store.js';
import type { StoredItem } from '../src/types.js';
import { OfflibraryPlugin, initOfflibrary, isOfflibraryRequest, offlibraryHandler, offlibraryMatch } from '../src/workbox.js';

const STORED = 'https://app.test/media/ep1.mp3';
const OTHER = 'https://app.test/media/other.mp3';
const BODY = '0123456789';

function item(over: Partial<StoredItem> = {}): StoredItem {
  return {
    key: 'default/episodes/ep1', scope: 'default/episodes', namespace: 'default', collection: 'episodes', id: 'ep1',
    urls: [STORED], status: 'completed', strategy: 'fetch', downloaded: 10, total: 10, bytes: 10, attempts: 1,
    createdAt: 1, updatedAt: 1, cacheName: 'offlibrary:default:episodes',
    ...over,
  };
}

/** Minimal ExtendableEvent for running real Workbox strategies in Node. */
function fetchEvent(request: Request) {
  const Ctor = (globalThis as unknown as { ExtendableEvent: new (type: string) => ExtendableEvent & { pending: Promise<unknown>[] } }).ExtendableEvent;
  return Object.assign(new Ctor('fetch'), { request });
}

const range = (url: string, r: string) => new Request(url, { headers: { Range: r } });

let network: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  await store.putItem(item());
  await (await caches.open('offlibrary:default:episodes')).put(STORED, new Response(BODY, { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '10' } }));
  await _resetServe();
  network = vi.fn(async (input: RequestInfo) => new Response(`network:${typeof input === 'string' ? input : input.url}`, { status: 200 }));
  vi.stubGlobal('fetch', network);
  vi.stubGlobal('location', new URL('https://app.test/sw.js')); // Workbox logs URLs relative to the worker
});

afterEach(() => vi.unstubAllGlobals());

describe('offlibraryMatch', () => {
  it('matches stored files only', () => {
    expect(offlibraryMatch({ request: new Request(STORED) })).toBe(true);
    expect(offlibraryMatch({ request: new Request(`${STORED}#t=10`) })).toBe(true);
    expect(offlibraryMatch({ request: new Request(OTHER) })).toBe(false);
    expect(offlibraryMatch({ request: new Request(STORED, { method: 'POST', body: 'x' }) })).toBe(false);
  });

  it('never claims navigations', () => {
    const nav = { method: 'GET', mode: 'navigate', url: STORED, destination: 'document', headers: new Headers() } as unknown as Request;
    expect(isOfflibraryRequest(nav)).toBe(false);
  });
});

describe('offlibraryHandler', () => {
  it('serves stored files, with 206 for Range, without touching the network', async () => {
    const handler = offlibraryHandler();
    const full = await handler.handle({ request: new Request(STORED), event: undefined });
    expect(full.status).toBe(200);
    expect(await full.text()).toBe(BODY);
    const part = await handler.handle({ request: range(STORED, 'bytes=3-5'), event: undefined });
    expect(part.status).toBe(206);
    expect(part.headers.get('Content-Range')).toBe('bytes 3-5/10');
    expect(await part.text()).toBe('345');
    expect(network).not.toHaveBeenCalled();
  });

  it('falls back to fetch() by default', async () => {
    const res = await offlibraryHandler().handle({ request: new Request(OTHER), event: undefined });
    expect(await res.text()).toBe(`network:${OTHER}`);
  });

  it('passes misses to a fallback strategy object or callback', async () => {
    const strategy = { handle: vi.fn(async () => new Response('from strategy')) };
    const res = await offlibraryHandler({ fallback: strategy }).handle({ request: OTHER, event: undefined, params: ['p'] });
    expect(await res.text()).toBe('from strategy');
    expect(strategy.handle).toHaveBeenCalledWith(expect.objectContaining({ params: ['p'], request: expect.any(Request) }));
    const cb = vi.fn(async () => new Response('from callback'));
    expect(await (await offlibraryHandler({ fallback: cb }).handle({ request: new Request(OTHER), event: undefined })).text()).toBe('from callback');
  });

  it('works with a real Workbox strategy as the fallback', async () => {
    const handler = offlibraryHandler({ fallback: new NetworkOnly() });
    const request = new Request(OTHER);
    const res = await handler.handle({ request, event: fetchEvent(request) });
    expect(await res.text()).toBe(`network:${OTHER}`);
  });
});

describe('OfflibraryPlugin inside real Workbox strategies', () => {
  it('CacheFirst: serves the stored file instead of going to the network', async () => {
    const strategy = new CacheFirst({ cacheName: 'media', plugins: [new OfflibraryPlugin()] });
    const request = new Request(STORED);
    const res = await strategy.handle({ request, event: fetchEvent(request) });
    expect(await res.text()).toBe(BODY);
    expect(network).not.toHaveBeenCalled();
  });

  it('CacheFirst: answers Range with 206, alone or next to RangeRequestsPlugin', async () => {
    for (const plugins of [[new OfflibraryPlugin()], [new RangeRequestsPlugin(), new OfflibraryPlugin()], [new OfflibraryPlugin(), new RangeRequestsPlugin()]]) {
      const strategy = new CacheFirst({ cacheName: 'media', plugins });
      const request = range(STORED, 'bytes=7-');
      const res = await strategy.handle({ request, event: fetchEvent(request) });
      expect(res.status).toBe(206);
      expect(await res.text()).toBe('789');
    }
    expect(network).not.toHaveBeenCalled();
  });

  it('CacheOnly: serves stored files that are not in the strategy cache', async () => {
    const strategy = new CacheOnly({ cacheName: 'media', plugins: [new OfflibraryPlugin()] });
    const request = new Request(STORED);
    expect(await (await strategy.handle({ request, event: fetchEvent(request) })).text()).toBe(BODY);
  });

  it('passes files it does not store through to the network', async () => {
    const strategy = new CacheFirst({ cacheName: 'media', plugins: [new OfflibraryPlugin()] });
    const request = new Request(OTHER);
    const event = fetchEvent(request);
    expect(await (await strategy.handle({ request, event })).text()).toBe(`network:${OTHER}`);
    await Promise.all(event.pending);
  });

  it('NetworkOnly offline: the stored copy is the fallback (handlerDidError)', async () => {
    network.mockRejectedValue(new TypeError('Failed to fetch'));
    const strategy = new NetworkOnly({ plugins: [new OfflibraryPlugin()] });
    const request = range(STORED, 'bytes=0-1');
    const res = await strategy.handle({ request, event: fetchEvent(request) });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('01');
  });

  it('NetworkFirst offline: the stored copy is used when the strategy cache is empty', async () => {
    network.mockRejectedValue(new TypeError('Failed to fetch'));
    const strategy = new NetworkFirst({ cacheName: 'media', plugins: [new OfflibraryPlugin()] });
    const request = new Request(STORED);
    expect(await (await strategy.handle({ request, event: fetchEvent(request) })).text()).toBe(BODY);
  });

  it('still fails for files it does not store when offline', async () => {
    network.mockRejectedValue(new TypeError('Failed to fetch'));
    const strategy = new NetworkOnly({ plugins: [new OfflibraryPlugin()] });
    const request = new Request(OTHER);
    await expect(strategy.handle({ request, event: fetchEvent(request) })).rejects.toThrow();
  });

  it('can switch either callback off', () => {
    expect(new OfflibraryPlugin({ serveFromCache: false }).cachedResponseWillBeUsed).toBeUndefined();
    expect(new OfflibraryPlugin({ fallbackOnError: false }).handlerDidError).toBeUndefined();
  });

  it('sees items completed later once the index reloads', async () => {
    const strategy = new CacheOnly({ cacheName: 'media', plugins: [new OfflibraryPlugin()] });
    const request = new Request(OTHER);
    await expect(strategy.handle({ request, event: fetchEvent(request) })).rejects.toThrow();
    await store.putItem(item({ key: 'default/episodes/ep2', id: 'ep2', urls: [OTHER] }));
    await (await caches.open('offlibrary:default:episodes')).put(OTHER, new Response('second'));
    await _resetServe();
    expect(await (await strategy.handle({ request, event: fetchEvent(request) })).text()).toBe('second');
  });
});

describe('initOfflibrary', () => {
  it('handles Background Fetch events but adds no fetch listener', () => {
    const types: string[] = [];
    vi.stubGlobal('addEventListener', (type: string) => types.push(type));
    initOfflibrary();
    expect(types).not.toContain('fetch');
    expect(types).toEqual(expect.arrayContaining(['backgroundfetchsuccess', 'backgroundfetchfail', 'backgroundfetchabort', 'backgroundfetchclick']));
  });
});
