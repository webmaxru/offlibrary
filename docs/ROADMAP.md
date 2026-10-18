# Offlibrary roadmap

Status key: ✅ shipped in the current version · 🔜 next · 💡 idea, open for discussion.

## v0.1 (shipped in 0.1.0)

| Feature | Notes |
|---|---|
| ✅ `createOfflibrary(config)` with validated, typed collections config | `namespace`, `persist`, `resumeOnStart`, `progressInterval`, per-collection `strategy`, `backgroundFetchThreshold`, `maxItems`, `maxBytes`, `retries`, `retryDelay`, `ui`, `clickUrl`, `requestInit`, `autoSize` |
| ✅ Background Fetch transport | Deterministic IDs, `downloadTotal`, notification title/icons, live progress |
| ✅ Re-attach after reload | `getIds()` + `get(id)` reconciliation, progress resumes in the UI |
| ✅ Fallback transport | Streaming `fetch` with progress, cancel, retries with backoff |
| ✅ Resumable fallback | IndexedDB Blob segments + `Range`/`If-Range`, resumes on retry or on the next visit |
| ✅ Pause / resume (fallback) | Background Fetch has no pause in the spec, so `pause()` on a Background Fetch download reports `not-supported` |
| ✅ Multi-URL items | One item = several files (video + subtitles, a tile pack) with aggregate progress |
| ✅ Shared IndexedDB metadata + `BroadcastChannel` | All tabs and the SW agree on state |
| ✅ Typed events and `subscribe()` | `change`, `progress`, `complete`, `error`, `abort`, `evict` |
| ✅ Service-worker module | Handles `backgroundfetchsuccess/fail/abort/click`, `updateUI`, notifies pages |
| ✅ Range-request serving from cache | `206`, `416`, offline seeking of audio/video |
| ✅ Storage helpers | `estimate()`, `persist()`, `persisted()`, per-collection `usage()` |
| ✅ Quota pre-check, per-collection limits, LRU eviction, `pinned` items | |
| ✅ Integrity (`sha256/384/512`) and `version` replacement | |
| ✅ `sync(items, { prune })` | Reconcile with a feed and drop items that left it |
| ✅ Workbox-friendly SW helpers + IIFE build for `importScripts` | |
| ✅ Utilities | `formatBytes`, `isBackgroundFetchSupported`, `OfflibraryError` with stable `code`s |
| ✅ Tests | Vitest unit suite + Playwright e2e on real Background Fetch (full Chromium, headless=new) and the fallback |
| ✅ Demo podcast PWA | Public-domain LibriVox episodes, progress, cancel, delete, storage meter, offline playback, installable, GitHub Pages |
| ✅ npm readiness | `exports`, types, `files`, `sideEffects`, size budget in CI, RELEASING.md |

## v0.2: next

- 🔜 **Framework adapters** as tiny subpath exports: `offlibrary/react` (`useOfflibrary`, `useItem`), `offlibrary/vue`, `offlibrary/svelte`. All are built on `subscribe()`.
- 🔜 **Download queue with concurrency** for the fallback (`concurrency: 2`), with queued items shown as `queued`.
- 🔜 **Auto-download policies** per collection, e.g. `keep: { latest: 3 }` driven by `sync()`, plus "only on Wi-Fi" when `navigator.connection` says so (Chromium only).
- 🔜 **Expiry**: `maxAge` per collection, purged on start.
- 🔜 **Service-worker-side fallback** that keeps a fallback download running briefly after the tab closes (limited by SW lifetime), plus Background Sync to resume it.
- 🔜 **Progress notifications for the fallback** via the Notifications API (opt-in), to mirror the Background Fetch UI.

## Later

- 💡 **Storage Buckets** (Chromium 122+): one bucket per collection with `durability`/`persisted`/eviction priority. This would let the browser evict "cache-like" collections before "library-like" ones.
- 💡 **OPFS storage backend** for very large files (multi-GB): append-friendly, so no Blob joins are needed. It would be served by the SW the same way.
- 💡 **Streaming integrity**: incremental hashing so integrity doesn't require holding the file in memory, once incremental `SubtleCrypto` digest exists, or via a small WASM hasher as an optional add-on.
- 💡 **Encrypted at rest** (app-provided key) for DRM-light content.
- 💡 **HLS/DASH packs**: download every segment of a manifest as one multi-URL item, and rewrite the manifest for offline use.
- 💡 **DevTools-style debug panel** web component (`<offlibrary-inspector>`).
- 💡 **Upload counterpart** (Background Fetch supports request bodies), e.g. a queued media upload.

## Explicitly out of scope

- Precaching the app shell. Workbox already does this well; use it next to Offlibrary.
- Server components. Offlibrary is client-only and works with any static host or CDN that sends CORS headers.
