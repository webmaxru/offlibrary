---
title: Browser support
description: Where Background Fetch works, what Offlibrary does elsewhere, and the dated facts behind it.
---

Offlibrary works in every evergreen browser. Background Fetch is an enhancement that only Chromium-based browsers have.

| Browser | Background Fetch | What Offlibrary does |
|---|---|---|
| Chrome (desktop + Android) | ✅ since 74 | Background Fetch: survives tab and browser close, system notification |
| Edge | ✅ since 79 | Same as Chrome |
| Opera | ✅ since 62 | Same as Chrome |
| Samsung Internet | ✅ since 11 | Same as Chrome |
| Firefox (desktop + Android) | ❌ | Resumable streaming `fetch` |
| Safari (macOS, iOS) and every iOS browser | ❌ | Resumable streaming `fetch` |
| Android WebView | ❌ | Resumable streaming `fetch` |

## Requirements

- **Service worker, Cache API, IndexedDB.** In every evergreen browser.
- **Background Fetch and `Range` serving** need the service-worker module ([`offlibrarySW()`](/offlibrary/getting-started/) or [`offlibrary/workbox`](/offlibrary/workbox/)).
- **Without a service worker** you still get downloads, progress and storage management through the fetch transport.
- **Web Locks** (all evergreen browsers) keep two tabs from downloading the same item; without them, downloads still work.
- **`storage: 'opfs'`** needs the Origin Private File System (`navigator.storage.getDirectory()`, in every evergreen browser). The fast `createSyncAccessHandle()` path exists only in dedicated workers; pages use `createWritable()`. Where OPFS is missing or refused (some private-browsing modes), `onStorageRefused: 'memory'` keeps the download working in memory; with the default `'error'` the item fails with `not-supported` or `quota-exceeded`.

## The state of Background Fetch (as of October 2026)

- The specification is a [WICG draft](https://wicg.github.io/background-fetch/), implemented only in Chromium. Firefox and Safari have not shipped it and show no public plans to.
- In November 2025 Chrome proposed deprecating it, then [withdrew the proposal after developer pushback](https://groups.google.com/a/chromium.org/g/blink-dev/c/CpXXaJh5Rq8).
- Since then Chrome has been bringing it in line with normal fetch security: [Local Network Access](https://chromestatus.com/feature/6225598451154944) checks, and [CORS enforcement in Chrome 157](https://chromestatus.com/feature/6210300985606144).

That history is why Offlibrary treats Background Fetch as a **progressive enhancement**, with a first-class fallback rather than a polyfill. Your code is the same in every browser; `item.strategy` tells you which transport ran.

## What the fallback can't do

The fetch transport runs in the page or worker that started it. Closing the tab pauses the download; the next visit (or another open tab) resumes it from the stored bytes with a `Range` request: from the last ~4 MiB checkpoint for the Cache API backend, from the file's real size for OPFS in a worker. Background Fetch keeps going with the tab closed, and Offlibrary [re-attaches](/offlibrary/concepts/strategies/#re-attaching-after-a-reload) to it after a reload.

## Tested

Every change runs the unit tests on Node 20 and 22, plus a Playwright suite in **full Chromium** (new headless mode) that drives real Background Fetch, the fetch fallback with pause/resume and reload-resume, offline seeking in `<audio>`, a real Workbox service worker, and the OPFS backend: in a dedicated worker (kill and resume through a `302` to a signed URL, simulated short writes, integrity failure), on a page (pause/resume, quota errors), and two tabs sharing one download. Two opt-in suites run against a real Hugging Face model (`OFFLIBRARY_E2E_HF=1`) and a real private-mode quota (`OFFLIBRARY_E2E_QUOTA=1`). Firefox and Safari are not covered by the automated suite. `chrome-headless-shell` exposes Background Fetch but never completes one, so the suite needs the full browser.
