import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach } from 'vitest';
import { _resetDBConnection } from '../src/internal/store.js';
import { MemoryCacheStorage } from './helpers.js';

beforeEach(() => {
  // Fresh IndexedDB and Cache Storage for every test.
  globalThis.indexedDB = new IDBFactory();
  _resetDBConnection();
  (globalThis as unknown as { caches: MemoryCacheStorage }).caches = new MemoryCacheStorage();
});
