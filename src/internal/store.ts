import type { StoredItem, StoredPart, StoredSegment } from '../types.js';

/** IndexedDB database shared by pages, workers and the service worker. */
export const DB_NAME = 'offlibrary';
/**
 * v1: items + parts (a part carried its whole growing Blob list).
 * v2: + segments. A checkpoint appends one segment record; the part keeps small metadata only.
 */
const DB_VERSION = 2;
const ITEMS = 'items';
const PARTS = 'parts';
const SEGMENTS = 'segments';

let dbPromise: Promise<IDBDatabase> | undefined;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** @internal Segment record key: `<partKey>@<seq, zero-padded>` so keys sort by sequence. */
export const segmentKeyOf = (partKey: string, seq: number): string => `${partKey}@${String(seq).padStart(8, '0')}`;

/** @internal */
export function openDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = (event) => {
        const db = open.result;
        if (!db.objectStoreNames.contains(ITEMS)) {
          db.createObjectStore(ITEMS, { keyPath: 'key' }).createIndex('scope', 'scope');
        }
        if (!db.objectStoreNames.contains(PARTS)) {
          db.createObjectStore(PARTS, { keyPath: 'key' }).createIndex('itemKey', 'itemKey');
        }
        if (!db.objectStoreNames.contains(SEGMENTS)) {
          const segs = db.createObjectStore(SEGMENTS, { keyPath: 'key' });
          segs.createIndex('partKey', 'partKey');
          segs.createIndex('itemKey', 'itemKey');
          if (event.oldVersion >= 1) {
            // Migrate v1 parts (Blob list inside the part) to one segment per Blob.
            const tx = open.transaction!;
            const parts = tx.objectStore(PARTS);
            parts.openCursor().onsuccess = (e) => {
              const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
              if (!cursor) return;
              const part = cursor.value as StoredPart & { blobs?: Blob[] };
              const blobs = part.blobs ?? [];
              let end = 0;
              blobs.forEach((blob, seq) => {
                end += blob.size;
                segs.put({ key: segmentKeyOf(part.key, seq), partKey: part.key, itemKey: part.itemKey, seq, blob, end } satisfies StoredSegment);
              });
              delete part.blobs;
              part.segments = blobs.length;
              part.received = end;
              cursor.update(part);
              cursor.continue();
            };
          }
        }
      };
      open.onsuccess = () => {
        const db = open.result;
        // Let other contexts upgrade later versions instead of blocking them.
        db.onversionchange = () => {
          db.close();
          dbPromise = undefined;
        };
        resolve(db);
      };
      open.onerror = () => reject(open.error);
    });
    dbPromise.catch(() => (dbPromise = undefined));
  }
  return dbPromise;
}

async function txn<T>(
  stores: string | string[],
  mode: IDBTransactionMode,
  fn: (t: IDBTransaction) => IDBRequest<T> | Promise<T>,
): Promise<T> {
  const db = await openDB();
  const t = db.transaction(stores, mode);
  const done = new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new DOMException('Transaction aborted', 'AbortError'));
  });
  const r = fn(t);
  const value = r instanceof Promise ? await r : await req(r);
  await done;
  return value;
}

const tx = <T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | Promise<T>) =>
  txn<T>(store, mode, (t) => fn(t.objectStore(store)));

async function deleteByIndex(s: IDBObjectStore, index: string, value: string): Promise<void> {
  const keys = await req(s.index(index).getAllKeys(value));
  await Promise.all(keys.map((k) => req(s.delete(k))));
}

/** @internal Small promise wrapper over the object stores. */
export const store = {
  getItem: (key: string) => tx<StoredItem | undefined>(ITEMS, 'readonly', (s) => s.get(key)),
  putItem: (item: StoredItem) => tx(ITEMS, 'readwrite', (s) => s.put(item)).then(() => item),
  deleteItem: (key: string) => tx(ITEMS, 'readwrite', (s) => s.delete(key)).then(() => undefined),
  listScope: (scope: string) => tx<StoredItem[]>(ITEMS, 'readonly', (s) => s.index('scope').getAll(scope)),
  listAll: () => tx<StoredItem[]>(ITEMS, 'readonly', (s) => s.getAll()),
  /** Read-modify-write inside one transaction. Returns the new value, or undefined if missing. */
  updateItem: (key: string, patch: (item: StoredItem) => StoredItem | void) =>
    tx<StoredItem | undefined>(ITEMS, 'readwrite', async (s) => {
      const current = await req<StoredItem | undefined>(s.get(key));
      if (!current) return undefined;
      const next = patch(current) ?? current;
      next.updatedAt = Date.now();
      await req(s.put(next));
      return next;
    }),
  getPart: (key: string) => tx<StoredPart | undefined>(PARTS, 'readonly', (s) => s.get(key)),
  /** Write part metadata only (constant size, no data). */
  putPart: (part: StoredPart) => tx(PARTS, 'readwrite', (s) => s.put(part)).then(() => undefined),
  /**
   * Append one checkpoint: a new segment record plus the part's metadata, atomically.
   * The cost is the size of the new segment, never of everything downloaded so far.
   */
  appendSegment: (part: StoredPart, blob: Blob) =>
    txn<void>([PARTS, SEGMENTS], 'readwrite', async (t) => {
      const seq = part.segments;
      const seg: StoredSegment = { key: segmentKeyOf(part.key, seq), partKey: part.key, itemKey: part.itemKey, seq, blob, end: part.received };
      const next = { ...part, segments: seq + 1 };
      await Promise.all([req(t.objectStore(SEGMENTS).put(seg)), req(t.objectStore(PARTS).put(next))]);
      part.segments = seq + 1;
    }),
  /** Segments of a part in order. */
  getSegments: (partKey: string) =>
    tx<StoredSegment[]>(SEGMENTS, 'readonly', (s) => s.index('partKey').getAll(partKey)).then((list) =>
      list.sort((a, b) => a.seq - b.seq),
    ),
  /** Drop a part's segments (restart from zero) and write its fresh metadata. */
  resetPart: (part: StoredPart) =>
    txn<void>([PARTS, SEGMENTS], 'readwrite', async (t) => {
      await deleteByIndex(t.objectStore(SEGMENTS), 'partKey', part.key);
      await req(t.objectStore(PARTS).put(part));
    }),
  deleteParts: (itemKey: string) =>
    txn<void>([PARTS, SEGMENTS], 'readwrite', async (t) => {
      await deleteByIndex(t.objectStore(SEGMENTS), 'itemKey', itemKey);
      await deleteByIndex(t.objectStore(PARTS), 'itemKey', itemKey);
    }),
};

/** @internal Test helper: forget the cached connection. */
export function _resetDBConnection(): void {
  dbPromise = undefined;
}
