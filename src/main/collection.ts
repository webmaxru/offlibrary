import { OfflibraryError } from '../errors.js';
import type { ResolvedCollectionConfig } from '../config.js';
import { absoluteUrl } from '../internal/util.js';
import { toPublicItem } from '../types.js';
import type { ItemInput, OfflibraryItem } from '../types.js';
import type { Offlibrary } from './offlibrary.js';

/** Per-collection usage. */
export interface CollectionUsage {
  /** Completed items. */
  count: number;
  /** Bytes of completed items. */
  bytes: number;
}

/**
 * A named group of downloadable items sharing one policy. Get it with `library.collection(name)`.
 * Every method waits for `library.ready` first.
 */
export class Collection<M = unknown> {
  /** Collection name from the config. */
  readonly name: string;
  readonly #lib: Offlibrary;

  /** @internal */
  constructor(lib: Offlibrary, name: string) {
    this.#lib = lib;
    this.name = name;
  }

  /** The resolved policy (defaults filled in). */
  get config(): Readonly<ResolvedCollectionConfig> {
    return this.#lib._collectionConfig(this.name);
  }

  #key(id: string): string {
    if (typeof id !== 'string' || !id) throw new OfflibraryError('invalid-item', 'Item id must be a non-empty string.');
    return this.#lib._key(this.name, id);
  }

  /**
   * Start (or continue) downloading an item. Resolves once the download has started, with the item's
   * current state. Use events or {@link Collection.done} to learn when it completes.
   *
   * - Already completed with the same `version` and URLs: no-op (marks it as recently used).
   * - Paused or failed: resumes.
   * - Different `version` or URLs: downloads again and replaces the stored copy.
   *
   * Throws `invalid-item`, `limit-exceeded` or `quota-exceeded` before anything starts.
   */
  download(item: ItemInput<M>): Promise<OfflibraryItem<M>> {
    return this.#lib._download(this.name, item) as Promise<OfflibraryItem<M>>;
  }

  /** Download several items. Failing items reject individually; see the returned settled results. */
  downloadAll(items: ItemInput<M>[]): Promise<PromiseSettledResult<OfflibraryItem<M>>[]> {
    return Promise.allSettled(items.map((i) => this.download(i)));
  }

  /** Current state of an item, or `undefined` if it is not in the library. */
  async get(id: string): Promise<OfflibraryItem<M> | undefined> {
    await this.#lib.ready;
    return this.peek(id);
  }

  /** Synchronous version of {@link Collection.get} (valid after `library.ready`). */
  peek(id: string): OfflibraryItem<M> | undefined {
    const rec = this.#lib._peek(this.#key(id));
    return rec ? toPublicItem<M>(rec) : undefined;
  }

  /** All items in the collection, oldest first. */
  async list(): Promise<readonly OfflibraryItem<M>[]> {
    await this.#lib.ready;
    return this.snapshot();
  }

  /**
   * Synchronous, referentially stable list of items. A new array is created only when something in
   * this collection changes, so it can be used directly as a `useSyncExternalStore` snapshot.
   */
  snapshot(): readonly OfflibraryItem<M>[] {
    return this.#lib._snapshot(this.name) as readonly OfflibraryItem<M>[];
  }

  /**
   * Call `listener` whenever an item in this collection changes. Returns an unsubscribe function.
   * Pair with {@link Collection.snapshot} for `useSyncExternalStore`, signals or stores.
   */
  subscribe(listener: (detail: { item: OfflibraryItem<M>; type: string }) => void): () => void {
    return this.#lib.subscribe((d) => {
      if (d.item.collection === this.name) listener(d as { item: OfflibraryItem<M>; type: string });
    });
  }

  /** Whether the item is fully downloaded and available offline. */
  async has(id: string): Promise<boolean> {
    return (await this.get(id))?.status === 'completed';
  }

  /**
   * Resolves with the item when it is completed; rejects with an `OfflibraryError` when it fails,
   * is cancelled, deleted or evicted.
   */
  async done(id: string): Promise<OfflibraryItem<M>> {
    await this.#lib.ready;
    const key = this.#key(id);
    return new Promise((resolve, reject) => {
      const check = () => {
        const rec = this.#lib._peek(key);
        if (!rec) return fail(new OfflibraryError('not-found', `"${id}" is not in "${this.name}".`));
        if (rec.status === 'completed') {
          off();
          resolve(toPublicItem<M>(rec));
        } else if (rec.status === 'failed') {
          const e = rec.error;
          fail(new OfflibraryError(e?.code ?? 'unknown', e?.message ?? 'Download failed.', e?.status !== undefined ? { status: e.status } : {}));
        } else if (rec.status === 'paused') {
          fail(new OfflibraryError('aborted', `"${id}" was paused.`));
        }
      };
      const fail = (e: OfflibraryError) => {
        off();
        reject(e);
      };
      const off = this.#lib.subscribe(({ item }) => {
        if (item.key === key) check();
      });
      check();
    });
  }

  /** Cancel a download in progress (or remove a paused/failed one). The item is removed. */
  async cancel(id: string): Promise<void> {
    await this.#lib._cancel(this.#key(id));
  }

  /** Pause a fetch-transport download, keeping received bytes. Background Fetch downloads throw `not-supported`. */
  pause(id: string): Promise<OfflibraryItem<M>> {
    return this.#lib._pause(this.#key(id)) as Promise<OfflibraryItem<M>>;
  }

  /** Resume a paused or failed download. */
  resume(id: string): Promise<OfflibraryItem<M>> {
    return this.#lib._resume(this.#key(id)) as Promise<OfflibraryItem<M>>;
  }

  /** Retry a failed download (same as {@link Collection.resume}). */
  retry(id: string): Promise<OfflibraryItem<M>> {
    return this.resume(id);
  }

  /** Delete an item and its stored files. Resolves `false` if it did not exist. */
  delete(id: string): Promise<boolean> {
    return this.#lib._delete(this.#key(id));
  }

  /** Delete every item in the collection. */
  async clear(): Promise<void> {
    for (const item of await this.list()) await this.delete(item.id);
  }

  /** Mark an item as recently used (protects it from LRU eviction). Done automatically when the SW serves it. */
  touch(id: string): Promise<OfflibraryItem<M>> {
    return this.#lib._touch(this.#key(id)) as Promise<OfflibraryItem<M>>;
  }

  /**
   * The stored response for one of the item's files (default: the first), or `undefined`.
   * Works for every storage kind (`cache`, `opfs`, `memory`).
   */
  async match(id: string, url?: string): Promise<Response | undefined> {
    const item = await this.get(id);
    if (!item || item.status !== 'completed') return undefined;
    const target = url ? absoluteUrl(url) : item.urls[0]!;
    return this.#lib._match(item.key, target);
  }

  /** The stored file as a Blob (default: the first file), or `undefined`. For OPFS this is a disk-backed `File`. */
  async blob(id: string, url?: string): Promise<Blob | undefined> {
    const item = await this.get(id);
    if (!item || item.status !== 'completed') return undefined;
    const target = url ? absoluteUrl(url) : item.urls[0]!;
    const data = await this.#lib._read(item.key, target);
    if (!data) return undefined;
    return data instanceof Blob ? data : new Blob([data as BlobPart]);
  }

  /** The stored file as an `ArrayBuffer` (default: the first file), or `undefined`. */
  async arrayBuffer(id: string, url?: string): Promise<ArrayBuffer | undefined> {
    const bytes = await this.bytes(id, url);
    if (!bytes) return undefined;
    return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? (bytes.buffer as ArrayBuffer)
      : (bytes.slice().buffer as ArrayBuffer);
  }

  /**
   * The stored file as a `Uint8Array` (default: the first file), or `undefined`. This is the shape
   * model runtimes take: `ort.InferenceSession.create(await models.bytes('encoder'))`.
   *
   * For items kept in memory (`storage: 'memory'`) this returns the buffer the download filled, without a
   * copy. Treat it as read-only.
   */
  async bytes(id: string, url?: string): Promise<Uint8Array | undefined> {
    const item = await this.get(id);
    if (!item || item.status !== 'completed') return undefined;
    const target = url ? absoluteUrl(url) : item.urls[0]!;
    const data = await this.#lib._read(item.key, target);
    if (!data) return undefined;
    return data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
  }

  /** Completed items and their bytes. */
  async usage(): Promise<CollectionUsage> {
    const done = (await this.list()).filter((i) => i.status === 'completed');
    return { count: done.length, bytes: done.reduce((s, i) => s + i.bytes, 0) };
  }

  /**
   * Reconcile with your source of truth (a feed, an API response). Updates titles/meta of known
   * items and, with `prune: true`, deletes stored items whose id is not in `items` (pinned items are kept).
   * Returns the current state for each input (or `undefined` when it isn't downloaded).
   */
  async sync(
    items: Pick<ItemInput<M>, 'id' | 'title' | 'meta'>[],
    options: { prune?: boolean } = {},
  ): Promise<(OfflibraryItem<M> | undefined)[]> {
    await this.#lib.ready;
    const ids = new Set(items.map((i) => i.id));
    if (options.prune) {
      for (const item of this.snapshot()) {
        if (!ids.has(item.id) && !item.pinned) await this.delete(item.id);
      }
    }
    const out: (OfflibraryItem<M> | undefined)[] = [];
    for (const input of items) {
      const key = this.#key(input.id);
      const rec = this.#lib._peek(key);
      const changed = rec && ((input.title !== undefined && input.title !== rec.title) || (input.meta !== undefined && input.meta !== rec.meta));
      if (changed) {
        const next = await this.#lib._patch(key, (r) => {
          if (input.title !== undefined) r.title = input.title;
          if (input.meta !== undefined) r.meta = input.meta;
        });
        if (next) this.#lib._emit('change', { item: toPublicItem(next), type: 'update' });
      }
      out.push(this.peek(input.id));
    }
    return out;
  }
}
