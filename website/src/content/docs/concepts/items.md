---
title: Items and multi-file items
description: What you pass to download(), what you get back, and how one item can hold several files.
sidebar:
  order: 3
---

An **item** is one downloadable thing in a collection. You pass an `ItemInput` to `download()` and get back a read-only `OfflibraryItem` snapshot.

## Input

```ts
await collection.download({
  id: 'ep-42',                         // required, stable, unique in the collection
  url: 'https://cdn.example.com/ep-42.mp3',
  title: 'Episode 42',                 // shown in the Background Fetch notification
  size: 48_123_456,                    // optional: skips the HEAD request, enables the quota check
  meta: { author: 'Dickens' },         // optional: anything structured-cloneable
  integrity: 'sha256-…',               // optional: SRI hash, checked before storing
  version: '2026-10-01',               // optional: a new version replaces the stored copy
  pinned: true,                        // optional: never evicted
  icons: [{ src: '/ep-42.png', sizes: '192x192' }], // optional: notification icons for this item
});
```

The full field list is in the [configuration reference](/offlibrary/reference/configuration/#iteminput).

## Multi-file items

A video lesson is a video, subtitles and a poster. A map area is hundreds of tiles. Pass `urls` instead of `url`, and they become **one item with one progress bar**, one status and one `delete()`:

```js
await lessons.download({
  id: 'lesson-03',
  title: 'Lesson 3: Core Web Vitals',
  urls: ['/media/l03-720p.mp4', '/media/l03.en.vtt', '/media/l03-poster.jpg'],
});
```

Progress is aggregated over all files. Every file is stored under its own URL in the collection's cache, so `<video>`, `<track>` and `<img>` find them offline by their usual URLs. Read one file directly with `collection.match(id, url)` or `collection.blob(id, url)` (the first URL is the default).

With Background Fetch, all files go into one browser fetch with one notification. With `integrity`, pass an array with one entry per URL (`undefined` to skip a file).

## The snapshot

`download()`, `get()`, `peek()`, `list()` and every event give you an `OfflibraryItem`:

```ts
{
  key, namespace, collection, id, urls, title?, meta?, version?, pinned?,
  status: 'downloading' | 'paused' | 'completed' | 'failed',
  strategy: 'background-fetch' | 'fetch',
  downloaded: number,        // bytes so far
  total: number,             // expected bytes, 0 when unknown
  progress: number | null,   // 0..1, null when the total is unknown
  bytes: number,             // stored size once completed
  error?: { code, message, status? },
  attempts: number,
  createdAt, updatedAt, completedAt?, lastAccessedAt?
}
```

Snapshots are frozen. To react to changes, listen to [events](/offlibrary/concepts/events/) or `subscribe()`; `collection.snapshot()` returns the same array until something in the collection changes, which is exactly what `useSyncExternalStore` and signal libraries want.

## Reading and waiting

| Call | Returns |
|---|---|
| `await collection.done(id)` | The completed item; rejects with an `OfflibraryError` if it fails, pauses or is removed |
| `await collection.has(id)` | `true` when completed |
| `collection.peek(id)` | Sync snapshot (or `undefined`) |
| `await collection.match(id, url?)` | The stored `Response` |
| `await collection.blob(id, url?)` | The stored `Blob` |
