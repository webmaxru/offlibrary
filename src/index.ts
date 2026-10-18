/**
 * Offlibrary: declarative offline asset management for the web.
 * Background Fetch when the browser has it, a resumable streaming fallback when it doesn't.
 *
 * Page entry point. For the service worker, import from `offlibrary/sw`.
 * @packageDocumentation
 */
export { createOfflibrary, Offlibrary } from './main/offlibrary.js';
export type {
  EvictReason,
  OfflibraryCapabilities,
  OfflibraryEventMap,
  OfflibraryListener,
  StorageEstimate,
} from './main/offlibrary.js';
export { Collection } from './main/collection.js';
export type { CollectionUsage } from './main/collection.js';
export type { CollectionConfig, ItemDescriptor, OfflibraryConfig } from './config.js';
export type { ImageResource, ItemInput, ItemStatus, OfflibraryItem, Strategy } from './types.js';
export { OfflibraryError } from './errors.js';
export type { OfflibraryErrorCode, SerializedError } from './errors.js';
export { formatBytes } from './internal/util.js';

/** `true` when this browser implements Background Fetch (Chromium-based browsers). */
export function isBackgroundFetchSupported(): boolean {
  return typeof (globalThis as Record<string, unknown>).BackgroundFetchManager === 'function';
}
