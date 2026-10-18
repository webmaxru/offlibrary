/**
 * Offlibrary service-worker module.
 *
 * ```js
 * // sw.js
 * import { offlibrarySW } from 'offlibrary/sw';
 * offlibrarySW();
 * ```
 * @packageDocumentation
 */
import { OfflibraryError, serializeError, toOfflibraryError } from './errors.js';
import type { OfflibraryErrorCode } from './errors.js';
import { broadcast, isChannelMessage, openChannel } from './internal/channel.js';
import { PREFIX, keyFromBgFetchId } from './internal/ids.js';
import { verifyIntegrity } from './internal/integrity.js';
import { createRangeResponse } from './internal/range.js';
import { store } from './internal/store.js';
import { toPublicItem } from './types.js';
import type { OfflibraryItem } from './types.js';

export { createRangeResponse, parseRange } from './internal/range.js';
export type { ByteRange } from './internal/range.js';
export { verifyIntegrity } from './internal/integrity.js';
export { OfflibraryError } from './errors.js';

// Minimal typings for the service-worker globals we touch (keeps the package free of lib conflicts).
interface ExtendableEventLike extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface BgFetchRecord {
  readonly request: Request;
  readonly responseReady: Promise<Response>;
}
interface BgFetchRegistrationLike extends EventTarget {
  readonly id: string;
  readonly downloaded: number;
  readonly failureReason: string;
  matchAll(): Promise<BgFetchRecord[]>;
}
/** The event object of `backgroundfetch*` service-worker events. */
export interface BackgroundFetchEventLike extends ExtendableEventLike {
  readonly type: string;
  readonly registration: BgFetchRegistrationLike;
  updateUI?(options: { title?: string; icons?: unknown[] }): Promise<void>;
}
interface FetchEventLike extends ExtendableEventLike {
  readonly request: Request;
  respondWith(r: Response | Promise<Response>): void;
}
interface WindowClientLike {
  readonly url: string;
  focus(): Promise<unknown>;
}
interface SWGlobal {
  addEventListener(type: string, listener: (e: Event) => void): void;
  location: { origin: string; href: string };
  registration: { scope: string };
  clients: {
    matchAll(o: { type: 'window'; includeUncontrolled: boolean }): Promise<WindowClientLike[]>;
    openWindow(url: string): Promise<unknown>;
  };
}

/** Options for {@link offlibrarySW}. */
export interface OfflibrarySWOptions {
  /**
   * Answer requests for stored files from the cache, with `Range` support (needed for
   * offline seeking in `<audio>`/`<video>`). Default `true`. Set `false` if you route requests
   * yourself (e.g. with Workbox) and call {@link matchOfflibrary} there.
   */
  serve?: boolean;
  /** Called after a Background Fetch item has been stored. */
  onComplete?: (item: OfflibraryItem, event: BackgroundFetchEventLike) => void | Promise<void>;
  /** Called after a Background Fetch item failed. */
  onFail?: (item: OfflibraryItem, event: BackgroundFetchEventLike) => void | Promise<void>;
  /** Called when the user taps the download notification. Return `true` to skip the default (focus/open the app). */
  onClick?: (item: OfflibraryItem | undefined, event: BackgroundFetchEventLike) => boolean | void | Promise<boolean | void>;
}

const sw = () => globalThis as unknown as SWGlobal;

/** url → cache name for every stored file, kept in memory for synchronous fetch routing. */
let index: Map<string, { cacheName: string; key: string }> | undefined;
let indexLoad: Promise<void> | undefined;
const touched = new Map<string, number>();

function loadIndex(): Promise<void> {
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

function stripHash(url: string): string {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}

/**
 * Find a stored file for a request and answer it, honouring `Range`. Resolves `undefined` when the
 * URL is not stored. Use this inside your own fetch routing (e.g. a Workbox route handler).
 */
export async function matchOfflibrary(request: Request): Promise<Response | undefined> {
  if (request.method !== 'GET') return undefined;
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

const failCode = (reason: string): OfflibraryErrorCode =>
  ({
    'bad-status': 'http-error',
    'fetch-error': 'network-error',
    'quota-exceeded': 'quota-exceeded',
    'download-total-exceeded': 'download-total-exceeded',
    aborted: 'aborted',
  } as Record<string, OfflibraryErrorCode>)[reason] ?? 'unknown';

async function updateUI(event: BackgroundFetchEventLike, title: string | undefined, icons?: unknown[]): Promise<void> {
  if (!event.updateUI || !title) return;
  await event.updateUI(icons?.length ? { title, icons } : { title }).catch(() => undefined);
}

/**
 * Handle one `backgroundfetch*` event if it belongs to Offlibrary. Returns `false` for foreign ids so you
 * can chain your own handling. Call `event.waitUntil(handleBackgroundFetchEvent(event))`, or use
 * {@link offlibrarySW} which wires this up for you.
 */
export async function handleBackgroundFetchEvent(event: BackgroundFetchEventLike, options: OfflibrarySWOptions = {}): Promise<boolean> {
  const key = keyFromBgFetchId(event.registration.id);
  if (key === undefined) return false;
  switch (event.type) {
    case 'backgroundfetchsuccess':
      await onSuccess(event, key, options);
      break;
    case 'backgroundfetchfail':
      await onFail(event, key, options);
      break;
    case 'backgroundfetchabort':
      await onAbort(key);
      break;
    case 'backgroundfetchclick':
      await onClick(event, key, options);
      break;
    default:
      return false;
  }
  return true;
}

async function onSuccess(event: BackgroundFetchEventLike, key: string, options: OfflibrarySWOptions): Promise<void> {
  const rec = await store.getItem(key);
  if (!rec) {
    // Deleted while downloading: nothing to store.
    await updateUI(event, 'Download finished');
    return;
  }
  try {
    const cache = await caches.open(rec.cacheName);
    const records = await event.registration.matchAll();
    let bytes = 0;
    const writes: [string, Response][] = [];
    for (const record of records) {
      const response = await record.responseReady;
      const url = record.request.url;
      if (!response || !(response.ok || response.status === 0)) {
        throw new OfflibraryError('http-error', `${url} responded ${response?.status}.`, { status: response?.status ?? 0 });
      }
      if (response.type === 'opaque' || response.status === 0) {
        throw new OfflibraryError('opaque-response', `${url} returned an opaque response. Cross-origin assets need CORS headers.`);
      }
      const i = rec.urls.indexOf(url);
      const integrity = i >= 0 ? rec.integrity?.[i] : undefined;
      if (!integrity) {
        // Stream straight into the cache: no need to hold large files in memory.
        bytes += Number(response.headers.get('Content-Length')) || 0;
        writes.push([url, response]);
        continue;
      }
      const blob = await response.blob();
      await verifyIntegrity(blob, integrity, url);
      bytes += blob.size;
      const headers = new Headers({ 'Content-Length': String(blob.size) });
      for (const h of ['Content-Type', 'ETag', 'Last-Modified']) {
        const v = response.headers.get(h);
        if (v) headers.set(h, v);
      }
      writes.push([url, new Response(blob, { status: 200, headers })]);
    }
    bytes = Math.max(bytes, event.registration.downloaded || 0);
    await Promise.all(writes.map(([url, res]) => cache.put(url, res)));
    const done = await store.updateItem(key, (r) => {
      r.status = 'completed';
      r.bytes = bytes;
      r.downloaded = bytes;
      r.total = bytes;
      r.completedAt = Date.now();
      r.lastAccessedAt = r.completedAt;
      delete r.error;
    });
    if (!done) {
      // Deleted while we were storing: undo.
      await Promise.all(writes.map(([url]) => cache.delete(url)));
      return;
    }
    if (index) for (const url of done.urls) index.set(url, { cacheName: done.cacheName, key });
    await updateUI(event, done.ui?.successTitle, done.ui?.icons);
    broadcast({ kind: 'complete', key });
    await options.onComplete?.(toPublicItem(done), event);
  } catch (err) {
    await markFailed(event, key, toOfflibraryError(err), options);
  }
}

async function markFailed(event: BackgroundFetchEventLike, key: string, error: OfflibraryError, options: OfflibrarySWOptions): Promise<void> {
  const rec = await store.updateItem(key, (r) => {
    r.status = 'failed';
    r.downloaded = event.registration.downloaded || r.downloaded;
    r.error = serializeError(error);
  });
  if (!rec) return;
  await updateUI(event, rec.ui?.failTitle, rec.ui?.icons);
  broadcast({ kind: 'fail', key });
  await options.onFail?.(toPublicItem(rec), event);
}

async function onFail(event: BackgroundFetchEventLike, key: string, options: OfflibrarySWOptions): Promise<void> {
  const reason = event.registration.failureReason || 'unknown';
  const code = failCode(reason);
  const message =
    code === 'download-total-exceeded'
      ? 'More bytes arrived than the declared size. Offlibrary retries once without a declared size.'
      : `Background Fetch failed (${reason}).`;
  await markFailed(event, key, new OfflibraryError(code, message), options);
}

async function onAbort(key: string): Promise<void> {
  const rec = await store.getItem(key);
  if (!rec) return; // the page already cleaned up (app-initiated cancel)
  await store.deleteItem(key);
  await store.deleteParts(key);
  broadcast({ kind: 'abort', key, item: rec });
}

async function onClick(event: BackgroundFetchEventLike, key: string, options: OfflibrarySWOptions): Promise<void> {
  const rec = await store.getItem(key);
  const item = rec ? toPublicItem(rec) : undefined;
  if ((await options.onClick?.(item, event)) === true) return;
  const self = sw();
  const scope = self.registration.scope;
  let target = scope;
  if (rec?.ui?.clickUrl) {
    try {
      const u = new URL(rec.ui.clickUrl, scope);
      if (u.origin === self.location.origin) target = u.href;
    } catch {
      // keep scope
    }
  }
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const existing = windows.find((c) => c.url.startsWith(scope));
  if (existing) {
    await existing.focus();
    broadcast({ kind: 'click', key });
  } else {
    await self.clients.openWindow(target);
  }
}

/**
 * Install Offlibrary's service-worker handlers: stores finished Background Fetches, updates the
 * download notification, reports to pages, and (by default) serves stored files with Range support.
 * Call it once at the top level of your service worker, before other `fetch` listeners.
 */
export function offlibrarySW(options: OfflibrarySWOptions = {}): void {
  const self = sw();
  for (const type of ['backgroundfetchsuccess', 'backgroundfetchfail', 'backgroundfetchabort', 'backgroundfetchclick']) {
    self.addEventListener(type, (e) => {
      const event = e as BackgroundFetchEventLike;
      if (keyFromBgFetchId(event.registration.id) === undefined) return;
      event.waitUntil(handleBackgroundFetchEvent(event, options).catch((err) => console.error('[offlibrary]', err)));
    });
  }

  // Keep the routing index fresh when pages complete/delete items.
  const channel = openChannel();
  if (channel) {
    channel.onmessage = (e: MessageEvent) => {
      if (isChannelMessage(e.data)) void loadIndex();
    };
  }
  void loadIndex();

  if (options.serve === false) return;
  self.addEventListener('fetch', (e) => {
    const event = e as FetchEventLike;
    const { request } = event;
    if (request.method !== 'GET' || request.mode === 'navigate') return;
    if (index) {
      if (!index.has(stripHash(request.url))) return;
    } else if (!COLD_START_DESTINATIONS.has(request.destination) && !request.headers.has('Range')) {
      // The worker just started and the index is still loading. Only claim requests that are
      // plausibly stored media; everything else stays with the app's own handlers (e.g. app shell).
      return;
    }
    event.respondWith(matchOfflibrary(request).then((r) => r ?? fetch(request)));
  });
}

/** Request destinations answered while the routing index is still loading after a worker start. */
const COLD_START_DESTINATIONS = new Set(['audio', 'video', 'track', 'image']);

/** @internal Exposed for tests. */
export const _internals = {
  reloadIndex: (): Promise<void> => {
    index = undefined;
    return loadIndex();
  },
  prefix: PREFIX,
};
