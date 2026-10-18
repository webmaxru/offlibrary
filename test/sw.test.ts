import { afterEach, describe, expect, it, vi } from 'vitest';
import { _internals, handleBackgroundFetchEvent, matchOfflibrary } from '../src/sw.js';
import { CHANNEL_NAME } from '../src/internal/channel.js';
import { store } from '../src/internal/store.js';
import type { StoredItem } from '../src/types.js';

const URL1 = 'https://app.test/media/ep1.mp3';

function item(over: Partial<StoredItem> = {}): StoredItem {
  return {
    key: 'default/episodes/ep1', scope: 'default/episodes', namespace: 'default', collection: 'episodes', id: 'ep1',
    urls: [URL1], status: 'downloading', strategy: 'background-fetch', downloaded: 0, total: 0, bytes: 0, attempts: 1,
    createdAt: 1, updatedAt: 1, cacheName: 'offlibrary:default:episodes',
    ui: { successTitle: 'ep1 ready', failTitle: 'ep1 failed', clickUrl: 'https://app.test/#ep1' },
    ...over,
  };
}

function bgEvent(type: string, records: [string, Response][] = [], extra: Record<string, unknown> = {}) {
  return {
    type,
    waitUntil: () => {},
    updateUI: vi.fn(async () => {}),
    registration: {
      id: 'offlibrary:default/episodes/ep1',
      downloaded: 123,
      failureReason: 'fetch-error',
      matchAll: async () => records.map(([u, r]) => ({ request: new Request(u), responseReady: Promise.resolve(r) })),
      ...extra,
    },
  } as never;
}

afterEach(() => vi.unstubAllGlobals());

describe('service worker', () => {
  it('ignores Background Fetches it does not own', async () => {
    const e = bgEvent('backgroundfetchsuccess', [], { id: 'someone-else' });
    expect(await handleBackgroundFetchEvent(e)).toBe(false);
  });

  it('stores records, updates metadata and the notification, and broadcasts', async () => {
    await store.putItem(item());
    const channel = new BroadcastChannel(CHANNEL_NAME);
    const messages: unknown[] = [];
    channel.onmessage = (m) => messages.push(m.data);
    const onComplete = vi.fn();
    const e = bgEvent('backgroundfetchsuccess', [[URL1, new Response('hello audio', { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '11' } })]]);
    expect(await handleBackgroundFetchEvent(e, { onComplete })).toBe(true);
    const rec = await store.getItem('default/episodes/ep1');
    expect(rec).toMatchObject({ status: 'completed', bytes: 123 });
    expect(await (await (await caches.open('offlibrary:default:episodes')).match(URL1))!.text()).toBe('hello audio');
    expect((e as { updateUI: ReturnType<typeof vi.fn> }).updateUI).toHaveBeenCalledWith({ title: 'ep1 ready' });
    expect(onComplete).toHaveBeenCalledOnce();
    await new Promise((r) => setTimeout(r, 10));
    expect(messages).toContainEqual(expect.objectContaining({ kind: 'complete', key: 'default/episodes/ep1' }));
    channel.close();
  });

  it('fails the item when a record has a bad status', async () => {
    await store.putItem(item());
    await handleBackgroundFetchEvent(bgEvent('backgroundfetchsuccess', [[URL1, new Response('nope', { status: 404 })]]));
    expect(await store.getItem('default/episodes/ep1')).toMatchObject({ status: 'failed', error: { code: 'http-error', status: 404 } });
  });

  it('maps browser failure reasons', async () => {
    await store.putItem(item());
    const e = bgEvent('backgroundfetchfail');
    await handleBackgroundFetchEvent(e);
    expect(await store.getItem('default/episodes/ep1')).toMatchObject({ status: 'failed', error: { code: 'network-error' } });
    expect((e as { updateUI: ReturnType<typeof vi.fn> }).updateUI).toHaveBeenCalledWith({ title: 'ep1 failed' });
  });

  it('forgets items cancelled from the browser UI', async () => {
    await store.putItem(item());
    await handleBackgroundFetchEvent(bgEvent('backgroundfetchabort'));
    expect(await store.getItem('default/episodes/ep1')).toBeUndefined();
  });

  it('opens the same-origin clickUrl when no window is open', async () => {
    await store.putItem(item());
    const openWindow = vi.fn(async () => {});
    vi.stubGlobal('location', { origin: 'https://app.test', href: 'https://app.test/sw.js' });
    vi.stubGlobal('registration', { scope: 'https://app.test/' });
    vi.stubGlobal('clients', { matchAll: async () => [], openWindow });
    await handleBackgroundFetchEvent(bgEvent('backgroundfetchclick'));
    expect(openWindow).toHaveBeenCalledWith('https://app.test/#ep1');
  });

  it('never opens a cross-origin clickUrl', async () => {
    await store.putItem(item({ ui: { clickUrl: 'https://evil.test/' } }));
    const openWindow = vi.fn(async () => {});
    vi.stubGlobal('location', { origin: 'https://app.test', href: 'https://app.test/sw.js' });
    vi.stubGlobal('registration', { scope: 'https://app.test/' });
    vi.stubGlobal('clients', { matchAll: async () => [], openWindow });
    await handleBackgroundFetchEvent(bgEvent('backgroundfetchclick'));
    expect(openWindow).toHaveBeenCalledWith('https://app.test/');
  });

  it('serves stored files with Range support via matchOfflibrary()', async () => {
    await store.putItem(item({ status: 'completed' }));
    await (await caches.open('offlibrary:default:episodes')).put(URL1, new Response('0123456789', { headers: { 'Content-Type': 'audio/mpeg' } }));
    await _internals.reloadIndex();
    const full = await matchOfflibrary(new Request(URL1));
    expect(await full!.text()).toBe('0123456789');
    const part = await matchOfflibrary(new Request(URL1, { headers: { Range: 'bytes=2-4' } }));
    expect(part!.status).toBe(206);
    expect(await part!.text()).toBe('234');
    expect(await matchOfflibrary(new Request('https://app.test/other.mp3'))).toBeUndefined();
    expect(await matchOfflibrary(new Request(URL1, { method: 'POST', body: 'x' }))).toBeUndefined();
  });
});
