/**
 * Serving stored files from inside a service worker: the routing index (URL → cache), Range-aware
 * matching, and the "should this request be claimed?" rule. Shared by `offlibrary/sw` and
 * `offlibrary/workbox`, so both answer exactly the same requests the same way.
 */
import { isChannelMessage, openChannel } from './channel.js';
import { createRangeResponse } from './range.js';
import { store } from './store.js';

/** url → cache name for every stored file, kept in memory for synchronous fetch routing. */
let index: Map<string, { cacheName: string; key: string }> | undefined;
let indexLoad: Promise<void> | undefined;
let watching = false;
const touched = new Map<string, number>();

/** Request destinations claimed while the routing index is still loading after a worker start. */
export const COLD_START_DESTINATIONS: ReadonlySet<string> = new Set(['audio', 'video', 'track', 'image']);

export function loadIndex(): Promise<void> {
  indexLoad ??= store
    .listAll()
    .then((items) => {
      const next = new Map<string, { cacheName: string; key: string }>();
      for (const it of items) {
        if (it.status !== 'completed') continue;
        for (const url of it.urls) next.set(url, { cacheName: it.cacheName, key: it.key });
      }
      index = next;
    })
    .catch(() => {
      index ??= new Map();
    })
    .finally(() => {
      indexLoad = undefined;
    });
  return indexLoad;
}

/**
 * Start loading the index and keep it fresh: pages announce completed and deleted items on the
 * BroadcastChannel, and every announcement reloads it. Idempotent.
 */
export function watchIndex(): void {
  if (watching) return;
  watching = true;
  const channel = openChannel();
  if (channel) {
    channel.onmessage = (e: MessageEvent) => {
      if (isChannelMessage(e.data)) void loadIndex();
    };
  }
  void loadIndex();
}

/** Record a freshly stored item without waiting for the next index reload. */
export function indexItem(urls: readonly string[], cacheName: string, key: string): void {
  if (index) for (const url of urls) index.set(url, { cacheName, key });
}

export function stripHash(url: string): string {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}

/**
 * Synchronous routing decision: `true` when the request is for a stored file. While the index is
 * still loading (the worker just started), media destinations and `Range` requests are claimed too,
 * so the first offline play after a worker wake-up still works; {@link matchOfflibrary} then decides.
 */
export function isOfflibraryRequest(request: Request): boolean {
  watchIndex();
  if (request.method !== 'GET' || request.mode === 'navigate') return false;
  if (index) return index.has(stripHash(request.url));
  return COLD_START_DESTINATIONS.has(request.destination) || request.headers.has('Range');
}

/**
 * Find a stored file for a request and answer it, honouring `Range` (`206 Partial Content`).
 * Resolves `undefined` when the URL is not stored, so the caller can fall through to the network.
 */
export async function matchOfflibrary(request: Request): Promise<Response | undefined> {
  if (request.method !== 'GET') return undefined;
  watchIndex();
  if (!index) await loadIndex();
  const url = stripHash(request.url);
  const hit = index!.get(url);
  if (!hit) return undefined;
  const cache = await caches.open(hit.cacheName);
  const cached = await cache.match(url);
  if (!cached) return undefined;
  touch(hit.key);
  return createRangeResponse(cached, request.headers.get('Range'));
}

function touch(key: string): void {
  const t = Date.now();
  if (t - (touched.get(key) ?? 0) < 60_000) return;
  touched.set(key, t);
  void store.updateItem(key, (r) => {
    r.lastAccessedAt = t;
  }).catch(() => undefined);
}

/** @internal Tests only. */
export function _resetServe(): Promise<void> {
  index = undefined;
  return loadIndex();
}
