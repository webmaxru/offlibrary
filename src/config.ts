import { OfflibraryError } from './errors.js';
import type { ImageResource, ItemInput } from './types.js';

/** Item fields available to UI callbacks. */
export interface ItemDescriptor {
  id: string;
  title?: string;
  urls: string[];
  meta?: unknown;
}

/** Per-collection policy. Every field is optional. */
export interface CollectionConfig {
  /**
   * `'auto'` (default) uses Background Fetch when the browser supports it and the item is at least
   * `backgroundFetchThreshold` bytes (or of unknown size); otherwise streaming `fetch`.
   * `'background-fetch'` prefers Background Fetch for every item (still falls back when unsupported).
   * `'fetch'` never uses Background Fetch.
   */
  strategy?: 'auto' | 'background-fetch' | 'fetch';
  /** Minimum size for Background Fetch under `'auto'`. Default 5 MiB. */
  backgroundFetchThreshold?: number;
  /** Measure unknown sizes with a HEAD request before downloading. Default `true`. */
  autoSize?: boolean;
  /** Keep at most this many completed items; least-recently-used ones are evicted. */
  maxItems?: number;
  /** Keep at most this many bytes of completed items; least-recently-used ones are evicted. */
  maxBytes?: number;
  /** `'lru'` (default) evicts old items to make room; `'none'` fails with `limit-exceeded` / `quota-exceeded`. */
  evict?: 'lru' | 'none';
  /** Retries for the fetch transport on network errors / 5xx / 429. Default 3. */
  retries?: number;
  /** Base delay in ms for exponential backoff. Default 1000. */
  retryDelay?: number;
  /** Persist partial fetch downloads so they resume after reloads. Default `true`. */
  resumable?: boolean;
  /** Extra request options (credentials, headers, …) for both transports. */
  requestInit?: Pick<RequestInit, 'credentials' | 'headers' | 'referrerPolicy' | 'cache'>;
  /** Background Fetch notification UI. */
  ui?: {
    /** Title while downloading. Default: the item title. */
    title?: (item: ItemDescriptor) => string;
    /** Title once stored. Default: `"<title> is ready offline"`. */
    successTitle?: (item: ItemDescriptor) => string;
    /** Title when the download failed. Default: `"<title> failed to download"`. */
    failTitle?: (item: ItemDescriptor) => string;
    /** Notification icons. */
    icons?: ImageResource[];
  };
  /** Page to open/focus when the user taps the download notification. Must be same-origin. */
  clickUrl?: string | ((item: ItemDescriptor) => string);
}

/** Top-level configuration for {@link createOfflibrary}. */
export interface OfflibraryConfig {
  /** Isolates ids, caches and metadata from other Offlibrary instances on the origin. Default `'default'`. */
  namespace?: string;
  /** Named collections and their policies. At least one is required. */
  collections: Record<string, CollectionConfig>;
  /**
   * The service worker registration to use for Background Fetch.
   * Default: `navigator.serviceWorker.ready` (waits up to `serviceWorkerTimeout`).
   * Pass `false` to never use a service worker (fetch transport only).
   */
  serviceWorker?: ServiceWorkerRegistration | Promise<ServiceWorkerRegistration> | false;
  /** How long to wait for an active service worker before falling back to fetch. Default 3000 ms. */
  serviceWorkerTimeout?: number;
  /** When to call `navigator.storage.persist()`. Default `'on-download'`. */
  persist?: 'never' | 'on-init' | 'on-download';
  /** Resume interrupted fetch downloads when the library starts. Default `true`. */
  resumeOnStart?: boolean;
  /** Minimum ms between `progress` events per item. Default 150. */
  progressInterval?: number;
}

/** A collection's policy with every default filled in (see `collection.config`). */
export type ResolvedCollectionConfig = Required<
  Pick<CollectionConfig, 'strategy' | 'backgroundFetchThreshold' | 'autoSize' | 'evict' | 'retries' | 'retryDelay' | 'resumable'>
> &
  Omit<CollectionConfig, 'strategy' | 'backgroundFetchThreshold' | 'autoSize' | 'evict' | 'retries' | 'retryDelay' | 'resumable'>;

/** @internal */
export interface ResolvedConfig {
  namespace: string;
  collections: Record<string, ResolvedCollectionConfig>;
  serviceWorker: OfflibraryConfig['serviceWorker'];
  serviceWorkerTimeout: number;
  persist: 'never' | 'on-init' | 'on-download';
  resumeOnStart: boolean;
  progressInterval: number;
}

const MiB = 1024 * 1024;
const NAME = /^[A-Za-z0-9._-]+$/;

const bad = (msg: string): never => {
  throw new OfflibraryError('invalid-config', `Offlibrary config: ${msg}`);
};
const isNum = (v: unknown, min = 0) => typeof v === 'number' && Number.isFinite(v) && v >= min;
const oneOf = (v: unknown, list: readonly string[]) => v === undefined || list.includes(v as string);

/** @internal Validate and fill defaults. Throws `OfflibraryError('invalid-config')`. */
export function resolveConfig(config: OfflibraryConfig): ResolvedConfig {
  if (!config || typeof config !== 'object') bad('expected an object.');
  const namespace = config.namespace ?? 'default';
  if (typeof namespace !== 'string' || !NAME.test(namespace)) bad(`"namespace" must match ${NAME} (got ${JSON.stringify(namespace)}).`);
  if (!config.collections || typeof config.collections !== 'object' || !Object.keys(config.collections).length) {
    bad('"collections" must define at least one collection.');
  }
  if (!oneOf(config.persist, ['never', 'on-init', 'on-download'])) bad('"persist" must be "never", "on-init" or "on-download".');
  if (config.serviceWorkerTimeout !== undefined && !isNum(config.serviceWorkerTimeout)) bad('"serviceWorkerTimeout" must be a number ≥ 0.');
  if (config.progressInterval !== undefined && !isNum(config.progressInterval)) bad('"progressInterval" must be a number ≥ 0.');

  const collections: Record<string, ResolvedCollectionConfig> = {};
  for (const [name, c] of Object.entries(config.collections)) {
    const at = `collections.${name}`;
    if (!NAME.test(name)) bad(`collection name "${name}" must match ${NAME}.`);
    if (!c || typeof c !== 'object') bad(`"${at}" must be an object.`);
    if (!oneOf(c.strategy, ['auto', 'background-fetch', 'fetch'])) bad(`"${at}.strategy" must be "auto", "background-fetch" or "fetch".`);
    if (!oneOf(c.evict, ['lru', 'none'])) bad(`"${at}.evict" must be "lru" or "none".`);
    for (const k of ['backgroundFetchThreshold', 'retryDelay', 'maxBytes'] as const) {
      if (c[k] !== undefined && !isNum(c[k])) bad(`"${at}.${k}" must be a number ≥ 0.`);
    }
    for (const k of ['maxItems', 'retries'] as const) {
      if (c[k] !== undefined && !(Number.isInteger(c[k]) && (c[k] as number) >= 0)) bad(`"${at}.${k}" must be an integer ≥ 0.`);
    }
    if (c.clickUrl !== undefined && typeof c.clickUrl !== 'string' && typeof c.clickUrl !== 'function') bad(`"${at}.clickUrl" must be a string or a function.`);
    collections[name] = {
      ...c,
      strategy: c.strategy ?? 'auto',
      backgroundFetchThreshold: c.backgroundFetchThreshold ?? 5 * MiB,
      autoSize: c.autoSize ?? true,
      evict: c.evict ?? 'lru',
      retries: c.retries ?? 3,
      retryDelay: c.retryDelay ?? 1000,
      resumable: c.resumable ?? true,
    };
  }
  return {
    namespace,
    collections,
    serviceWorker: config.serviceWorker,
    serviceWorkerTimeout: config.serviceWorkerTimeout ?? 3000,
    persist: config.persist ?? 'on-download',
    resumeOnStart: config.resumeOnStart ?? true,
    progressInterval: config.progressInterval ?? 150,
  };
}

/** @internal Validate an item input. Returns absolute URLs. */
export function validateItem(input: ItemInput, resolve: (u: string) => string): string[] {
  const fail = (msg: string): never => {
    throw new OfflibraryError('invalid-item', `Offlibrary item: ${msg}`);
  };
  if (!input || typeof input !== 'object') fail('expected an object.');
  if (typeof input.id !== 'string' || !input.id) fail('"id" must be a non-empty string.');
  const list = input.urls ?? (input.url !== undefined ? [input.url] : []);
  if (!Array.isArray(list) || !list.length || list.some((u) => typeof u !== 'string' || !u)) {
    fail(`item "${input.id}" needs "url" or a non-empty "urls" array.`);
  }
  let urls: string[] = [];
  try {
    urls = list.map(resolve);
  } catch {
    fail(`item "${input.id}" has an invalid URL.`);
  }
  if (urls.some((u) => !/^https?:/.test(u))) fail(`item "${input.id}": only http(s) URLs can be stored.`);
  if (new Set(urls).size !== urls.length) fail(`item "${input.id}" lists the same URL twice.`);
  if (input.size !== undefined && !isNum(input.size)) fail(`item "${input.id}": "size" must be a number ≥ 0.`);
  const integrity = input.integrity;
  const okIntegrity =
    integrity === undefined ||
    (typeof integrity === 'string' && urls.length === 1) ||
    (Array.isArray(integrity) && integrity.length === urls.length);
  if (!okIntegrity) fail(`item "${input.id}": "integrity" must be a string (single URL) or an array with one entry per URL.`);
  return urls;
}
