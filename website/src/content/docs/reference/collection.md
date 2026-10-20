---
title: Library and collection methods
description: The methods of the Offlibrary instance and of each Collection.
sidebar:
  order: 2
---

`createOfflibrary(config)` returns an `Offlibrary`; `library.collection(name)` returns a `Collection`. Every collection method waits for `library.ready`, so you can call them right away.

## Offlibrary

| Member | Description |
|---|---|
| `ready: Promise<void>` | Resolves once metadata is loaded and in-flight downloads are re-attached. Collection methods wait for it, so you rarely need to. |
| `collection(name)` | Returns the `Collection`. Throws `unknown-collection` for names not in the config. |
| `collectionNames` | Configured collection names. |
| `on(type, listener)` | Typed event listener. Returns an unsubscribe function. It's also a regular `EventTarget` (`addEventListener` + `CustomEvent.detail`). |
| `subscribe(listener)` | Called on every change in any collection (`change` event). Returns an unsubscribe function. |
| `storage.estimate()` | `{ usage, quota, available, supported }` |
| `storage.persist()` / `storage.persisted()` | Wrappers around `navigator.storage.persist()` / `persisted()`. |
| `capabilities` | `{ serviceWorker, backgroundFetch, cacheStorage, indexedDB, storageEstimate, storagePersist, webLocks }` |
| `refresh()` | Re-read metadata from IndexedDB. Runs automatically when the page becomes visible. |
| `destroy()` | Stop listening and pause running fetch downloads (they resume next time). |

## Collection

| Method | Returns | Description |
|---|---|---|
| `download(item)` | `Promise<OfflibraryItem>` | Starts or continues a download and resolves **once it has started**. If the item is already stored with the same version, nothing is downloaded and it's marked as recently used. Paused or failed items resume. Throws `invalid-item`, `limit-exceeded` or `quota-exceeded` before starting. |
| `downloadAll(items)` | `Promise<PromiseSettledResult[]>` | Calls `download` for each item. |
| `done(id)` | `Promise<OfflibraryItem>` | Resolves when the item completes; rejects with an `OfflibraryError` if it fails, pauses or is removed. |
| `get(id)` / `peek(id)` | `OfflibraryItem \| undefined` | Async / sync state of one item. |
| `list()` / `snapshot()` | `readonly OfflibraryItem[]` | All items. `snapshot()` is sync and **referentially stable** until something in the collection changes. |
| `has(id)` | `Promise<boolean>` | `true` when the item is completed. |
| `pause(id)` / `resume(id)` / `retry(id)` | `Promise<OfflibraryItem>` | Pause is for the fetch transport only (Background Fetch has no pause and throws `not-supported`). Resume and retry continue paused or failed items. |
| `cancel(id)` | `Promise<void>` | Stops a download (including a Background Fetch) and removes the item. |
| `delete(id)` | `Promise<boolean>` | Removes the item and its stored files. |
| `clear()` | `Promise<void>` | Deletes every item in the collection. |
| `match(id, url?)` / `blob(id, url?)` | `Response` / `Blob` | The stored file (the first URL by default), for every storage kind. For `storage: 'opfs'` the Blob is the disk-backed OPFS `File`, not a copy in memory. |
| `bytes(id, url?)` / `arrayBuffer(id, url?)` | `Uint8Array` / `ArrayBuffer` | The stored file as bytes, the shape model runtimes take (`ort.InferenceSession.create(await models.bytes('m'))`). For items kept in memory it returns the buffer the download filled, without a copy. |
| `usage()` | `{ count, bytes }` | Completed items and their size. |
| `sync(items, { prune })` | `(OfflibraryItem \| undefined)[]` | Updates titles and meta from your feed. With `prune: true`, deletes stored items no longer in it (pinned ones are kept). |
| `touch(id)` | `Promise<OfflibraryItem>` | Marks the item as recently used. The service worker does this when it serves a file. |
| `subscribe(listener)` | `() => void` | Change listener for this collection only. Pair it with `snapshot()`. |
| `name`, `config` | | Collection name and resolved policy. |

## Utilities

```js
import { formatBytes, isBackgroundFetchSupported, OfflibraryError } from 'offlibrary';

formatBytes(1536);              // "1.5 KB"
isBackgroundFetchSupported();   // true when the browser exposes BackgroundFetchManager (Chromium)
```

Full signatures: [API reference](/offlibrary/api/readme/).
