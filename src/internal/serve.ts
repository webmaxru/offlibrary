/**
 * Serving stored files from inside a service worker: the routing index (URL → cache), Range-aware
 * matching, and the "should this request be claimed?" rule. Shared by `offlibrary/sw` and
 * `offlibrary/workbox`, so both answer exactly the same requests the same way.
 */
import { isChannelMessage, openChannel } from './channel.js';
import { collectionDir, fileOf, readMeta } from './opfs.js';
import { createRangeResponse } from './range.js';
import { store } from './store.js';

interface IndexEntry {
  cacheName: string;
  key: string;
  /** Set for `storage: 'opfs'` items: where the file lives. */
  opfs?: { namespace: string; collection: string; file: string };
}

/** url → cache name for every stored file, kept in memory for synchronous fetch routing. */
let index: Map<string, IndexEntry> | undefined;
let indexLoad: Promise<void> | undefined;
let watching = false;
const touched = new Map<string, number>();

/** Request destinations claimed while the routing index is still loading after a worker start. */
export const COLD_START_DESTINATIONS: ReadonlySet<string> = new Set(['audio', 'video', 'track', 'image']);

export function loadIndex(): Promise<void> {
  indexLoad ??= store
    .listAll()
    .then((items) => {
      const next = new Map<string, IndexEntry>();
      for (const it of items) {
        // Items kept in memory (storage refused them) live in a page, not here.
        if (it.status !== 'completed' || it.storage === 'memory') continue;
        it.urls.forEach((url, i) => {
          const entry: IndexEntry = { cacheName: it.cacheName, key: it.key };
          if (it.storage === 'opfs' && it.files?.[i]) entry.opfs = { namespace: it.namespace, collection: it.collection, file: it.files[i]! };
          next.set(url, entry);
        });
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
      if (isChannelMessage(e.data) && e.data.kind !== 'progress') void loadIndex();
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
  let cached: Response | undefined;
  if (hit.opfs) {
    const dir = await collectionDir(hit.opfs.namespace, hit.opfs.collection, false).catch(() => undefined);
    const file = dir ? await fileOf(dir, hit.opfs.file) : undefined;
    if (!file) return undefined;
    const meta = await readMeta(dir!, hit.opfs.file);
    const headers = new Headers({ 'Content-Length': String(file.size) });
    const type = meta?.type ?? file.type;
    if (type) headers.set('Content-Type', type);
    if (meta?.etag) headers.set('ETag', meta.etag);
    cached = new Response(file, { status: 200, headers });
  } else {
    const cache = await caches.open(hit.cacheName);
    cached = await cache.match(url);
  }
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
