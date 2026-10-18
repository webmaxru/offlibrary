import type { StoredItem } from '../types.js';

/** BroadcastChannel used between pages and the service worker. */
export const CHANNEL_NAME = 'offlibrary';

/** What happened to an item. */
export type UpdateKind = 'change' | 'complete' | 'fail' | 'abort' | 'delete' | 'evict' | 'click';

/** @internal Message format on the channel. */
export interface ChannelMessage {
  source: 'offlibrary';
  type: 'update';
  kind: UpdateKind;
  key: string;
  /** Snapshot for kinds where the record no longer exists (delete, abort, evict). */
  item?: StoredItem;
  /** Evict reason. */
  reason?: string;
}

/** @internal */
export function openChannel(): BroadcastChannel | undefined {
  return typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL_NAME) : undefined;
}

/** @internal */
export function isChannelMessage(data: unknown): data is ChannelMessage {
  return !!data && typeof data === 'object' && (data as ChannelMessage).source === 'offlibrary';
}

/** @internal Post on a short-lived channel (used by the service worker). */
export function broadcast(msg: Omit<ChannelMessage, 'source' | 'type'>, channel?: BroadcastChannel): void {
  const ch = channel ?? openChannel();
  if (!ch) return;
  ch.postMessage({ source: 'offlibrary', type: 'update', ...msg } satisfies ChannelMessage);
  if (!channel) ch.close();
}
