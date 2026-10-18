# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). Until 1.0, minor versions may contain breaking changes, and they will be called out.

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

[0.1.0]: https://github.com/webmaxru/offlibrary/releases/tag/v0.1.0
