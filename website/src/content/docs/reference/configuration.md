---
title: Configuration
description: Every option of createOfflibrary(), each collection, and each item.
sidebar:
  order: 1
---

```ts
import { createOfflibrary } from 'offlibrary';
createOfflibrary(config: OfflibraryConfig): Offlibrary
```

The config is validated when the library is created; problems throw `invalid-config` with a message that names the field. Types and TSDoc for every field are in the [generated API reference](/offlibrary/api/readme/).

## OfflibraryConfig

| Option | Type | Default | Description |
|---|---|---|---|
| `collections` | `Record<string, CollectionConfig>` | *(required)* | Named collections. Names match `/^[A-Za-z0-9._-]+$/`. |
| `namespace` | `string` | `'default'` | Isolates IDs, caches and metadata from other instances on the origin. |
| `serviceWorker` | `ServiceWorkerRegistration \| Promise<…> \| false` | `navigator.serviceWorker.ready` | Registration used for Background Fetch. `false` = never use one (fetch transport only). |
| `serviceWorkerTimeout` | `number` (ms) | `3000` | How long to wait for an active service worker before using fetch. |
| `persist` | `'never' \| 'on-init' \| 'on-download'` | `'on-download'` | When to call `navigator.storage.persist()`. |
| `resumeOnStart` | `boolean` | `true` | Resume interrupted fetch downloads when the library starts. |
| `progressInterval` | `number` (ms) | `150` | Minimum time between `progress` events per item. |

## CollectionConfig

| Option | Type | Default | Description |
|---|---|---|---|
| `strategy` | `'auto' \| 'background-fetch' \| 'fetch'` | `'auto'` | Transport choice (see [Strategies](/offlibrary/concepts/strategies/)). `'background-fetch'` ignores the threshold but still falls back when unsupported. |
| `backgroundFetchThreshold` | `number` (bytes) | `5 MiB` | Minimum size for Background Fetch under `'auto'`. |
| `autoSize` | `boolean` | `true` | Send `HEAD` requests to learn unknown sizes, for the quota check and progress. |
| `maxItems` | `number` | none | Keep at most N items. The least recently used completed items are evicted. |
| `maxBytes` | `number` | none | Keep at most N bytes. An item bigger than this throws `limit-exceeded`. |
| `evict` | `'lru' \| 'none'` | `'lru'` | `'none'` makes limits and quota fail with `limit-exceeded` / `quota-exceeded` instead of evicting. |
| `retries` | `number` | `3` | Fetch-transport retries on network errors, 5xx, 408 and 429. |
| `retryDelay` | `number` (ms) | `1000` | Base delay for exponential backoff (with jitter). |
| `resumable` | `boolean` | `true` | Save partial fetch downloads to IndexedDB so they resume after reloads. |
| `requestInit` | `{ credentials, headers, referrerPolicy, cache }` | `{ credentials: 'same-origin' }` | Extra request options for both transports. |
| `ui.title` | `(item) => string` | item title | Background Fetch notification title while downloading. |
| `ui.successTitle` | `(item) => string` | `"<title> is ready offline"` | Notification title after success. |
| `ui.failTitle` | `(item) => string` | `"<title> failed to download"` | Notification title after failure. |
| `ui.icons` | `ImageResource[]` | `[]` | Notification icons. |
| `clickUrl` | `string \| (item) => string` | SW scope | Page opened on a notification tap if no window is open. Same-origin only. |

## ItemInput

| Field | Type | Description |
|---|---|---|
| `id` | `string` | **Required.** Stable ID you choose, e.g. a GUID or slug. Unique per collection. |
| `url` / `urls` | `string` / `string[]` | **Required.** One file, or several files forming one item. Relative URLs resolve against the page. |
| `title` | `string` | Shown in the notification. |
| `size` | `number` | Total bytes, if known. Skips `HEAD`. With Background Fetch it becomes `downloadTotal`, which must not be smaller than the real size. Offlibrary retries once without it if it was. |
| `meta` | `any` (structured-cloneable) | Your data, stored with the item. |
| `integrity` | `string \| string[]` | SRI hash per URL, e.g. `sha256-…`. |
| `version` | `string` | Downloading again with a different version replaces the stored copy. |
| `icons` | `ImageResource[]` | Per-item notification icons. |
| `pinned` | `boolean` | Never evicted by limits or quota pressure. |

## Full example

```js
const library = createOfflibrary({
  namespace: 'podcast',
  persist: 'on-download',
  serviceWorkerTimeout: 3000,
  resumeOnStart: true,
  progressInterval: 150,
  collections: {
    episodes: {
      strategy: 'auto',
      backgroundFetchThreshold: 5 * 1024 * 1024,
      autoSize: true,
      maxItems: 20,
      evict: 'lru',
      retries: 3,
      retryDelay: 1000,
      resumable: true,
      requestInit: { credentials: 'same-origin' },
      ui: {
        title: (ep) => `Downloading ${ep.title}`,
        successTitle: (ep) => `${ep.title} is ready offline`,
        failTitle: (ep) => `${ep.title} failed to download`,
        icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
      },
      clickUrl: (ep) => `/#${ep.id}`,
    },
  },
});
```
