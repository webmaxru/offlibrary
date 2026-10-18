<div align="center">

<img src="demo/public/icons/icon-192.png" width="96" height="96" alt="" />

# Offlibrary

**Declarative offline asset management for the web.**
Download podcasts, video lessons, map tiles or AI models with one call. Background Fetch when the browser has it, a resumable streaming fallback when it doesn't, with quota, eviction and offline seeking built in.

[![CI](https://github.com/webmaxru/offlibrary/actions/workflows/ci.yml/badge.svg)](https://github.com/webmaxru/offlibrary/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/offlibrary.svg)](https://www.npmjs.com/package/offlibrary)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)

[**Live demo**](https://webmaxru.github.io/offlibrary/) · [Quick start](#quick-start) · [API](#api-reference) · [Recipes](#recipes) · [FAQ](#faq)

<img src="docs/assets/demo.gif" width="720" alt="Offlibrary Radio demo: four episodes downloading at once, two with Background Fetch and two with streaming fetch, then available offline" />

<sub>The demo app downloading four episodes: the 8 MB ones via Background Fetch, the small ones via streaming fetch. Recorded with Playwright against a throttled local server.</sub>

</div>

---

## Why

Making a file available offline on the web takes five APIs that don't know about each other: Background Fetch, service workers, the Cache API, IndexedDB and the Storage API. Then there are the edge cases nobody writes twice:

- re-attaching to a download after a reload;
- resuming a half-finished file;
- answering `Range` requests so `<audio>` can seek offline;
- staying under quota;
- falling back when the browser has no Background Fetch, which is every non-Chromium browser.

Offlibrary wraps all of it behind a **config object and one method**:

```js
const library = createOfflibrary({ collections: { episodes: { maxItems: 20 } } });

await library.collection('episodes').download({ id: 'ep-42', url: 'https://cdn.example.com/ep-42.mp3', title: 'Episode 42' });
// …later, offline:
audio.src = 'https://cdn.example.com/ep-42.mp3'; // served from the device, seeking included
```

## Features

- 🧾 **Configuration-first.** You describe *collections* (episodes, lessons, tiles…) and their policies once.
- 🛰️ **Background Fetch when available.** Downloads keep going after the tab or browser closes, with the browser's own progress notification. Offlibrary uses deterministic IDs and **re-attaches after reloads**.
- 🔁 **Resumable fallback everywhere else.** Streaming `fetch` with live progress, pause/resume, cancel and retries with backoff. Partial data is saved to IndexedDB, and downloads **resume with `Range` requests**, even after a reload.
- 🎧 **Offline media that seeks.** The service-worker module answers `Range` requests with `206 Partial Content` straight from the cache.
- 📦 **Storage management.** Quota pre-check, `navigator.storage.persist()`, per-collection `maxItems` / `maxBytes` with LRU eviction, and pinned items.
- 🧩 **Multi-file items.** A video + subtitles + thumbnail, or a map-tile pack, is one item with one progress bar.
- 🔐 **Integrity and versions.** SRI hashes (`sha256/384/512`) are checked before anything is stored, and a new `version` replaces the old copy.
- 🔔 **Typed events and `subscribe()`.** Shaped for `useSyncExternalStore`, signals or any store. Every tab and the service worker share one state.
- 🪶 **Small and dependency-free.** Written in TypeScript, ESM, tree-shakeable, about 10 KB gzipped on the page and about 4 KB in the service worker.

## Browser support

| Browser | Background Fetch | What Offlibrary does |
|---|---|---|
| Chrome, Edge, Opera, Samsung Internet (desktop + Android) | ✅ since 74 / 79 / 62 / 11 | Background Fetch: survives tab and browser close, system notification |
| Firefox (desktop + Android) | ❌ | Resumable streaming fetch |
| Safari (macOS, iOS) and every iOS browser | ❌ | Resumable streaming fetch |
| Android WebView | ❌ | Resumable streaming fetch |

**Requirements**

- Service worker, Cache API and IndexedDB. These are in every evergreen browser.
- Range serving and Background Fetch need the service-worker module.
- Without a service worker you still get downloads, progress and storage via the fetch transport.

**The state of Background Fetch**

- The spec is a [WICG draft](https://wicg.github.io/background-fetch/), implemented only in Chromium.
- Chrome proposed deprecating it in Nov 2025 and [withdrew the proposal after developer pushback](https://groups.google.com/a/chromium.org/g/blink-dev/c/CpXXaJh5Rq8).
- Since then Chrome has been bringing it in line with normal fetch security: [Local Network Access](https://chromestatus.com/feature/6225598451154944) checks, and [CORS enforcement in Chrome 157](https://chromestatus.com/feature/6210300985606144).

Offlibrary treats Background Fetch as a progressive enhancement. More in [docs/ANALYSIS.md](docs/ANALYSIS.md).

## Quick start

```bash
npm install offlibrary
```

**1. In your page:**

```js
import { createOfflibrary } from 'offlibrary';

navigator.serviceWorker.register('/sw.js');

export const library = createOfflibrary({
  namespace: 'podcast',
  collections: {
    episodes: {
      maxItems: 20,                                   // keep the 20 most recently used
      ui: { icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }] },
      clickUrl: (item) => `/episodes/${item.id}`,     // notification tap opens the episode
    },
  },
});

const episodes = library.collection('episodes');

library.on('progress', ({ item }) => render(item));   // item.progress is 0..1
library.on('complete', ({ item }) => toast(`${item.title} is ready offline`));
library.on('error', ({ item, error }) => console.warn(item.id, error.code));

downloadButton.onclick = () =>
  episodes.download({ id: ep.guid, url: ep.enclosure, title: ep.title, size: ep.length });
```

**2. In your service worker** (bundled with Vite, webpack, esbuild…):

```js
// sw.js
import { offlibrarySW } from 'offlibrary/sw';
offlibrarySW(); // stores Background Fetches, updates the notification, serves stored files with Range support
```

…or without a bundler:

```js
// sw.js
importScripts('https://cdn.jsdelivr.net/npm/offlibrary@0/dist/offlibrary-sw.iife.js');
offlibrary.offlibrarySW();
```

**3. Play it, online or offline.** Use the original URL; the service worker answers from the device when the file is stored:

```js
audio.src = ep.enclosure;
```

> **Cross-origin files** must be served with CORS (`Access-Control-Allow-Origin`), and should allow `Range` for resuming. Opaque responses are rejected with `opaque-response`, because they can't be measured, verified or range-served.

## How it works

```
                ┌───────────── page ──────────────┐            ┌──────── service worker ────────┐
download(item) ─▶ validate → size → quota/limits  │            │ offlibrarySW()                  │
                │ strategy?                       │            │                                 │
                │  ├─ Background Fetch ───────────┼── browser ─▶ backgroundfetchsuccess → cache    │
                │  │   (progress via registration)│  download  │   → IndexedDB → BroadcastChannel│
                │  └─ streaming fetch → cache     │            │ fetch: Range → 206 from cache   │
                │       (segments in IndexedDB)   │            │                                 │
                │ events ◀── BroadcastChannel ◀───┼────────────┤                                 │
                └─────────────────────────────────┘            └─────────────────────────────────┘
```

- **Metadata** (status, progress, sizes, errors, timestamps) lives in IndexedDB (`offlibrary` database), shared by every tab and the service worker. Changes are announced on a `BroadcastChannel`.
- **Files** live in the Cache API, one cache per collection (`offlibrary:<namespace>:<collection>`), keyed by their **original URL**.
- **Strategy** (`auto`): Background Fetch if the browser supports it and the item is ≥ `backgroundFetchThreshold` (default 5 MiB) or of unknown size. Otherwise streaming fetch. If Background Fetch refuses to start, for example because no service worker is active, Offlibrary falls back to fetch.
- **Item lifecycle:** `downloading → completed`, with side exits to `paused` (fetch only) and `failed` (`retry()` returns to `downloading`). `cancel()`, `delete()` and eviction remove the item.

## Configuration reference

```ts
createOfflibrary(config: OfflibraryConfig): Offlibrary
```

### `OfflibraryConfig`

| Option | Type | Default | Description |
|---|---|---|---|
| `collections` | `Record<string, CollectionConfig>` | *(required)* | Named collections. Names match `/^[A-Za-z0-9._-]+$/`. |
| `namespace` | `string` | `'default'` | Isolates IDs, caches and metadata from other instances on the origin. |
| `serviceWorker` | `ServiceWorkerRegistration \| Promise<…> \| false` | `navigator.serviceWorker.ready` | Registration used for Background Fetch. `false` = never use one (fetch transport only). |
| `serviceWorkerTimeout` | `number` (ms) | `3000` | How long to wait for an active service worker before using fetch. |
| `persist` | `'never' \| 'on-init' \| 'on-download'` | `'on-download'` | When to call `navigator.storage.persist()`. |
| `resumeOnStart` | `boolean` | `true` | Resume interrupted fetch downloads when the library starts. |
| `progressInterval` | `number` (ms) | `150` | Minimum time between `progress` events per item. |

### `CollectionConfig`

| Option | Type | Default | Description |
|---|---|---|---|
| `strategy` | `'auto' \| 'background-fetch' \| 'fetch'` | `'auto'` | Transport choice (see [How it works](#how-it-works)). `'background-fetch'` ignores the threshold but still falls back when unsupported. |
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

### `ItemInput`, what you pass to `download()`

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

## API reference

### `Offlibrary`

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

### `Collection`

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
| `match(id, url?)` / `blob(id, url?)` | `Response` / `Blob` | The stored file (the first URL by default). |
| `usage()` | `{ count, bytes }` | Completed items and their size. |
| `sync(items, { prune })` | `(OfflibraryItem \| undefined)[]` | Updates titles and meta from your feed. With `prune: true`, deletes stored items no longer in it (pinned ones are kept). |
| `touch(id)` | `Promise<OfflibraryItem>` | Marks the item as recently used. The service worker does this when it serves a file. |
| `subscribe(listener)` | `() => void` | Change listener for this collection only. Pair it with `snapshot()`. |
| `name`, `config` | | Collection name and resolved policy. |

### `OfflibraryItem` (read-only snapshot)

```ts
{
  key, namespace, collection, id, urls, title?, meta?, version?, pinned?,
  status: 'downloading' | 'paused' | 'completed' | 'failed',
  strategy: 'background-fetch' | 'fetch',
  downloaded: number, total: number /* 0 = unknown */, progress: number | null /* 0..1 */,
  bytes: number /* stored size */, error?: { code, message, status? }, attempts: number,
  createdAt, updatedAt, completedAt?, lastAccessedAt?
}
```

### Events

| Event | Detail | When |
|---|---|---|
| `progress` | `{ item }` | Bytes arrived (throttled by `progressInterval`). |
| `complete` | `{ item }` | Stored and available offline. |
| `error` | `{ item, error }` | Failed. `item.status === 'failed'`, and `error` is an `OfflibraryError`. |
| `abort` | `{ item }` | Cancelled by the app or from the browser's download UI. The item is gone. |
| `delete` | `{ item }` | Deleted. |
| `evict` | `{ item, reason }` | Removed for `max-items`, `max-bytes` or `quota`. |
| `click` | `{ item }` | The user tapped the download notification while the app was open. |
| `change` | `{ item, type }` | After every event above, plus `start`, `pause`, `resume` and `update`. |

Events fire in every open tab. Background Fetch results arrive from the service worker.

### Errors

Each `OfflibraryError` has a stable `code` (plus `status` for HTTP errors, and `retryable`):

| Code | Meaning |
|---|---|
| `invalid-config`, `invalid-item`, `unknown-collection`, `not-found` | Usage errors. The message names the problem. |
| `not-supported` | e.g. `pause()` on a Background Fetch download. |
| `quota-exceeded` | Not enough storage, even after evicting (or eviction is off). |
| `limit-exceeded` | Bigger than `maxBytes`, or limits reached with `evict: 'none'`. |
| `http-error` | Non-OK response (`error.status`). 5xx, 408 and 429 are retried. |
| `network-error` | Connection failed or ended early. Retried. |
| `opaque-response` | Cross-origin file without CORS. |
| `integrity` | Hash mismatch. Nothing was stored. |
| `download-total-exceeded` | More bytes than the declared `size` (Background Fetch). Retried once automatically. |
| `aborted`, `lost`, `unknown` | Cancelled / the browser no longer knows a Background Fetch / anything else. |

### Service worker: `offlibrary/sw`

| Export | Description |
|---|---|
| `offlibrarySW(options?)` | Installs the handlers. Options: `serve` (default `true`), `onComplete(item, event)`, `onFail(item, event)`, `onClick(item, event)` (return `true` to skip the default focus/open). Call it before your other `fetch` listeners. |
| `matchOfflibrary(request)` | `Promise<Response \| undefined>`: the stored file for a request, with `Range` handled. Use it in your own routing. |
| `handleBackgroundFetchEvent(event, options?)` | Handles one `backgroundfetch*` event. Returns `false` for IDs that aren't Offlibrary's. |
| `createRangeResponse(response, rangeHeader)` / `parseRange(header, size)` | The range helpers on their own. |
| `verifyIntegrity(blob, sri)` | SRI check helper. |

### Utilities: `offlibrary`

`formatBytes(1536) // "1.5 KB"` · `isBackgroundFetchSupported()` · `OfflibraryError`

## Recipes

### Podcast: sync with the feed, keep the latest downloads

```js
const library = createOfflibrary({
  namespace: 'podcast',
  collections: { episodes: { maxItems: 10, clickUrl: (ep) => `/#${ep.id}` } },
});
const episodes = library.collection('episodes');

const feed = await (await fetch('/feed.json')).json();
await episodes.sync(feed.items.map(({ guid, title }) => ({ id: guid, title })), { prune: true });

// auto-download the newest episode
const [latest] = feed.items;
episodes.download({ id: latest.guid, url: latest.enclosure.url, title: latest.title, size: latest.enclosure.length });

// play: same URL online and offline
player.src = latest.enclosure.url;
player.onplay = () => episodes.touch(latest.guid);
```

### Video course: one lesson = video + subtitles + poster

```js
const course = createOfflibrary({
  namespace: 'course-webperf',
  collections: { lessons: { strategy: 'background-fetch', maxBytes: 2 * 1024 ** 3 } },
}).collection('lessons');

await course.download({
  id: 'lesson-03',
  title: 'Lesson 3: Core Web Vitals',
  urls: ['/media/l03-720p.mp4', '/media/l03.en.vtt', '/media/l03-poster.jpg'],
});
// <video src="/media/l03-720p.mp4" poster="/media/l03-poster.jpg"><track src="/media/l03.en.vtt"></video>
// works offline; seeking is answered with 206 responses from the cache
```

### Map tiles: an offline area pack with integrity

```js
const maps = createOfflibrary({
  namespace: 'maps',
  collections: { areas: { strategy: 'fetch', evict: 'none', maxBytes: 300 * 1024 ** 2 } },
}).collection('areas');

const tiles = tileUrlsFor(bbox, { minZoom: 12, maxZoom: 15 }); // your helper
await maps.download({ id: 'oslo-center', title: 'Oslo centre', urls: tiles, version: '2026-10', pinned: true });
// Your map library keeps requesting tile URLs as usual; offlibrarySW() answers them from the pack.
```

### AI model: big file, integrity, never evicted

```js
const models = createOfflibrary({ collections: { models: { strategy: 'background-fetch' } } }).collection('models');

await models.download({
  id: 'whisper-tiny-q8',
  url: 'https://cdn.example.com/models/whisper-tiny-q8.onnx',
  size: 41_234_567,
  integrity: 'sha256-…',
  pinned: true,
});
const bytes = await (await models.blob('whisper-tiny-q8')).arrayBuffer();
```

### React: a hook in a few lines

```jsx
import { useSyncExternalStore } from 'react';

export function useCollection(collection) {
  return useSyncExternalStore((cb) => collection.subscribe(cb), () => collection.snapshot());
}

function Episode({ ep }) {
  const items = useCollection(episodes);
  const item = items.find((i) => i.id === ep.id);
  if (!item) return <button onClick={() => episodes.download(ep)}>Download</button>;
  if (item.status === 'completed') return <span>✓ offline</span>;
  return <progress value={item.progress ?? undefined} />;
}
```

### Workbox: route stored files yourself

```js
import { registerRoute } from 'workbox-routing';
import { offlibrarySW, matchOfflibrary } from 'offlibrary/sw';

offlibrarySW({ serve: false });                      // keep Background Fetch handling, skip routing
registerRoute(({ request }) => request.destination === 'audio', async ({ request }) =>
  (await matchOfflibrary(request)) ?? fetch(request));
```

## The fallback, in detail

When Background Fetch isn't available, isn't wanted, or refuses to start:

1. **Streaming download.** `fetch()` with `mode: 'cors'` is read with a `ReadableStream` reader, and `progress` events are emitted as bytes arrive.
2. **Checkpoints.** Every ~4 MiB, the received bytes are written to IndexedDB as a Blob segment, together with the response's `ETag`/`Last-Modified`.
3. **Resume.** After a pause, a network drop or a page reload, the request is sent with `Range: bytes=<received>-` and `If-Range: <validator>`:
   - `206` with a matching `Content-Range` → append;
   - `200` → the file changed or ranges aren't supported → start over cleanly.
4. **Retries.** Network errors, 5xx, 408 and 429 back off exponentially (`retryDelay × 2ⁿ`, with jitter), up to `retries`.
5. **Finish.** Segments are joined into one Blob, verified (`integrity`), and stored in the Cache API under the original URL. Then the segments are deleted.

**The trade-off:** the fallback runs in the page, so closing the tab pauses it. On the next visit it resumes from the last checkpoint (`resumeOnStart`). Web Locks make sure that with several tabs open, only one downloads.

## Storage and eviction

- **Before** a download whose size is known, Offlibrary checks `navigator.storage.estimate()` and the collection's `maxItems` / `maxBytes`. If needed, it evicts the least recently used completed items in *that collection*. Pinned items and items still downloading are never evicted.
- **After** a download completes, limits are enforced again (sizes can turn out bigger than declared).
- "Recently used" is updated by `touch(id)`, by a repeat `download()` of a stored item, and by the service worker each time it serves the file.
- `persist: 'on-download'` asks the browser to make storage persistent on the first download, so the browser won't evict it under pressure.
  - Chromium decides silently, based on engagement and installation.
  - Firefox shows a prompt.
  - Safari's policy depends on its version and whether the app is installed.

## Security and privacy

- **Zero runtime dependencies.** No telemetry, and no network requests except the ones you ask for.
- **CORS is respected.** Opaque responses are refused.
- Notification clicks only ever open **same-origin** URLs.
- Metadata and files stay in the origin's own storage and are cleared with site data.
- Background Fetch notifications show item titles on the device, so choose them accordingly.
- `integrity` protects against tampered or truncated files. Hashing needs the whole file in memory, so it's optional and best for model files and similar assets.

## FAQ

**Do I need a service worker?**

For Background Fetch and offline range serving, yes. Without one, Offlibrary still downloads (fetch transport) and you can read files with `collection.blob(id)` / `match(id)`.

**Can I use it with Workbox / Vite PWA / my own service worker?**

Yes. Call `offlibrarySW()` at the top of your worker. If you route requests yourself, use `offlibrarySW({ serve: false })` + `matchOfflibrary()`.

**Why not just use `<a download>`?**

That saves a file to the Downloads folder, outside your app. Offlibrary stores files *inside* your web app, so your player, map or model loader can use them offline.

**Why doesn't Background Fetch show progress in Safari/Firefox?**

They don't implement it (see [Browser support](#browser-support)). Offlibrary uses the fetch transport there, with the same events and API.

**Can I pause a Background Fetch?**

The spec has no pause. The browser pauses by itself when the network drops and resumes later. `pause()` throws `not-supported` for those items; `cancel()` works.

**Several Background Fetches stay at 0% for a while. Is that a bug?**

In our testing Chromium ran them one after another rather than in parallel. They complete in order.

**How big can files be?**

As big as the origin's quota (often many GB on desktop). For the fetch transport, very large files are joined in memory-backed Blobs at the end. Browsers back large Blobs with disk, but multi-GB files are better served by Background Fetch, or by the planned OPFS backend.

**What if my feed's `size` is wrong?**

Background Fetch fails when more bytes arrive than the declared `downloadTotal`. Offlibrary notices (`download-total-exceeded`) and retries once without a declared size.

**Does it work in iframes, workers or Node?**

It's for documents. The service-worker module is for service workers. Unit tests run in Node with `fake-indexeddb` and a small Cache API mock.

## Demo

[**webmaxru.github.io/offlibrary**](https://webmaxru.github.io/offlibrary/) shows **Offlibrary Radio**, a podcast PWA with nine public-domain short stories from [LibriVox](https://librivox.org/short-story-collection-006/), served by the Internet Archive. It shows:

- both transports side by side;
- pause/resume, cancel and delete;
- a storage meter;
- offline playback with seeking;
- installability.

Source: [`demo/`](demo/). Run it locally with `npm run demo`.

<p align="center"><img src="docs/assets/demo-mobile.png" width="300" alt="Offlibrary Radio on a phone-sized screen" /></p>

## Contributing

```bash
git clone https://github.com/webmaxru/offlibrary && cd offlibrary
npm install
npm test               # unit tests (Vitest)
npx playwright-core install chromium
npm run test:e2e       # real Background Fetch + fallback in Chromium (headless)
npm run typecheck && npm run build && npm run size
npm run check:package  # pack + install + type-check as a consumer would
npm run demo           # http://127.0.0.1:5173
```

- The e2e suite needs **full Chromium** in new headless mode. `chrome-headless-shell` exposes Background Fetch but never completes one. Set `CHROMIUM_PATH` to use a specific binary.
- Issues and PRs are welcome. Please add tests for behaviour changes and keep the size budget green.
- Design notes: [docs/ANALYSIS.md](docs/ANALYSIS.md). What's next: [docs/ROADMAP.md](docs/ROADMAP.md). Releasing: [RELEASING.md](RELEASING.md).

## License

[MIT](LICENSE) © Maxim Salnikov.

The range-request handling was inspired by [workbox-range-requests](https://developer.chrome.com/docs/workbox/modules/workbox-range-requests) (MIT); no code was copied. Demo audio: LibriVox, public domain.
