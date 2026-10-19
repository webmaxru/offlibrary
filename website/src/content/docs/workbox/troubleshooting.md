---
title: Troubleshooting
description: Common problems when using Offlibrary with Workbox, and how to fix them.
---

### A downloaded file still comes from the network

- **Route order.** A route registered earlier (for example "all audio" with `NetworkFirst`) matched first. Register the Offlibrary route before it, or add `OfflibraryPlugin` to that route.
- **Different URL.** Files are matched by the exact URL they were downloaded from (fragments ignored, query strings not). `https://cdn.example.com/ep.mp3?token=1` and `…/ep.mp3?token=2` are different URLs. Download and play the same URL.
- **Network-first strategy.** With the plugin in `NetworkFirst` or `NetworkOnly`, stored files are only used offline. Use `CacheFirst` or the [route](/offlibrary/workbox/route/) to prefer the device.
- **Not completed yet.** Only `completed` items are served. Check `collection.peek(id)?.status`.

### Seeking doesn't work offline

- The response for a `Range` request must be `206`. In DevTools → Network, check that media requests show `206` and "(ServiceWorker)". If they show `200` from a cache, a different route answered; see above.
- Files stored without CORS can't be range-served. Offlibrary refuses opaque responses at download time (`opaque-response`), so if a download completed, this isn't the cause.

### Finished Background Fetches never show up as completed

`initOfflibrary()` isn't running in the active service worker. It must be called at the **top level** of the worker script (not inside an event handler), and the worker containing it must be the one controlling your scope. After deploying, make sure the new worker activated (`skipWaiting()`/`clientsClaim()`, or a reload).

### Images or other media bypass my own image cache right after the worker starts

During a cold start, `offlibraryMatch` claims media and `Range` requests until the index has loaded, then sends misses to `fallback`. Pass your image strategy as the fallback:

```js
registerRoute(offlibraryMatch, offlibraryHandler({ fallback: imageStrategy }));
```

Or write your own match callback with `isOfflibraryRequest()` and your own rules.

### Two `fetch` listeners answer the same request

You called `offlibrarySW()` (which adds a `fetch` listener by default) as well as Workbox routes. Use `initOfflibrary()` instead. See [Migrating](/offlibrary/workbox/migration/).

### TypeScript complains about the plugin or handler type

`offlibrary/workbox` declares structural types instead of importing Workbox's, so it works with any Workbox version. `new OfflibraryPlugin()` is assignable to `WorkboxPlugin`, `offlibraryMatch` to `RouteMatchCallback` and `offlibraryHandler()` to `RouteHandler` from `workbox-core` 7 (checked in CI). If you see an error, please [open an issue](https://github.com/webmaxru/offlibrary/issues) with your Workbox and TypeScript versions.

### workbox-sw: `self.offlibraryWorkbox` is undefined

Load `offlibrary-workbox.iife.js` (not `offlibrary-sw.iife.js`, which exposes `self.offlibrary`) with `importScripts()` before using it.
