# Offlibrary: analysis

_Last checked: 2026-10-18. Sources are linked inline. Statements marked **(unverified)** are my reading and were not measured._

## 1. What the original repository contained

The repo holds two commits, both called `init`, from 13 and 18 July 2022. It has no license file. Its contents:

| Path | What it was |
|---|---|
| `README.md` | Two lines: "Here comes the library to streamline building offline-first client-side asset libraries. Stay tuned!" |
| `example/client` | A Create React App podcast-style demo ("prog-web-cast"), with the library as two files in `src/lib/` |
| `example/client/src/lib/Offlibrary.js` | A config holder (`new Offlibrary(config)`, `asset(def)`) that extends `EventTarget` |
| `example/client/src/lib/OfflibraryAsset.js` | Per-asset logic: `init()` checks the cache and reads the size (HEAD or cached `content-length`), `cache()` uses Background Fetch above `bgFetchThreshold` and a plain `fetch` + `cache.put` below it, plus `delete()` and `extract()` |
| `example/client/public/service-worker.js` | Hand-written `backgroundfetchsuccess/fail/abort/click` handlers that copy records into the cache and `postMessage` the page |
| `example/server` | An Express server with five JPEGs and a JSON list; `node_modules` was committed (435 files) |

### The idea, as I read it

A small library that turns "make these assets available offline" into **configuration plus a few calls**, so an app never touches `backgroundFetch.fetch()`, `caches.open()`, `registration.matchAll()` or `updateUI()` directly. The library would:

- pick the transport: Background Fetch for big files when the browser has it, a regular fetch otherwise (`bgFetchThreshold`);
- know each asset's state (cached or not, size) and raise events when it changes;
- own the service worker side of Background Fetch.

The use case is a web-first podcast PWA that downloads episodes for offline listening.

### What the prototype left open (and what this rewrite fixes)

1. **No identity across reloads.** Background Fetch IDs were `cache/uuid`, so after a reload the app couldn't find its own in-flight downloads. The new version uses deterministic IDs (`namespace/collection/itemId`) and reconciles them with `backgroundFetch.getIds()` on start.
2. **Progress was only logged.** It never reached the UI. Completion came back as an untyped `postMessage('Hello from SW')`, and every `cache()` call added another `message` listener (a leak).
3. **No cancel, pause, resume, retry or quota handling**, and no metadata store. `cached` lived only in memory.
4. **The SW used one cache-naming scheme and the page another.** The page registered `/service-worker.js` while the config said `sw.js`. The fail handler fetched `/assets/<id>-data.json`, which didn't exist.
5. **Offline playback.** Media elements send `Range` requests, and nothing answered them from the cache. Seeking a cached episode offline would fail.
6. **Packaging.** CRA is deprecated, `node_modules` was committed, there was no license and no tests.

The 2022 example is still in git history (commit `3e14a45`). It was removed from `main` in favour of `demo/`.

## 2. Background Fetch in October 2026

### Spec and support

- **Spec:** [WICG Background Fetch](https://wicg.github.io/background-fetch/), a Community Group draft that never went to a standards track.
- **Shipped in:** Chrome/Chrome Android 74 (April 2019), Edge 79, Opera 62, Samsung Internet 11 ([MDN browser-compat-data 8.1.6](https://github.com/mdn/browser-compat-data), 2026-10-15).
- **Not shipped in:** Firefox, Safari, iOS (any browser, because iOS forces WebKit), or Android WebView.
- **Mozilla's position:** [mozilla/standards-positions#30](https://github.com/mozilla/standards-positions/issues/30), opened 2017, still labelled "under review".
- **WebKit's position:** [WebKit/standards-positions#149](https://github.com/WebKit/standards-positions/issues/149), opened 2023, labelled "concerns: privacy" and "concerns: maintenance", with no position assigned.

| Browser | Background Fetch | What Offlibrary uses |
|---|---|---|
| Chrome / Edge / Opera / Samsung (desktop + Android) | ✅ since 74 / 79 / 62 / 11 | Background Fetch (survives tab close) |
| Firefox (desktop + Android) | ❌ | Streaming fetch + Cache API, resumable |
| Safari macOS / iOS, all iOS browsers | ❌ | Streaming fetch + Cache API, resumable |
| Android WebView | ❌ | Streaming fetch + Cache API, resumable |

### Chrome nearly removed it

- **Removal proposed:** On 24 Nov 2025, Chrome posted ["Intent to Ship: deprecate BackgroundFetch"](https://groups.google.com/a/chromium.org/g/blink-dev/c/CpXXaJh5Rq8), citing use on under 0.00002% of page loads and the cost of fixing security issues.
- **Pushback:** Developers and Googlers objected. Thomas Steiner pointed to background download of large AI models, Rick Byers to compat principles ("takes away a capability which cannot be achieved by any other mechanism"), Jxck to his podcast PWA mozaic.fm, and Barry Pollard to HTTP Archive data showing about 19 sites. The thread also notes that `backgroundFetch.fetch` is used about 5× more often than the counter that was quoted.
- **Withdrawn:** On 30 Nov 2025 the intent was withdrawn: "the Background Fetch API is more critical to the web platform than its current usage metrics initially suggested".
- **Security work since then:** Chrome is bringing the API in line with normal fetch security:
  - [Local Network Access checks](https://chromestatus.com/feature/6225598451154944), milestone 154;
  - [CORS enforcement](https://chromestatus.com/feature/6210300985606144), Chrome 157 release notes.

  Chrome Stable was 155 when this was checked.

**What this means for Offlibrary:**

- Background Fetch must be a **progressive enhancement**, never a requirement.
- The fallback is a first-class path, tested as hard as the main one.
- Detection is by feature (`'backgroundFetch' in registration`), never by user agent.
- Cross-origin assets must send CORS headers. Opaque (`no-cors`) responses are rejected up front with a clear error, because from Chrome 157 they fail anyway, and they can't be measured or range-served.

### How it works (the parts a library has to get right)

- `registration.backgroundFetch.fetch(id, requests, { title, icons, downloadTotal })`:
  - starts a browser-managed download that **outlives the page and the SW**;
  - shows a system download notification;
  - pauses and resumes on its own when the connection drops;
  - IDs are unique per SW registration, and a duplicate ID rejects with `TypeError`.
- **`downloadTotal`:** if more bytes than this arrive, the fetch fails with `download-total-exceeded`; `0` means unknown. Offlibrary passes the known or HEAD-measured size, else `0`.
- **Quota:** the browser checks it up front, and a fetch that won't fit rejects with `QuotaExceededError`. Bytes in flight are held by the browser, outside the Cache API. Nothing reaches the cache until the SW copies the records in.
- **Events reach the service worker:**
  - `backgroundfetchsuccess` / `backgroundfetchfail`: records are readable only inside these handlers (`recordsAvailable`), and `event.updateUI({title, icons})` may be called once. Offlibrary copies records into the collection's cache here, checks status and integrity, updates metadata, then notifies pages.
  - `backgroundfetchabort`: the user or the app cancelled; nothing is kept.
  - `backgroundfetchclick`: the user tapped the notification; Offlibrary focuses or opens the app.
- **Progress** arrives as `progress` events on the `BackgroundFetchRegistration`, in any window that holds it (`downloaded`, `downloadTotal`, `uploaded`, `result`, `failureReason`). After a reload, `backgroundFetch.get(id)` gives you the registration back.
- **Failure reasons:**
  - `aborted`;
  - `bad-status` (any non-ok response);
  - `fetch-error`;
  - `quota-exceeded`;
  - `download-total-exceeded`.
- **No pause API.** Only `abort()`. The browser pauses by itself when the network drops.
- **Icons** must be fetchable by the browser and are optional.
- **Headless Chrome:** verified on this project's machine. Chromium 156 with `--headless=new` (the full browser) completes Background Fetch end to end, including the success event, cache writes and progress events. `chrome-headless-shell` exposes the API but never finishes a fetch. The e2e suite therefore runs the full Chromium build.

### Gotchas collected

| Gotcha | Mitigation in Offlibrary |
|---|---|
| Reload loses track of in-flight fetches when IDs are random | Deterministic IDs + `getIds()` reconciliation on start |
| `updateUI` callable once, only in success/fail | The SW handler owns it; titles come from item metadata stored at download time |
| Records gone after the event | All copying happens inside `event.waitUntil` |
| `bad-status` when one of several URLs fails | Per-item multi-URL support; nothing partial is kept, the state says which reason |
| Cross-origin without CORS (opaque) | Rejected with `OfflibraryError('opaque-response')` and a hint |
| Media seeking needs `206 Partial Content` | SW range handler slices cached blobs |
| Firefox/Safari: no API | Fallback transport (below) |
| Chrome headless-shell never completes | e2e uses full Chromium `--headless=new` |

## 3. Adjacent work surveyed (ideas, not code)

- **[Workbox](https://developer.chrome.com/docs/workbox) (MIT):**
  - `workbox-range-requests` is the reference for answering `Range` from cache; Offlibrary has its own ~40-line implementation and credits the idea.
  - `workbox-precaching`'s revisioned manifest inspired the per-item `version` field.
  - `workbox-background-sync` solves a different problem: replaying failed writes.
  - Offlibrary is meant to sit next to Workbox, so the SW module exports `matchOfflibrary`/`handleOfflibraryRequest` for use inside a Workbox route.
- **[idb-keyval](https://github.com/jakearchibald/idb-keyval) (Apache-2.0):** showed that a promise-wrapped IndexedDB layer fits in a few hundred bytes. Offlibrary has its own tiny store (one object store, two indexes) instead of a dependency.
- **[Jake Archibald's HTTP 203 podcast demo](https://web.dev/shows/http-203/cElAoxhQz6w) and the [Chrome "Introducing Background Fetch" article](https://developer.chrome.com/blog/background-fetch):** the canonical success-handler shape (match all records, `cache.put`, `updateUI`) and the "click opens the episode" pattern.
- **[web.dev, "Download AI models with the Background Fetch API"](https://web.dev/articles/background-fetch-ai):** a second big use case (multi-hundred-MB model files). It became a README recipe.
- **[Storage Buckets API](https://chromestatus.com/feature/5739224579964928) (Chromium 122+):** per-bucket quota, durability and eviction priority. It maps naturally onto collections, and is planned for later (§6).
- **Podcast PWAs (mozaic.fm, the HTTP 203 demo):** shared expectations are:
  - per-episode download with progress;
  - a storage readout;
  - delete;
  - offline playback that can seek;
  - a notification tap that opens the episode.

## 4. Concept

> **Offlibrary is a declarative offline-asset manager.** You describe *collections* of downloadable things (episodes, lessons, tile packs, models) once. Then you call `download(item)`, and Offlibrary picks the best transport, tracks progress, survives reloads, enforces storage limits, and serves the files back (with range support) when the network is gone.

Opinions baked in:

1. **Collections are the unit of policy.** Each sets its strategy, Background Fetch threshold, limits, eviction, retries and notification UI.
2. **Items have stable IDs you choose.** The episode GUID, not a random UUID.
3. **State lives in IndexedDB and is shared by page and SW.** Every tab and the SW see the same truth. Pages are told about changes through `BroadcastChannel`.
4. **The URL stays the URL.** Cached files are stored under their original request URL, and the SW serves them back. So `<audio src="https://cdn/ep1.mp3">` just works offline, with no blob URLs to manage.
5. **Background Fetch when possible, never required.**
6. **Zero runtime dependencies, small, typed, tree-shakeable.**

## 5. API design

### 5.1 Configuration

```ts
const library = createOfflibrary({
  namespace: 'podcast',            // isolates caches + IDs
  persist: 'on-download',          // 'never' | 'on-init' | 'on-download'
  collections: {
    episodes: {
      strategy: 'auto',            // 'auto' | 'background-fetch' | 'fetch'
      backgroundFetchThreshold: 5 * 1024 * 1024,
      maxItems: 20,                // optional limits → LRU eviction
      maxBytes: 1024 ** 3,
      retries: 3,
      ui: { icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }] },
      clickUrl: (item) => `/#episode/${item.id}`,
    },
  },
});
```

The config is validated eagerly, and errors name the offending key.

### 5.2 Main thread

- `library.ready`: resolves once metadata is open and in-flight downloads are re-attached.
- `library.collection(name)` returns a `Collection` with:
  - `download(item)`
  - `get(id)`, `list()`, `has(id)`
  - `cancel(id)`, `pause(id)`, `resume(id)`, `retry(id)`
  - `delete(id)`, `clear()`
  - `done(id)`
  - `match(id)`, `blob(id)`
  - `usage()`
  - `sync(items, { prune })`
  - `touch(id)`
- `library.storage`: `estimate()`, `persist()`, `persisted()`.
- `library.capabilities`: `{ serviceWorker, backgroundFetch, cacheStorage, storageEstimate, storagePersist }`.
- Events (an `EventTarget` with typed `CustomEvent`s):
  - `change`, `progress`, `complete`, `error`, `abort`, `evict`;
  - plus `library.on(type, fn)` that returns an unsubscribe function, and `library.subscribe(fn)` for "anything changed". The latter is shaped for React's `useSyncExternalStore` and similar framework stores.

### 5.3 Service worker

```js
import { offlibrarySW } from 'offlibrary/sw';
offlibrarySW();          // handles backgroundfetch* events + serves cached assets with Range support
```

- Options:
  - `serve` (default `true`);
  - `onComplete`, `onFail`;
  - `notificationTitle`.
- Lower-level exports for Workbox users:
  - `handleBackgroundFetchEvent`;
  - `matchOfflibrary(request)`;
  - `createRangeResponse(response, rangeHeader)`.
- For build-less service workers, an IIFE build exposes `self.offlibrary` via `importScripts`.

### 5.4 Framework-agnostic

The core is plain DOM APIs. Framework adapters (`offlibrary/react` `useOfflibraryItem`, Vue/Svelte stores) are planned for later. Each is about 20 lines on top of `subscribe()`, so none is needed to use the library today.

## 6. Topics

### Fallback transport (no Background Fetch)

- **How it downloads:** `fetch()` plus `ReadableStream` on the main thread, with byte progress, `AbortController` cancel, and exponential-backoff retries (`retries`, `retryDelay`).
- **Resumable:**
  - every ~4 MiB, received bytes are saved to IndexedDB as Blob segments, along with the `ETag`/`Last-Modified`;
  - on resume (manual, retry, or the next page load with `resumeOnStart`), Offlibrary sends `Range: bytes=N-` + `If-Range`;
  - a `206` with a matching `Content-Range` appends; a `200` restarts cleanly.
- **Finishing:** the segments are joined into one Blob and stored with `cache.put` under the original URL.
- **Limitation:** unlike Background Fetch, this stops when the tab closes. It resumes from the last segment on the next visit.

### Storage management

- `navigator.storage.estimate()` before a download whose size is known: if it won't fit, Offlibrary evicts LRU items in that collection (if eviction is on), otherwise it fails fast with `quota-exceeded`.
- `navigator.storage.persist()` is requested on the first download by default (`persist: 'on-download'`). Chromium grants it based on engagement; Firefox prompts.
- Per-collection `maxItems` / `maxBytes` with LRU eviction by `lastAccessedAt`. The SW range handler and `touch()` keep that up to date. `pinned` items are never evicted, and neither are items still downloading.
- `usage()` reports per-collection bytes from metadata, so you don't have to iterate caches.

### Offline playback of cached media

- The SW answers `Range: bytes=a-b` / `a-` / `-n` from the cached Blob with `206` + `Content-Range` + `Accept-Ranges`.
- An unsatisfiable range gets `416`.
- No range gets the full response.
- This makes `<audio>`/`<video>` seeking work offline (Chrome always sends `Range: bytes=0-` for media).

### Integrity and versioning

- `integrity: 'sha256-…'` per URL is checked after download, in the SW for Background Fetch and on the page for the fallback. On a mismatch, nothing is cached and the error is `integrity`.
- Note the cost: hashing reads the whole file into memory. It is optional, and intended for model files and other assets where correctness matters more than RAM.
- `version`: calling `download()` again with a new version replaces the cached copy. The same version is a no-op.

### Retries

- **Fallback:** network errors retry with backoff and resume from the last saved byte. HTTP 4xx doesn't retry; 5xx and 429 do.
- **Background Fetch:** the browser handles connectivity itself. Final failures become `failed` with the browser's reason, and `retry(id)` starts again.

### TypeScript, size, tree-shaking

- Written in TypeScript and shipped as ESM with `.d.ts`.
- `sideEffects: false`. The page entry and the SW entry are separate, so neither pulls in the other.
- Budgets, enforced in CI by `npm run size`: main ≤ 6 KB gzip, SW ≤ 3.5 KB gzip.

### Testing strategy

- **Unit (Vitest, Node):**
  - config validation;
  - ID and cache-name encoding;
  - range parsing and 206 building;
  - the metadata store (fake-indexeddb);
  - the fallback downloader with mocked streaming `fetch`, covering progress, abort, resume via `Range`, `200` restart, retries and integrity;
  - quota planning and LRU eviction;
  - SW event handlers with fake Background Fetch events.
- **E2E (Playwright + full Chromium, headless=new):**
  - real Background Fetch download → cache → `complete` event;
  - real Background Fetch abort;
  - the fallback path with progress;
  - pause → resume with a server-verified `Range` request;
  - cancel, delete;
  - SW range responses;
  - playback offline (`context.setOffline(true)`).

### Security and privacy

- No network calls except the ones the app asks for, no telemetry, no dependencies.
- Opaque responses are refused, so CORS is respected and nothing unmeasurable is stored.
- Only `GET`. Credentials follow the collection's `requestInit` (default `same-origin`).
- Metadata is the app's own data in the origin's IndexedDB, cleared together with site data.
- `clickUrl` must resolve to the SW's own origin (cross-origin values are ignored), so a notification tap can't open a foreign page.
- A Background Fetch notification shows the download title to anyone looking at the device. Titles are the app's choice, and the docs mention it.

## 7. Sources

- WICG Background Fetch spec: https://wicg.github.io/background-fetch/
- MDN Background Fetch API: https://developer.mozilla.org/en-US/docs/Web/API/Background_Fetch_API
- MDN browser-compat-data 8.1.6 (2026-10-15)
- blink-dev "Intent to Ship: deprecate BackgroundFetch" (Nov 2025, withdrawn): https://groups.google.com/a/chromium.org/g/blink-dev/c/CpXXaJh5Rq8
- Chrome status, LNA for Background Fetch: https://chromestatus.com/feature/6225598451154944
- Chrome status, CORS enforcement for Background Fetch (Chrome 157): https://chromestatus.com/feature/6210300985606144
- Mozilla position: https://github.com/mozilla/standards-positions/issues/30
- WebKit position: https://github.com/WebKit/standards-positions/issues/149
- Introducing Background Fetch: https://developer.chrome.com/blog/background-fetch
- Range requests in a SW: https://web.dev/articles/sw-range-requests
- Background Fetch for AI models: https://web.dev/articles/background-fetch-ai
- Storage Buckets: https://chromestatus.com/feature/5739224579964928
