import type { StoredItem, StoredPart } from '../types.js';

/** IndexedDB database shared by pages and the service worker. */
export const DB_NAME = 'offlibrary';
const DB_VERSION = 1;
const ITEMS = 'items';
const PARTS = 'parts';

let dbPromise: Promise<IDBDatabase> | undefined;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** @internal */
export function openDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(ITEMS)) {
          db.createObjectStore(ITEMS, { keyPath: 'key' }).createIndex('scope', 'scope');
        }
        if (!db.objectStoreNames.contains(PARTS)) {
          db.createObjectStore(PARTS, { keyPath: 'key' }).createIndex('itemKey', 'itemKey');
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

async function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T> | Promise<T>,
): Promise<T> {
  const db = await openDB();
  const t = db.transaction(store, mode);
  const done = new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new DOMException('Transaction aborted', 'AbortError'));
  });
  const r = fn(t.objectStore(store));
  const value = r instanceof Promise ? await r : await req(r);
  await done;
  return value;
}

/** @internal Small promise wrapper over the two object stores. */
export const store = {
  getItem: (key: string) => tx<StoredItem | undefined>(ITEMS, 'readonly', (s) => s.get(key)),
  putItem: (item: StoredItem) => tx(ITEMS, 'readwrite', (s) => s.put(item)).then(() => item),
  deleteItem: (key: string) => tx(ITEMS, 'readwrite', (s) => s.delete(key)).then(() => undefined),
  listScope: (scope: string) =>
    tx<StoredItem[]>(ITEMS, 'readonly', (s) => s.index('scope').getAll(scope)),
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
  putPart: (part: StoredPart) => tx(PARTS, 'readwrite', (s) => s.put(part)).then(() => undefined),
  deleteParts: (itemKey: string) =>
    tx<void>(PARTS, 'readwrite', async (s) => {
      const keys = await req(s.index('itemKey').getAllKeys(itemKey));
      await Promise.all(keys.map((k) => req(s.delete(k))));
    }),
};

/** @internal Test helper: forget the cached connection. */
export function _resetDBConnection(): void {
  dbPromise = undefined;
}
