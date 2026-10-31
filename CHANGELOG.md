# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). Until 1.0, minor versions may contain breaking changes, and they will be called out.

## [0.2.2] - 2026-11-01

### Added

- **`collection.adopt(item, source, { move?, signal? })`**: take over bytes that are already on this device as a completed item, without downloading them: an OPFS `FileSystemFileHandle` written by your own downloader, a `File`, a `Blob`. For apps switching to Offlibrary whose users already have a large file stored (Stemina: 353/701 MB models in its own OPFS folder).
  - `item.integrity` is verified **before** anything is touched (streaming SHA-256, constant memory); on a mismatch it throws `integrity` and the source stays where it was. `item.size` is checked too.
  - In an OPFS collection a file handle is **moved** into place with `FileSystemHandle.move()` (a rename: no second copy on disk; 15 ms for a 353 MB file in headless Chromium, 3.3 s for the whole call including the SHA-256 check). `{ move: false }`, `Blob` sources and browsers without `move()` copy instead and leave the source in place. Cache Storage collections store it with `cache.put()`.
  - Already completed with the same `version` and URLs: a no-op. A partial download or a different version of the item is replaced, as `download()` would.
  - Holds the same Web Lock a download of the item holds, so it never races a download in another tab or worker; fires `complete` and notifies other tabs.
  - New exported types `AdoptSource` and `AdoptOptions`.
- Docs: "Migrating from your own downloader" in the AI-models guide; `adopt()` in the Collection reference.

## [0.2.1] - 2026-10-31

The first 0.2.x on npm, and the first version published from GitHub Actions (npm trusted publishing, with a provenance attestation). 0.2.0 was never published to npm, so 0.2.1 contains everything listed under 0.2.0 below.

## [0.2.0] - 2026-10-20

0.2.0 was never published to npm before these changes landed, so everything below ships together in the first 0.2.0 on npm.

### Added

- **Large files and AI models** (the [Stemina case study](https://salnikov.no/offlibrary/guides/ai-models/)):
  - **`storage: 'opfs'`** collection option: files go to the Origin Private File System (`/offlibrary/<namespace>/<collection>/`), one file per URL plus a `.meta.json` sidecar (URL, ETag, Last-Modified, size, type, integrity). Written once and resumed in place at the byte offset, so there is no second copy while downloading. OPFS collections use the fetch transport; the service worker serves OPFS files too.
  - **Dedicated-worker support**: the library runs inside a `Worker` with no `window`/`document`/service-worker assumptions. In a dedicated worker OPFS writes go through `createSyncAccessHandle()` (1× disk writes, every write's byte count checked); on a page they fall back to `createWritable({ keepExistingData })`. `capabilities.opfs` and `capabilities.syncAccessHandle` report what is available.
  - **`onStorageRefused: 'error' | 'memory'`**: detects `QuotaExceededError`, short writes (Chromium's private-mode OPFS returns a short count instead of throwing) and size mismatches after a commit. With `'memory'` the download continues in memory from the same byte without re-fetching; the item completes with `storage: 'memory'` and `storageRefused`, and a new **`storage-refused`** event fires.
  - **Streaming SHA-256 integrity**: `sha256-` SRI values are hashed chunk by chunk (constant memory, about 130 MB/s), and the hash state is checkpointed with the byte offset, so a resumed download only hashes the new bytes. `sha384`/`sha512` still use WebCrypto on the finished file.
  - **`collection.bytes(id)`** and **`collection.arrayBuffer(id)`**, the shapes model runtimes take; `match()`/`blob()` work for every storage kind (OPFS returns the disk-backed `File`).
  - **Richer `progress` events**: `{ item, loaded, total, rate, eta, resumed }`, plus `item.resumed` and `item.storage`.
- **Multi-tab / multi-worker downloads**: a second context asking for an item that another one is downloading follows its progress (relayed over `BroadcastChannel`) and takes over, resuming from the stored bytes, when the owner goes away (tab closed, worker terminated). Cancelling in one tab stops the download in the tab that owns it.
- **Resume correctness**: `416` with a matching total finishes the item instead of failing; weak ETags are never sent in `If-Range`; resume state is keyed on the logical URL, so redirects to fresh signed URLs (Hugging Face's one-hour links) don't break it; a stored partial download for a different URL is discarded.
- `scripts/publish.ps1`: one-command npm release for Windows PowerShell 5.1 / PowerShell 7 (preflight, verify, pack preview, publish with OTP, registry check, tag), every registry call with an explicit `--registry`. See `RELEASING.md`.

- **`offlibrary/workbox`**, a first-class Workbox integration (new subpath export, no runtime dependency on Workbox, works with Workbox 6 and 7):
  - `OfflibraryPlugin`: a Workbox plugin. `cachedResponseWillBeUsed` serves stored files (with `206` for `Range`) inside CacheFirst, CacheOnly and NetworkFirst's cache step; `handlerDidError` makes them the offline fallback for NetworkOnly/NetworkFirst. Compatible with `RangeRequestsPlugin`.
  - `offlibraryMatch` + `offlibraryHandler({ fallback })`: a ready-made route for the common case. Misses go to any Workbox strategy or handler.
  - `initOfflibrary(options)`: Background Fetch handling without a `fetch` listener, so Workbox owns routing.
  - `dist/offlibrary-workbox.iife.js` for `workbox-sw`/`importScripts` users (`self.offlibraryWorkbox`).
  - Size budget: 4.5 KB gzip for the whole entry; the route alone is about 1.7 KB.
- `isOfflibraryRequest(request)` in `offlibrary/sw`: the synchronous routing decision `offlibrarySW()` uses.
- Documentation site: https://salnikov.no/offlibrary/ (Astro + Starlight), with guides, concepts and a generated API reference. The demo moved to https://salnikov.no/offlibrary/demo/.

### Changed

- **Resumable checkpoints are append-only.** Each 4 MiB checkpoint is one new IndexedDB segment record; the part record keeps only metadata. Before, every checkpoint rewrote the whole growing list of Blobs, so a 256 MiB download wrote 8.6 GB to disk (33×) and took 8.8 s; now it writes 513 MB (the segments plus the final `cache.put`) in 1.7 s, and 256 MB in 0.67 s with `storage: 'opfs'` in a worker. The IndexedDB schema moves to version 2; partial downloads from 0.1.x are migrated on first open.
- Size budgets: the page entry is about 17.5 KB gzip (was about 10.3 KB), the service-worker entries about 5 KB.
- The service-worker module's routing index and `matchOfflibrary()` moved into a shared internal module used by both `offlibrary/sw` and `offlibrary/workbox`. Behaviour is unchanged; the index now starts loading and listening for updates on first use, too, not only in `offlibrarySW()`.

## [0.1.0] - 2026-10-18

The first release: a full rewrite of the 2022 prototype.

### Added

- **`createOfflibrary(config)`**: validated, typed, configuration-first collections:
  - `strategy` and `backgroundFetchThreshold`;
  - `maxItems` / `maxBytes` with LRU eviction (or `evict: 'none'`);
  - `retries` / `retryDelay`;
  - `resumable`, `requestInit`, `autoSize`;
  - Background Fetch `ui` titles and icons, and `clickUrl`.
- **Background Fetch transport**:
  - deterministic IDs, so in-flight downloads are re-attached after reloads;
  - live progress;
  - `download-total-exceeded` is retried once without a declared size;
  - falls back to fetch automatically when Background Fetch refuses to start.
- **Fetch transport** for every other browser:
  - streaming progress, `pause()` / `resume()` / `cancel()`;
  - retries with exponential backoff;
  - resumable across reloads via IndexedDB segments + `Range`/`If-Range`;
  - Web Locks prevent duplicate downloads across tabs.
- **Collections API**:
  - `download`, `downloadAll`, `done`;
  - `get`/`peek`, `list`/`snapshot` (referentially stable), `has`;
  - `retry`, `delete`, `clear`, `touch`;
  - `match`/`blob`, `usage`;
  - `sync(items, { prune })`, `subscribe`.
- **Typed events**: `progress`, `complete`, `error`, `abort`, `delete`, `evict`, `click` and `change`, via `on()`, `subscribe()` or plain `EventTarget`. Pages and the service worker share state through IndexedDB + `BroadcastChannel`.
- **Storage helpers**: `storage.estimate()`, `persist()`, `persisted()`. There is a quota pre-check before downloads, and `persist: 'on-download'`.
- **Multi-URL items**, **integrity** (SRI `sha256/384/512`), **versions**, **pinned** items.
- **`offlibrary/sw`**:
  - `offlibrarySW()` stores finished Background Fetches, updates the notification, handles notification clicks (same-origin only), and serves stored files with `Range` support (`206`/`416`) for offline media seeking;
  - Workbox-friendly helpers: `matchOfflibrary`, `handleBackgroundFetchEvent`, `createRangeResponse`, `parseRange`, `verifyIntegrity`.
- **Builds**:
  - per-module ESM + `.d.ts`;
  - `dist/offlibrary.min.js` (ESM bundle);
  - `dist/offlibrary-sw.min.js`;
  - `dist/offlibrary-sw.iife.js` for `importScripts()`.
- **Utilities**: `formatBytes`, `isBackgroundFetchSupported`, `OfflibraryError` with stable `code`s.
- **Demo**: *Offlibrary Radio*, an installable podcast PWA with public-domain LibriVox episodes, deployed to GitHub Pages.
- **Tests and CI**:
  - Vitest unit tests;
  - Playwright e2e on real Chromium Background Fetch and the fetch fallback;
  - CI on Node 20/22 with a size budget.

### Removed

- The 2022 Create React App example and the Express test server, including its committed `node_modules`. They are still in git history (`3e14a45`).

[0.2.2]: https://github.com/webmaxru/offlibrary/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/webmaxru/offlibrary/compare/v0.1.0...v0.2.1
[0.2.0]: https://github.com/webmaxru/offlibrary/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/webmaxru/offlibrary/releases/tag/v0.1.0
