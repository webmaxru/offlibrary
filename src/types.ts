import type { SerializedError } from './errors.js';

/** How a download is transported. */
export type Strategy = 'background-fetch' | 'fetch';

/** Lifecycle of an item. */
export type ItemStatus = 'downloading' | 'paused' | 'completed' | 'failed';

/** Icon for the Background Fetch notification (same shape as a manifest icon). */
export interface ImageResource {
  src: string;
  sizes?: string;
  type?: string;
  label?: string;
}

/** What you pass to `collection.download()`. */
export interface ItemInput<M = unknown> {
  /** Stable id you choose (episode GUID, lesson slug, …). Unique within the collection. */
  id: string;
  /** The file to download. Use `urls` for multi-file items. */
  url?: string;
  /** Several files that together form one item (video + subtitles, a tile pack, …). */
  urls?: string[];
  /** Human title, used in the Background Fetch notification. */
  title?: string;
  /** Known total size in bytes. Skips the HEAD request and enables quota checks. */
  size?: number;
  /** Any structured-cloneable data you want to keep with the item. */
  meta?: M;
  /** Subresource-Integrity string(s), one per URL, e.g. `sha256-…`. */
  integrity?: string | (string | undefined)[];
  /** Content version. Downloading again with a different version replaces the stored copy. */
  version?: string;
  /** Notification icons for this item (overrides the collection's `ui.icons`). */
  icons?: ImageResource[];
  /** Pinned items are never evicted by limits or quota pressure. */
  pinned?: boolean;
}

/** Public, read-only snapshot of an item. */
export interface OfflibraryItem<M = unknown> {
  readonly key: string;
  readonly namespace: string;
  readonly collection: string;
  readonly id: string;
  readonly urls: readonly string[];
  readonly title?: string;
  readonly meta?: M;
  readonly version?: string;
  readonly pinned?: boolean;
  readonly status: ItemStatus;
  readonly strategy: Strategy;
  /** Bytes received so far. */
  readonly downloaded: number;
  /** Expected total bytes, `0` when unknown. */
  readonly total: number;
  /** `downloaded / total` in `0..1`, or `null` when the total is unknown. */
  readonly progress: number | null;
  /** Bytes stored once completed. */
  readonly bytes: number;
  readonly error?: SerializedError;
  readonly attempts: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
  readonly lastAccessedAt?: number;
}

/** @internal Shape persisted in IndexedDB, shared by page and service worker. */
export interface StoredItem {
  key: string;
  scope: string;
  namespace: string;
  collection: string;
  id: string;
  urls: string[];
  title?: string;
  meta?: unknown;
  version?: string;
  integrity?: (string | undefined)[];
  pinned?: boolean;
  status: ItemStatus;
  strategy: Strategy;
  downloaded: number;
  total: number;
  bytes: number;
  error?: SerializedError;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  lastAccessedAt?: number;
  cacheName: string;
  ui?: StoredUI;
}

/** @internal */
export interface StoredUI {
  title?: string;
  icons?: ImageResource[];
  successTitle?: string;
  failTitle?: string;
  clickUrl?: string;
}

/** @internal Partial download state for resumable fetches. */
export interface StoredPart {
  key: string;
  itemKey: string;
  index: number;
  blobs: Blob[];
  received: number;
  total: number;
  etag?: string;
  lastModified?: string;
  type?: string;
  done: boolean;
}

/** @internal */
export function toPublicItem<M = unknown>(r: StoredItem): OfflibraryItem<M> {
  const item: Record<string, unknown> = {
    key: r.key,
    namespace: r.namespace,
    collection: r.collection,
    id: r.id,
    urls: r.urls.slice(),
    status: r.status,
    strategy: r.strategy,
    downloaded: r.downloaded,
    total: r.total,
    progress: r.status === 'completed' ? 1 : r.total > 0 ? Math.min(1, r.downloaded / r.total) : null,
    bytes: r.bytes,
    attempts: r.attempts,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
  for (const k of ['title', 'meta', 'version', 'pinned', 'error', 'completedAt', 'lastAccessedAt'] as const) {
    if (r[k] !== undefined) item[k] = r[k];
  }
  return Object.freeze(item) as unknown as OfflibraryItem<M>;
}
