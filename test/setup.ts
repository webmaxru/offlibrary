import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach } from 'vitest';
import { _resetDBConnection } from '../src/internal/store.js';
import { MemoryCacheStorage } from './helpers.js';

// Workbox modules expect a service-worker global named `self`.
(globalThis as unknown as { self: unknown }).self ??= globalThis;
(globalThis as unknown as { __WB_DISABLE_DEV_LOGS: boolean }).__WB_DISABLE_DEV_LOGS = true;
class ExtendableEventStub extends Event {
  readonly pending: Promise<unknown>[] = [];
  waitUntil(p: Promise<unknown>): void {
    this.pending.push(p);
  }
}
(globalThis as unknown as { ExtendableEvent: unknown }).ExtendableEvent ??= ExtendableEventStub;
(globalThis as unknown as { FetchEvent: unknown }).FetchEvent ??= class FetchEvent extends ExtendableEventStub {};

beforeEach(() => {
  // Fresh IndexedDB and Cache Storage for every test.
  globalThis.indexedDB = new IDBFactory();
  _resetDBConnection();
  (globalThis as unknown as { caches: MemoryCacheStorage }).caches = new MemoryCacheStorage();
});
