---
title: Introduction
description: What Offlibrary is, the problem it solves, and how it is put together.
---

Offlibrary is a small TypeScript library for **making files available offline in a web app**: podcast episodes, video lessons, map tiles, documents, AI model weights. You describe *collections* of files and their policies in one config object, call `download()`, and Offlibrary takes care of the rest:

- it picks the transport: [Background Fetch](https://wicg.github.io/background-fetch/) in Chromium, a resumable streaming `fetch` everywhere else;
- it reports progress with typed events that every tab sees;
- it stores files in the Cache API under their original URL, with metadata in IndexedDB;
- it keeps you under quota with per-collection limits and LRU eviction;
- it serves stored files from your service worker, with `Range` support, so `<audio>` and `<video>` can seek offline.

## Why it exists

The web platform has every piece needed for offline media, but the pieces don't know about each other:

| Piece | What it does | What it leaves to you |
|---|---|---|
| Background Fetch | Downloads that survive closing the tab, with a system notification | Chromium-only; IDs, re-attaching after reload, storing results, updating the UI |
| Service worker + Cache API | Store responses and answer requests offline | `Range` requests (media seeking) aren't answered by `cache.match()` |
| IndexedDB | Structured, shared state | Progress, statuses and errors across tabs and the service worker |
| Storage API | `estimate()`, `persist()` | Deciding what to evict, and when |
| `fetch` + streams | Downloads with progress in every browser | Resuming, retries, checkpoints |

Offlibrary is the glue, with opinions: one config, stable IDs, a single item lifecycle (`downloading → completed`, with `paused` and `failed` side exits), and the same events whichever transport ran.

## What it is not

- **Not an app-shell cache.** Precache your HTML, JS and CSS with [Workbox](/offlibrary/workbox/) or your own service worker; Offlibrary is for the large, user-chosen files next to it.
- **Not a sync engine.** It downloads and stores files. Replaying failed writes is a different problem (see `workbox-background-sync`).
- **Not a polyfill.** Without Background Fetch, downloads run in the page and pause when it closes. They resume on the next visit.

## The pieces

| Import | Runs in | Use it for |
|---|---|---|
| `offlibrary` | the page | `createOfflibrary(config)`, collections, events, storage helpers |
| `offlibrary/sw` | your service worker | `offlibrarySW()`: Background Fetch handling and `Range` serving |
| `offlibrary/workbox` | a Workbox service worker | `OfflibraryPlugin`, `offlibraryMatch` + `offlibraryHandler`, `initOfflibrary()` |

All three are ESM, tree-shakable and typed. CDN builds (including an IIFE build for `importScripts`) ship in `dist/`.

## Where to next

- [Getting started](/offlibrary/getting-started/): install it and store your first file.
- [Collections](/offlibrary/concepts/collections/): the mental model.
- [The demo](/offlibrary/demo/): Offlibrary Radio, a podcast PWA, to see it working.
