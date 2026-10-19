---
title: Storage, quota, eviction and pinning
description: How Offlibrary keeps your app under quota with per-collection limits, LRU eviction, pinned items and persistent storage.
sidebar:
  order: 4
---

Browsers give each origin a storage quota, and may clear storage under pressure unless it's persistent. Offlibrary makes both explicit.

## Where files live

| What | Where |
|---|---|
| Files | Cache API, one cache per collection: `offlibrary:<namespace>:<collection>`, keyed by the original URL |
| Metadata (status, progress, sizes, errors, timestamps) | IndexedDB database `offlibrary`, shared by tabs and the service worker |
| Partial fetch downloads | IndexedDB Blob segments, deleted once the file is stored |

Everything is cleared when the user clears site data.

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
