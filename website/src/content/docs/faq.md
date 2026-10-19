---
title: FAQ
description: Answers to common questions about Offlibrary.
---

### Do I need a service worker?

For Background Fetch and offline `Range` serving, yes. Without one, Offlibrary still downloads (fetch transport), and you can read files with `collection.blob(id)` or `collection.match(id)`.

### Can I use it with Workbox, Vite PWA or my own service worker?

Yes. In your own worker, call `offlibrarySW()` at the top. With Workbox, including Vite PWA's `injectManifest` mode, use [`offlibrary/workbox`](/offlibrary/workbox/). If you route requests yourself, use `offlibrarySW({ serve: false })` plus `matchOfflibrary(request)`.

### Why not just use `<a download>`?

That saves a file to the Downloads folder, outside your app. Offlibrary stores files *inside* your web app, so your player, map or model loader can use them offline.

### Why is there no Background Fetch in Safari or Firefox?

They don't implement it (see [Browser support](/offlibrary/browser-support/)). Offlibrary uses the fetch transport there, with the same API and events.

### Can I pause a Background Fetch?

The spec has no pause. The browser pauses on its own when the network drops and resumes later. `pause()` throws `not-supported` for those items; `cancel()` works.

### Several Background Fetches stay at 0% for a while. Is that a bug?

In our testing Chromium ran them one after another rather than in parallel. They complete in order.

### How big can files be?

As big as the origin's quota allows (often many GB on desktop). The fetch transport joins checkpointed Blob segments at the end; browsers back large Blobs with disk, but multi-GB files are better served by Background Fetch, or by the planned OPFS backend.

### What if my feed's `size` is wrong?

Background Fetch fails when more bytes arrive than the declared `downloadTotal`. Offlibrary notices (`download-total-exceeded`) and retries once without a declared size.

### Will the browser delete my users' downloads?

It can, under storage pressure, unless storage is persistent. By default Offlibrary calls `navigator.storage.persist()` on the first download (`persist: 'on-download'`). Chromium decides silently based on engagement and installation; Firefox asks the user. See [Storage and quota](/offlibrary/concepts/storage/).

### Does it send any data anywhere?

No. Zero runtime dependencies, no telemetry, and no requests except the downloads you ask for.

### Does it work in iframes, web workers or Node?

The page module is for documents; the service-worker modules are for service workers. The unit tests run in Node with `fake-indexeddb` and a small Cache API mock.

### Is there a React or Vue adapter?

Not yet; it's on the [roadmap](https://github.com/webmaxru/offlibrary/blob/main/docs/ROADMAP.md). `subscribe()` and `snapshot()` are shaped for `useSyncExternalStore`, so a hook is a few lines: see [Events and state](/offlibrary/concepts/events/#react).
