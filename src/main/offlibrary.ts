import { resolveConfig, validateItem } from '../config.js';
import type { ItemDescriptor, OfflibraryConfig, ResolvedCollectionConfig, ResolvedConfig } from '../config.js';
import { OfflibraryError, serializeError, toOfflibraryError } from '../errors.js';
import { broadcast, isChannelMessage, openChannel } from '../internal/channel.js';
import type { ChannelMessage, UpdateKind } from '../internal/channel.js';
import { bgFetchIdOf, cacheNameOf, itemKey, scopeOf } from '../internal/ids.js';
import { store } from '../internal/store.js';
import { absoluteUrl, now } from '../internal/util.js';
import { toPublicItem } from '../types.js';
import type { ItemInput, OfflibraryItem, StoredItem } from '../types.js';
import { runFetchDownload } from './fetch-transport.js';
import { Collection } from './collection.js';

/** Why an item was evicted. */
export type EvictReason = 'max-items' | 'max-bytes' | 'quota';

/** Event details, by event type. */
export interface OfflibraryEventMap {
  /** Anything changed (fires after every other event, and for status changes without one). */
  change: { item: OfflibraryItem; type: 'start' | 'progress' | 'pause' | 'resume' | 'update' | Exclude<keyof OfflibraryEventMap, 'change'> };
  /** Bytes arrived (throttled by `progressInterval`). */
  progress: { item: OfflibraryItem };
  /** The item is fully stored and available offline. */
  complete: { item: OfflibraryItem };
  /** The download failed. `item.status` is `'failed'`; call `retry()` to try again. */
  error: { item: OfflibraryItem; error: OfflibraryError };
  /** The download was cancelled (by the app or from the browser's download UI). The item is gone. */
  abort: { item: OfflibraryItem };
  /** The item was deleted. */
  delete: { item: OfflibraryItem };
  /** The item was removed to respect limits or free space. */
  evict: { item: OfflibraryItem; reason: EvictReason };
  /** The user tapped the Background Fetch notification for this item. */
  click: { item: OfflibraryItem };
}

/** Typed event listener. */
export type OfflibraryListener<K extends keyof OfflibraryEventMap> = (detail: OfflibraryEventMap[K]) => void;

/** Feature detection results. */
export interface OfflibraryCapabilities {
  serviceWorker: boolean;
  backgroundFetch: boolean;
  cacheStorage: boolean;
  indexedDB: boolean;
  storageEstimate: boolean;
  storagePersist: boolean;
  webLocks: boolean;
}

/** Storage numbers from `navigator.storage.estimate()`. */
export interface StorageEstimate {
  /** Bytes used by the whole origin. */
  usage: number;
  /** Bytes the origin may use. */
  quota: number;
  /** `quota - usage`. */
  available: number;
  /** Whether the numbers came from the browser (false: unsupported, all zero). */
  supported: boolean;
}

interface BgFetchRegistration extends EventTarget {
  readonly id: string;
  readonly downloaded: number;
  readonly downloadTotal: number;
  readonly result: '' | 'success' | 'failure';
  readonly failureReason: string;
  abort(): Promise<boolean>;
}
interface BgFetchManager {
  fetch(id: string, requests: RequestInfo[], options?: { title?: string; icons?: unknown[]; downloadTotal?: number }): Promise<BgFetchRegistration>;
  get(id: string): Promise<BgFetchRegistration | undefined>;
  getIds(): Promise<string[]>;
}
interface ActiveDownload {
  controller?: AbortController;
  reg?: BgFetchRegistration;
  run?: Promise<void>;
  intent?: 'pause' | 'cancel';
  detach?: () => void;
}

const nav = (): Navigator | undefined => (typeof navigator === 'undefined' ? undefined : navigator);

/** Run `fn` while holding a Web Lock for `name` (shared across tabs). Returns `'busy'` if another context holds it. */
async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T | 'busy'> {
  const locks = nav()?.locks;
  if (!locks) return fn();
  return locks.request(name, { ifAvailable: true }, async (lock) => (lock ? fn() : 'busy')) as Promise<T | 'busy'>;
}

async function lockHeld(name: string): Promise<boolean> {
  const locks = nav()?.locks;
  if (!locks?.query) return false;
  const state = await locks.query();
  return !!state.held?.some((l) => l.name === name);
}

/**
 * Offline asset manager. Create one per app with {@link createOfflibrary}.
 *
 * ```ts
 * const library = createOfflibrary({ collections: { episodes: {} } });
 * const episodes = library.collection('episodes');
 * await episodes.download({ id: 'ep-1', url: '/media/ep-1.mp3', title: 'Episode 1' });
 * ```
 */
export class Offlibrary extends EventTarget {
  /** Namespace this instance works in. */
  readonly namespace: string;
  /** Resolves when metadata is loaded and in-flight downloads are re-attached. */
  readonly ready: Promise<void>;
  /** What this browser supports. */
  readonly capabilities: OfflibraryCapabilities;
  /** Storage quota and persistence helpers. */
  readonly storage: {
    estimate(): Promise<StorageEstimate>;
    persist(): Promise<boolean>;
    persisted(): Promise<boolean>;
  };

  readonly #config: ResolvedConfig;
  readonly #collections = new Map<string, Collection>();
  readonly #items = new Map<string, StoredItem>();
  readonly #snapshots = new Map<string, readonly OfflibraryItem[]>();
  readonly #active = new Map<string, ActiveDownload>();
  readonly #lastProgress = new Map<string, number>();
  readonly #starting = new Map<string, Promise<OfflibraryItem>>();
  #channel: BroadcastChannel | undefined;
  #registration: Promise<ServiceWorkerRegistration | undefined> | undefined;
  #persistAsked = false;
  #onVisible = () => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') void this.refresh();
  };

  constructor(config: OfflibraryConfig) {
    super();
    this.#config = resolveConfig(config);
    this.namespace = this.#config.namespace;
    const n = nav();
    const g = globalThis as Record<string, unknown>;
    this.capabilities = {
      serviceWorker: !!n && 'serviceWorker' in n,
      backgroundFetch: typeof g.BackgroundFetchManager === 'function',
      cacheStorage: typeof caches !== 'undefined',
      indexedDB: typeof indexedDB !== 'undefined',
      storageEstimate: !!n?.storage?.estimate,
      storagePersist: !!n?.storage?.persist,
      webLocks: !!n?.locks,
    };
    this.storage = {
      estimate: async () => {
        const est = n?.storage?.estimate ? await n.storage.estimate() : undefined;
        const usage = est?.usage ?? 0;
        const quota = est?.quota ?? 0;
        return { usage, quota, available: Math.max(0, quota - usage), supported: !!est };
      },
      persist: async () => (n?.storage?.persist ? n.storage.persist() : false),
      persisted: async () => (n?.storage?.persisted ? n.storage.persisted() : false),
    };
    for (const name of Object.keys(this.#config.collections)) {
      this.#collections.set(name, new Collection(this, name));
    }
    this.ready = this.#init();
    this.ready.catch(() => undefined);
  }

  /** Names of the configured collections. */
  get collectionNames(): string[] {
    return [...this.#collections.keys()];
  }

  /** Get a configured collection. Throws `unknown-collection` for names not in the config. */
  collection<M = unknown>(name: string): Collection<M> {
    const c = this.#collections.get(name);
    if (!c) throw new OfflibraryError('unknown-collection', `Unknown collection "${name}". Configured: ${this.collectionNames.join(', ')}.`);
    return c as Collection<M>;
  }

  /** Listen to a typed event. Returns an unsubscribe function. */
  on<K extends keyof OfflibraryEventMap>(type: K, listener: OfflibraryListener<K>): () => void {
    const handler = (e: Event) => listener((e as CustomEvent<OfflibraryEventMap[K]>).detail);
    this.addEventListener(type, handler);
    return () => this.removeEventListener(type, handler);
  }

  /** Call `listener` on every change in any collection. Shaped for `useSyncExternalStore` and framework stores. */
  subscribe(listener: (detail: OfflibraryEventMap['change']) => void): () => void {
    return this.on('change', listener);
  }

  /** Re-read all metadata from IndexedDB (done automatically when the page becomes visible). */
  async refresh(): Promise<void> {
    const prefix = `${this.namespace}/`;
    const fresh = (await store.listAll()).filter((r) => r.key.startsWith(prefix));
    const seen = new Set<string>();
    for (const rec of fresh) {
      seen.add(rec.key);
      const prev = this.#items.get(rec.key);
      if (prev && prev.updatedAt >= rec.updatedAt) continue;
      if (prev && rec.status === 'downloading' && prev.status === 'downloading') {
        rec.downloaded = Math.max(rec.downloaded, prev.downloaded);
      }
      this._set(rec);
      if (prev?.status !== rec.status) {
        if (rec.status === 'completed') this._emit('complete', { item: toPublicItem(rec) });
        else if (rec.status === 'failed') this._emit('error', { item: toPublicItem(rec), error: this.#errorOf(rec) });
        else this._emit('change', { item: toPublicItem(rec), type: 'update' });
      }
    }
    for (const [key, rec] of this.#items) {
      if (!seen.has(key)) {
        this._forget(key);
        this._emit('delete', { item: toPublicItem(rec) });
      }
    }
  }

  /** Stop listening for cross-tab updates and pause running fetch downloads (they resume on next start). */
  destroy(): void {
    this.#channel?.close();
    this.#channel = undefined;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.#onVisible);
    for (const entry of this.#active.values()) {
      entry.detach?.();
      if (entry.controller) {
        entry.intent = 'pause';
        entry.controller.abort(new DOMException('Offlibrary destroyed', 'AbortError'));
      }
    }
  }

  // ---------------------------------------------------------------- internals used by Collection

  /** @internal */
  _collectionConfig(name: string): ResolvedCollectionConfig {
    return this.#config.collections[name]!;
  }

  /** @internal */
  _key(collection: string, id: string): string {
    return itemKey(this.namespace, collection, id);
  }

  /** @internal */
  _peek(key: string): StoredItem | undefined {
    return this.#items.get(key);
  }

  /** @internal */
  _snapshot(collection: string): readonly OfflibraryItem[] {
    let snap = this.#snapshots.get(collection);
    if (!snap) {
      const scope = scopeOf(this.namespace, collection);
      snap = Object.freeze(
        [...this.#items.values()].filter((r) => r.scope === scope).sort((a, b) => a.createdAt - b.createdAt).map((r) => toPublicItem(r)),
      );
      this.#snapshots.set(collection, snap);
    }
    return snap;
  }

  /** @internal */
  _emit<K extends keyof OfflibraryEventMap>(type: K, detail: OfflibraryEventMap[K]): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
    if (type !== 'change') {
      this.dispatchEvent(new CustomEvent('change', { detail: { item: detail.item, type } }));
    }
  }

  /** @internal */
  _set(rec: StoredItem): void {
    this.#items.set(rec.key, rec);
    this.#snapshots.delete(rec.collection);
  }

  /** @internal */
  _forget(key: string): void {
    const rec = this.#items.get(key);
    this.#items.delete(key);
    this.#lastProgress.delete(key);
    if (rec) this.#snapshots.delete(rec.collection);
  }

  /** @internal */
  async _write(rec: StoredItem): Promise<StoredItem> {
    rec.updatedAt = Math.max(now(), (this.#items.get(rec.key)?.updatedAt ?? 0) + 1);
    await store.putItem(rec);
    this._set(rec);
    return rec;
  }

  /** @internal */
  async _patch(key: string, patch: (rec: StoredItem) => void): Promise<StoredItem | undefined> {
    const mem = this.#items.get(key);
    const rec = await store.updateItem(key, (r) => {
      // Carry over live progress that only lives in memory, then apply the patch.
      if (mem && mem.status === 'downloading' && r.status === 'downloading') {
        r.downloaded = Math.max(r.downloaded, mem.downloaded);
        if (mem.total > r.total) r.total = mem.total;
      }
      patch(r);
    });
    if (rec) this._set(rec);
    else this._forget(key);
    return rec;
  }

  /** @internal */
  async _download(collection: string, input: ItemInput): Promise<OfflibraryItem> {
    await this.ready;
    const urls = validateItem(input, absoluteUrl);
    const key = this._key(collection, input.id);
    const pending = this.#starting.get(key);
    if (pending) return pending;
    const run = this.#startDownload(collection, input, urls, key).finally(() => this.#starting.delete(key));
    this.#starting.set(key, run);
    return run;
  }

  async #startDownload(collection: string, input: ItemInput, urls: string[], key: string): Promise<OfflibraryItem> {
    const cfg = this._collectionConfig(collection);
    const existing = this.#items.get(key);
    const sameContent = existing && existing.version === input.version && existing.urls.join('\n') === urls.join('\n');
    if (existing && sameContent) {
      if (existing.status === 'completed') return this._touch(key);
      if (existing.status === 'downloading') return toPublicItem(existing);
      return this._resume(key);
    }
    if (existing?.status === 'downloading') await this._cancel(key, true);

    let size = input.size ?? 0;
    if (input.size === undefined && cfg.autoSize) size = await this.#measure(urls, cfg);

    const wantsBg = cfg.strategy !== 'fetch' && (cfg.strategy === 'background-fetch' || size === 0 || size >= cfg.backgroundFetchThreshold);
    const manager = wantsBg ? await this.#manager() : undefined;

    await this.#makeRoom(collection, cfg, size, key);
    if (this.#config.persist === 'on-download') this.#askPersist();

    const descriptor: ItemDescriptor = { id: input.id, urls };
    if (input.title !== undefined) descriptor.title = input.title;
    if (input.meta !== undefined) descriptor.meta = input.meta;
    const label = input.title ?? input.id;
    const clickUrl = typeof cfg.clickUrl === 'function' ? cfg.clickUrl(descriptor) : cfg.clickUrl;
    const icons = input.icons ?? cfg.ui?.icons;
    const integrity = input.integrity === undefined ? undefined : typeof input.integrity === 'string' ? [input.integrity] : input.integrity.slice();

    const rec: StoredItem = {
      key,
      scope: scopeOf(this.namespace, collection),
      namespace: this.namespace,
      collection,
      id: input.id,
      urls,
      status: 'downloading',
      strategy: manager ? 'background-fetch' : 'fetch',
      downloaded: 0,
      total: size,
      bytes: 0,
      attempts: 1,
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
      cacheName: cacheNameOf(this.namespace, collection),
      ui: {
        title: cfg.ui?.title?.(descriptor) ?? label,
        successTitle: cfg.ui?.successTitle?.(descriptor) ?? `${label} is ready offline`,
        failTitle: cfg.ui?.failTitle?.(descriptor) ?? `${label} failed to download`,
        ...(icons ? { icons } : {}),
        ...(clickUrl ? { clickUrl: absoluteUrl(clickUrl) } : {}),
      },
    };
    if (input.title !== undefined) rec.title = input.title;
    if (input.meta !== undefined) rec.meta = input.meta;
    if (input.version !== undefined) rec.version = input.version;
    if (integrity) rec.integrity = integrity;
    if (input.pinned) rec.pinned = true;

    await store.deleteParts(key);
    await this._write(rec);
    this._emit('change', { item: toPublicItem(rec), type: 'start' });
    await this.#start(rec, manager);
    return toPublicItem(this.#items.get(key) ?? rec);
  }

  async #start(rec: StoredItem, manager?: BgFetchManager): Promise<void> {
    if (rec.strategy === 'background-fetch') {
      try {
        const mgr = manager ?? (await this.#manager());
        if (!mgr) throw new TypeError('Background Fetch is not available.');
        const id = bgFetchIdOf(rec.key);
        let reg = await mgr.get(id);
        if (!reg) {
          const init = this._collectionConfig(rec.collection).requestInit;
          const requests = rec.urls.map(
            (u) => new Request(u, { credentials: 'same-origin', ...init, mode: 'cors' }),
          );
          reg = await mgr.fetch(id, requests, {
            title: rec.ui?.title ?? rec.title ?? rec.id,
            icons: rec.ui?.icons ?? [],
            downloadTotal: rec.total,
          });
        }
        this.#attach(rec.key, reg);
        return;
      } catch (err) {
        const e = toOfflibraryError(err);
        if (e.code === 'quota-exceeded') {
          await this.#fail(rec.key, e);
          return;
        }
        // Any other refusal (no active worker, permission, policy): use the fetch transport instead.
        const updated = await this._patch(rec.key, (r) => {
          r.strategy = 'fetch';
        });
        if (!updated) return;
        rec = updated;
      }
    }
    this.#runFetch(rec);
  }

  #attach(key: string, reg: BgFetchRegistration): void {
    this.#active.get(key)?.detach?.();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const onProgress = () => {
      const rec = this.#items.get(key);
      if (!rec || rec.status !== 'downloading') return;
      rec.downloaded = reg.downloaded;
      if (reg.downloadTotal) rec.total = reg.downloadTotal;
      this.#progress(rec);
      if (reg.result && !watchdog) {
        // The service worker should report back. If nothing arrives, the SW module is probably missing.
        watchdog = setTimeout(async () => {
          await this.refresh().catch(() => undefined);
          if (this.#items.get(key)?.status === 'downloading') {
            console.warn(
              `[offlibrary] Background Fetch for "${key}" finished but no service worker stored it. ` +
                `Did you call offlibrarySW() in your service worker?`,
            );
          }
        }, 30_000);
      }
    };
    reg.addEventListener('progress', onProgress);
    const detach = () => {
      reg.removeEventListener('progress', onProgress);
      if (watchdog) clearTimeout(watchdog);
    };
    this.#active.set(key, { reg, detach });
    onProgress();
  }

  #runFetch(rec: StoredItem): void {
    const key = rec.key;
    const cfg = this._collectionConfig(rec.collection);
    const controller = new AbortController();
    const entry: ActiveDownload = { controller };
    this.#active.get(key)?.detach?.();
    this.#active.set(key, entry);
    entry.run = (async () => {
      const outcome = await withLock(`offlibrary:${key}`, async () => {
        try {
          const job: Parameters<typeof runFetchDownload>[0] = {
            key,
            urls: rec.urls,
            cacheName: rec.cacheName,
            resumable: cfg.resumable,
            retries: cfg.retries,
            retryDelay: cfg.retryDelay,
            signal: controller.signal,
            total: rec.total,
            onProgress: (downloaded, total) => {
              const live = this.#items.get(key);
              if (!live || live.status !== 'downloading') return;
              live.downloaded = downloaded;
              if (total) live.total = total;
              this.#progress(live);
            },
          };
          if (rec.integrity) job.integrity = rec.integrity;
          if (cfg.requestInit) job.requestInit = cfg.requestInit;
          const { bytes } = await runFetchDownload(job);
          await this.#complete(key, bytes);
        } catch (err) {
          if (entry.intent === 'pause') {
            const r = await this._patch(key, (x) => {
              x.status = 'paused';
            });
            if (r) this._emit('change', { item: toPublicItem(r), type: 'pause' });
          } else if (entry.intent !== 'cancel') {
            await this.#fail(key, err);
          }
        }
      });
      if (outcome === 'busy') {
        // Another tab is downloading this item; it will broadcast the result.
      }
      if (this.#active.get(key) === entry) this.#active.delete(key);
    })();
  }

  #progress(rec: StoredItem): void {
    const t = now();
    const last = this.#lastProgress.get(rec.key) ?? 0;
    const final = rec.total > 0 && rec.downloaded >= rec.total;
    if (!final && t - last < this.#config.progressInterval) return;
    this.#lastProgress.set(rec.key, t);
    this.#snapshots.delete(rec.collection);
    this._emit('progress', { item: toPublicItem(rec) });
  }

  async #complete(key: string, bytes: number): Promise<void> {
    const rec = await this._patch(key, (r) => {
      r.status = 'completed';
      r.bytes = bytes;
      r.downloaded = bytes;
      r.total = bytes;
      r.completedAt = now();
      r.lastAccessedAt = r.completedAt;
      delete r.error;
    });
    if (!rec) return;
    this._emit('complete', { item: toPublicItem(rec) });
    this.#post({ kind: 'complete', key });
    await this.#enforceLimits(rec.collection, key);
  }

  async #fail(key: string, err: unknown): Promise<void> {
    const error = toOfflibraryError(err);
    const rec = await this._patch(key, (r) => {
      r.status = 'failed';
      r.error = serializeError(error);
    });
    if (!rec) return;
    this._emit('error', { item: toPublicItem(rec), error });
    this.#post({ kind: 'fail', key });
  }

  #errorOf(rec: StoredItem): OfflibraryError {
    const e = rec.error;
    return new OfflibraryError(e?.code ?? 'unknown', e?.message ?? 'Download failed.', e?.status !== undefined ? { status: e.status } : {});
  }

  /** @internal */
  async _touch(key: string): Promise<OfflibraryItem> {
    const rec = await this._patch(key, (r) => {
      r.lastAccessedAt = now();
    });
    if (!rec) throw new OfflibraryError('not-found', `No item "${key}".`);
    return toPublicItem(rec);
  }

  /** @internal */
  async _pause(key: string): Promise<OfflibraryItem> {
    await this.ready;
    const rec = this.#require(key);
    if (rec.status !== 'downloading') return toPublicItem(rec);
    if (rec.strategy === 'background-fetch') {
      throw new OfflibraryError('not-supported', 'Background Fetch downloads cannot be paused (the browser pauses them itself when offline). Use cancel() instead.');
    }
    const entry = this.#active.get(key);
    if (entry?.controller) {
      entry.intent = 'pause';
      entry.controller.abort(new DOMException('Paused', 'AbortError'));
      await entry.run;
    } else {
      const r = await this._patch(key, (x) => {
        x.status = 'paused';
      });
      if (r) this._emit('change', { item: toPublicItem(r), type: 'pause' });
    }
    return toPublicItem(this.#require(key));
  }

  /** @internal */
  async _resume(key: string): Promise<OfflibraryItem> {
    await this.ready;
    const rec = this.#require(key);
    if (rec.status === 'completed' || (rec.status === 'downloading' && this.#active.has(key))) return toPublicItem(rec);
    if (await lockHeld(`offlibrary:${key}`)) return toPublicItem(rec);
    const next = await this._patch(key, (r) => {
      r.status = 'downloading';
      r.attempts += 1;
      delete r.error;
    });
    if (!next) throw new OfflibraryError('not-found', `No item "${key}".`);
    this._emit('change', { item: toPublicItem(next), type: 'resume' });
    await this.#start(next);
    return toPublicItem(this.#items.get(key) ?? next);
  }

  /** @internal Cancel a running download and forget the item. */
  async _cancel(key: string, silent = false): Promise<void> {
    await this.ready;
    const rec = this.#items.get(key);
    if (!rec) return;
    const entry = this.#active.get(key);
    if (rec.strategy === 'background-fetch' && rec.status === 'downloading') {
      const reg = entry?.reg ?? (await (await this.#manager())?.get(bgFetchIdOf(key)));
      entry?.detach?.();
      await reg?.abort().catch(() => false);
    } else if (entry?.controller) {
      entry.intent = 'cancel';
      entry.controller.abort(new DOMException('Cancelled', 'AbortError'));
      await entry.run;
    }
    this.#active.delete(key);
    await this.#remove(rec);
    if (!silent) {
      this._emit('abort', { item: toPublicItem(rec) });
      this.#post({ kind: 'abort', key, item: rec });
    }
  }

  /** @internal */
  async _delete(key: string): Promise<boolean> {
    await this.ready;
    const rec = this.#items.get(key) ?? (await store.getItem(key));
    if (!rec) return false;
    if (rec.status === 'downloading') {
      await this._cancel(key, true);
    } else {
      await this.#remove(rec);
    }
    this._emit('delete', { item: toPublicItem(rec) });
    this.#post({ kind: 'delete', key, item: rec });
    return true;
  }

  /** @internal */
  async _evict(rec: StoredItem, reason: EvictReason): Promise<void> {
    await this.#remove(rec);
    this._emit('evict', { item: toPublicItem(rec), reason });
    this.#post({ kind: 'evict', key: rec.key, item: rec, reason });
  }

  async #remove(rec: StoredItem): Promise<void> {
    this._forget(rec.key);
    await store.deleteItem(rec.key);
    await store.deleteParts(rec.key);
    if (typeof caches !== 'undefined') {
      const cache = await caches.open(rec.cacheName);
      const shared = new Set(
        [...this.#items.values()].filter((r) => r.cacheName === rec.cacheName).flatMap((r) => r.urls),
      );
      await Promise.all(rec.urls.filter((u) => !shared.has(u)).map((u) => cache.delete(u)));
    }
  }

  #require(key: string): StoredItem {
    const rec = this.#items.get(key);
    if (!rec) throw new OfflibraryError('not-found', `No item "${key.split('/').slice(2).join('/')}" in collection "${key.split('/')[1]}".`);
    return rec;
  }

  /** Free space for an incoming item: per-collection limits, then origin quota. */
  async #makeRoom(collection: string, cfg: ResolvedCollectionConfig, size: number, key: string): Promise<void> {
    const scope = scopeOf(this.namespace, collection);
    if (cfg.maxBytes !== undefined && size > cfg.maxBytes) {
      throw new OfflibraryError('limit-exceeded', `Item is larger than "${collection}" maxBytes (${size} > ${cfg.maxBytes}).`);
    }
    const others = () => [...this.#items.values()].filter((r) => r.scope === scope && r.key !== key);
    const evictable = () =>
      others()
        .filter((r) => r.status === 'completed' && !r.pinned)
        .sort((a, b) => (a.lastAccessedAt ?? a.completedAt ?? 0) - (b.lastAccessedAt ?? b.completedAt ?? 0));
    const evictOne = async (reason: EvictReason, what: string) => {
      const victim = evictable()[0];
      if (!victim || cfg.evict === 'none') {
        throw new OfflibraryError(reason === 'quota' ? 'quota-exceeded' : 'limit-exceeded', `No room in "${collection}": ${what}.`);
      }
      await this._evict(victim, reason);
      return victim.bytes;
    };
    if (cfg.maxItems !== undefined) {
      while (others().filter((r) => r.status !== 'failed').length + 1 > cfg.maxItems) {
        await evictOne('max-items', `maxItems is ${cfg.maxItems}`);
      }
    }
    if (cfg.maxBytes !== undefined) {
      const used = () => others().reduce((s, r) => s + (r.status === 'completed' ? r.bytes : r.total), 0);
      while (used() + size > cfg.maxBytes) await evictOne('max-bytes', `maxBytes is ${cfg.maxBytes}`);
    }
    if (size > 0) {
      const est = await this.storage.estimate();
      if (est.supported) {
        let missing = size - est.available;
        while (missing > 0) missing -= await evictOne('quota', `needs ${size} bytes, ${est.available} available`);
      }
    }
  }

  async #enforceLimits(collection: string, keep: string): Promise<void> {
    const cfg = this._collectionConfig(collection);
    if ((cfg.maxItems === undefined && cfg.maxBytes === undefined) || cfg.evict === 'none') return;
    const scope = scopeOf(this.namespace, collection);
    await withLock(`offlibrary:limits:${scope}`, async () => {
      for (;;) {
        const done = [...this.#items.values()].filter((r) => r.scope === scope && r.status === 'completed');
        const bytes = done.reduce((s, r) => s + r.bytes, 0);
        const over = (cfg.maxItems !== undefined && done.length > cfg.maxItems) || (cfg.maxBytes !== undefined && bytes > cfg.maxBytes);
        if (!over) return;
        const victim = done
          .filter((r) => !r.pinned && r.key !== keep)
          .sort((a, b) => (a.lastAccessedAt ?? a.completedAt ?? 0) - (b.lastAccessedAt ?? b.completedAt ?? 0))[0];
        if (!victim) return;
        await this._evict(victim, cfg.maxItems !== undefined && done.length > cfg.maxItems ? 'max-items' : 'max-bytes');
      }
    });
  }

  async #measure(urls: string[], cfg: ResolvedCollectionConfig): Promise<number> {
    try {
      const sizes = await Promise.all(
        urls.map(async (u) => {
          const init: RequestInit = { credentials: 'same-origin', ...cfg.requestInit, method: 'HEAD', mode: 'cors' };
          if (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal) init.signal = AbortSignal.timeout(10_000);
          const res = await fetch(u, init);
          const len = Number(res.headers.get('Content-Length'));
          return res.ok && len > 0 && !res.headers.get('Content-Encoding') ? len : 0;
        }),
      );
      return sizes.includes(0) ? 0 : sizes.reduce((a, b) => a + b, 0);
    } catch {
      return 0;
    }
  }

  async #registrationOnce(): Promise<ServiceWorkerRegistration | undefined> {
    const sw = this.#config.serviceWorker;
    if (sw === false) return undefined;
    if (sw) return sw;
    const container = nav()?.serviceWorker;
    if (!container) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), this.#config.serviceWorkerTimeout)));
    const reg = await Promise.race([container.ready, timeout]);
    clearTimeout(timer);
    return reg;
  }

  async #manager(): Promise<BgFetchManager | undefined> {
    if (!this.#registration) {
      this.#registration = this.#registrationOnce();
      void this.#registration.then((r) => {
        if (!r) this.#registration = undefined; // try again next time
      });
    }
    const reg = await this.#registration;
    return reg && 'backgroundFetch' in reg ? (reg as unknown as { backgroundFetch: BgFetchManager }).backgroundFetch : undefined;
  }

  #askPersist(): void {
    if (this.#persistAsked) return;
    this.#persistAsked = true;
    void this.storage.persisted().then((p) => (p ? true : this.storage.persist())).catch(() => false);
  }

  #post(msg: Omit<ChannelMessage, 'source' | 'type'>): void {
    try {
      broadcast(msg, this.#channel);
    } catch {
      // Structured-clone failures (exotic meta) must not break downloads.
      broadcast({ kind: msg.kind, key: msg.key }, this.#channel);
    }
  }

  async #onMessage(msg: ChannelMessage): Promise<void> {
    if (!msg.key.startsWith(`${this.namespace}/`)) return;
    const kind: UpdateKind = msg.kind;
    if (kind === 'delete' || kind === 'abort' || kind === 'evict') {
      const prev = this.#items.get(msg.key) ?? msg.item;
      this.#active.get(msg.key)?.detach?.();
      this.#active.delete(msg.key);
      this._forget(msg.key);
      if (!prev) return;
      const item = toPublicItem(prev);
      if (kind === 'evict') this._emit('evict', { item, reason: (msg.reason as EvictReason | undefined) ?? 'max-items' });
      else this._emit(kind, { item });
      return;
    }
    const rec = await store.getItem(msg.key);
    if (!rec) {
      this._forget(msg.key);
      return;
    }
    const prev = this.#items.get(msg.key);
    if (rec.status === 'downloading' && prev?.status === 'downloading') rec.downloaded = Math.max(rec.downloaded, prev.downloaded);
    this._set(rec);
    const item = toPublicItem(rec);
    if (kind === 'complete') {
      this.#active.get(msg.key)?.detach?.();
      this.#active.delete(msg.key);
      this._emit('complete', { item });
      await this.#enforceLimits(rec.collection, rec.key);
    } else if (kind === 'fail') {
      this.#active.get(msg.key)?.detach?.();
      this.#active.delete(msg.key);
      if (rec.error?.code === 'download-total-exceeded' && rec.total > 0) {
        // The declared size was too small. Retry once without a declared total.
        await withLock(`offlibrary:restart:${rec.key}`, async () => {
          let claimed = false;
          const again = await this._patch(rec.key, (r) => {
            if (r.status !== 'failed' || r.total === 0) return;
            claimed = true;
            r.total = 0;
            r.status = 'downloading';
            r.attempts += 1;
            delete r.error;
          });
          if (again && claimed) await this.#start(again);
        });
        return;
      }
      this._emit('error', { item, error: this.#errorOf(rec) });
    } else if (kind === 'click') {
      this._emit('click', { item });
    } else {
      this._emit('change', { item, type: 'update' });
    }
  }

  async #init(): Promise<void> {
    this.#channel = openChannel();
    if (this.#channel) {
      this.#channel.onmessage = (e: MessageEvent) => {
        if (isChannelMessage(e.data)) void this.#onMessage(e.data).catch((err) => console.error('[offlibrary]', err));
      };
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.#onVisible);
    const prefix = `${this.namespace}/`;
    for (const rec of await store.listAll()) {
      if (rec.key.startsWith(prefix) && this.#config.collections[rec.collection]) this._set(rec);
    }
    if (this.#config.persist === 'on-init') this.#askPersist();
    await this.#reconcile();
  }

  /** Re-attach to Background Fetches and resume interrupted fetch downloads after a reload. */
  async #reconcile(): Promise<void> {
    const running = [...this.#items.values()].filter((r) => r.status === 'downloading');
    const fetchResumes: StoredItem[] = [];
    for (const rec of running) {
      if (rec.strategy === 'background-fetch') {
        const mgr = await this.#manager();
        const reg = mgr ? await mgr.get(bgFetchIdOf(rec.key)) : undefined;
        if (reg) {
          this.#attach(rec.key, reg);
          continue;
        }
        const fresh = await store.getItem(rec.key);
        if (fresh && fresh.status !== 'downloading') {
          this._set(fresh);
          continue;
        }
        if (fresh) {
          await this.#fail(rec.key, new OfflibraryError('lost', 'The browser no longer has this download. Retry to start again.'));
        }
      } else if (!(await lockHeld(`offlibrary:${rec.key}`))) {
        if (this.#config.resumeOnStart) fetchResumes.push(rec);
        else await this._patch(rec.key, (r) => {
          r.status = 'paused';
        });
      }
    }
    for (const rec of fetchResumes) this.#runFetch(rec);
  }
}

/**
 * Create an Offlibrary instance.
 *
 * @example
 * ```ts
 * import { createOfflibrary } from 'offlibrary';
 *
 * export const library = createOfflibrary({
 *   namespace: 'podcast',
 *   collections: {
 *     episodes: { maxItems: 20, ui: { icons: [{ src: '/icon-192.png', sizes: '192x192' }] } },
 *   },
 * });
 * ```
 */
export function createOfflibrary(config: OfflibraryConfig): Offlibrary {
  return new Offlibrary(config);
}
