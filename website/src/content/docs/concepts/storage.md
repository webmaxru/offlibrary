---
title: Storage, quota, eviction and pinning
description: How Offlibrary keeps your app under quota with per-collection limits, LRU eviction, pinned items and persistent storage.
sidebar:
  order: 4
---

Browsers give each origin a storage quota, and may clear storage under pressure unless it's persistent. Offlibrary makes both explicit.

## Where files live

| What | `storage: 'cache'` (default) | `storage: 'opfs'` |
|---|---|---|
| Files | Cache API, one cache per collection: `offlibrary:<namespace>:<collection>`, keyed by the original URL | Origin Private File System: `/offlibrary/<namespace>/<collection>/<id>~<hash>.<n>.bin`, one file per URL |
| Next to each file | | `<file>.meta.json`: URL, ETag, Last-Modified, size, type, integrity, complete flag |
| Metadata (status, progress, sizes, errors, timestamps) | IndexedDB database `offlibrary`, shared by tabs, workers and the service worker | same |
| Partial fetch downloads | IndexedDB segments, **appended** one per checkpoint (4 MiB), deleted once the file is stored | the partial OPFS file itself, resumed in place |

Everything is cleared when the user clears site data.

## Storage backends: cache or OPFS

**Cache API** (`storage: 'cache'`) is the right home for media and anything the browser itself loads: the service worker serves it to `<audio>`, `<video>`, `<img>` and `fetch()`, with `Range` support for seeking. Background Fetch also stores here. The cost for large files: the Cache API can't append, so a resumable download is written twice (once as IndexedDB segments, once by the final `cache.put`), and the finished entry is opaque to your code until you read it back.

**OPFS** (`storage: 'opfs'`) is the right home for large files your code reads: AI model weights, SQLite/DuckDB databases, archives. The download is written **once**, straight into its final file, and an interrupted download resumes **in place** from its byte offset. Reading it back gives a disk-backed `File` (`collection.blob(id)`), or bytes (`collection.bytes(id)`). OPFS collections always use the fetch transport (Background Fetch can only write to the Cache API). The service worker still serves OPFS items (`offlibrarySW()`, `offlibrary/workbox`), so an OPFS file can also back a URL.

```js
const library = createOfflibrary({
  collections: {
    episodes: {},                                             // Cache API: the SW serves them to <audio>
    models: { storage: 'opfs', onStorageRefused: 'memory' },  // OPFS: your code reads the bytes
  },
});
```

Measured on a 256 MiB file in headless Chromium 156 (local server, real disk writes counted from `/proc/<pid>/io`):

| Setup | Time | Bytes written to disk |
|---|---|---|
| Hand-written worker + `createSyncAccessHandle()` (Stemina's approach) | 0.77 s | 256 MB (1×) |
| Offlibrary 0.2.0, `storage: 'opfs'` **in a dedicated worker** | 0.67 s | 256 MB (1×) |
| Same, plus `integrity: 'sha256-…'` (streaming hash) | 2.5 s | 256 MB (1×) |
| Offlibrary 0.2.0, `storage: 'opfs'` on a page | 3.8 s | 752 MB (~3×) |
| Offlibrary 0.2.0, default `storage: 'cache'`, resumable | 1.7 s | 513 MB (2×) |
| Offlibrary before 0.2.0 (checkpoints rewrote the growing segment list) | 8.8 s | 8,578 MB (33×) |

## Running in a dedicated worker

Offlibrary runs unchanged inside a dedicated `Worker` (module or classic via a bundler): it uses no `window`, `document` or service worker there. Pass `serviceWorker: false` so it doesn't look for one, and keep the download where the bytes are used:

```js
// model.worker.js
import { createOfflibrary } from 'offlibrary';
const library = createOfflibrary({
  serviceWorker: false,
  collections: { models: { storage: 'opfs', onStorageRefused: 'memory' } },
});
library.on('progress', ({ loaded, total, rate, eta }) => postMessage({ loaded, total, rate, eta }));
```

How OPFS writes are made:

- **In a dedicated worker** Offlibrary opens the file with `createSyncAccessHandle()`: writes land in place, every `write()`'s return value is checked, and a checkpoint is a `flush()`. One copy of each byte, and a crash loses at most the bytes since the last flush. `library.capabilities.syncAccessHandle` tells you this path is active.
- **On a page** (sync handles only exist in workers) it falls back to `createWritable({ keepExistingData: true })`. A writable stream only commits on `close()`, into a swap file that is copied on reopen, so Offlibrary commits on a doubling schedule (16 MiB, then whenever the uncommitted part is as big as the committed part) and on pause. That bounds the extra copying to about one file's worth, but it is still about 3× the writes and a crash can lose up to half of the progress. For files over a few hundred MB, download in a worker.
- If another context holds the file's exclusive sync handle, the worker falls back to the stream writer instead of failing. Normally that can't happen: one Web Lock per item makes sure only one tab or worker downloads it (see [Several tabs and workers](/offlibrary/concepts/events/#several-tabs-and-workers)).

## When storage says no: quota and private browsing

Storage can refuse bytes in three ways, and Offlibrary detects all of them:

1. a `QuotaExceededError` from IndexedDB, the Cache API or a writable stream;
2. a **short write**: `FileSystemSyncAccessHandle.write()` returning fewer bytes than it was given. Chromium does this instead of throwing when a private window's in-memory storage fills up, and code that ignores the count ends up with a file that is silently too short. Measured in an off-the-record Chromium 156 context: a 700 MB download got its first short write at 540,016,640 bytes (515 MiB) while `navigator.storage.estimate()` reported a 10.7 GB quota, so a quota pre-check cannot catch it;
3. a file whose size doesn't match the bytes written after a commit.

With the default `onStorageRefused: 'error'` the item fails with `quota-exceeded`. With `onStorageRefused: 'memory'`:

- the bytes already stored are read back into memory, the partial file or segments are removed, and the **download continues in memory from the same byte**, without fetching anything again;
- if the quota pre-check (`navigator.storage.estimate()`) already shows the item can't fit, it downloads to memory from the start;
- a `storage-refused` event fires with `reason` (`'quota'`, `'short-write'` or `'unavailable'`);
- the item completes with `storage: 'memory'` and `storageRefused: reason`. `collection.bytes(id)`, `blob(id)` and `match(id)` work as usual; `bytes()` returns the buffer the download filled (pre-allocated when the size is known), so there is no second copy;
- the bytes live in that library instance only. After a reload the item is gone and `download()` fetches it again. Other tabs see the item but can't read its bytes.

This is what keeps an app usable in a private window: the model still runs, it just isn't kept.

## Limits per collection

```js
createOfflibrary({
  collections: {
    episodes: { maxItems: 20 },                       // at most 20 items
    lessons: { maxBytes: 2 * 1024 ** 3 },             // at most 2 GB
    areas: { maxBytes: 300 * 1024 ** 2, evict: 'none' }, // fail instead of evicting
  },
});
```

- **Before** a download whose size is known, Offlibrary checks the collection's `maxItems` / `maxBytes` and the origin's free space (`navigator.storage.estimate()`). If needed it evicts the **least recently used completed items in that collection**.
- **After** a download completes, limits are enforced again, because sizes can turn out bigger than declared.
- An item bigger than `maxBytes` on its own throws `limit-exceeded`.
- With `evict: 'none'`, limits and quota fail with `limit-exceeded` / `quota-exceeded` instead of evicting anything.

Each eviction fires an `evict` event with `reason`: `'max-items'`, `'max-bytes'` or `'quota'`.

## What counts as "recently used"

`lastAccessedAt` is updated:

- by `collection.touch(id)` (call it when the user plays or opens the item);
- by a repeat `download()` of an item that is already stored;
- by the service worker, each time it serves the file (at most once a minute per item).

## Pinned items

`pinned: true` items are never evicted, by limits or by quota pressure. Use it for things the user explicitly saved for a trip, or for model files your app can't run without. Items that are still downloading are never evicted either. `sync(items, { prune: true })` keeps pinned items too.

## Persistent storage

```js
createOfflibrary({ persist: 'on-download', collections: { … } }); // the default
```

| `persist` | When `navigator.storage.persist()` is called |
|---|---|
| `'on-download'` (default) | On the first download |
| `'on-init'` | When the library is created |
| `'never'` | Never; call `library.storage.persist()` yourself |

How browsers answer differs: Chromium decides silently, based on engagement and whether the app is installed; Firefox shows a prompt; Safari's policy depends on its version and whether the app is on the home screen.

## Reading storage state

```js
const { usage, quota, available, supported } = await library.storage.estimate();
const persisted = await library.storage.persisted();
const { count, bytes } = await library.collection('episodes').usage(); // completed items only
```

`supported: false` means the browser didn't give numbers (all zero); downloads still work.
