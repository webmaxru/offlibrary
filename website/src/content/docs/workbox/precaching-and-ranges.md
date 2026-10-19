---
title: Precaching and RangeRequestsPlugin
description: How offlibrary/workbox works next to workbox-precaching and workbox-range-requests.
---

## Precaching

`workbox-precaching` and Offlibrary store different things and don't overlap:

| | `workbox-precaching` | Offlibrary |
|---|---|---|
| What | Your app shell: HTML, JS, CSS, icons | User-chosen content: episodes, lessons, tiles, models |
| When | At service worker install, from a build-time manifest | When your code calls `download()` |
| Cache | `workbox-precache-v2-…` | `offlibrary:<namespace>:<collection>` |
| Updates | New build → new revisions | New item `version` → re-download |

Use both:

```js
import { precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { NetworkOnly } from 'workbox-strategies';
import { initOfflibrary, offlibraryMatch, offlibraryHandler } from 'offlibrary/workbox';

initOfflibrary();
precacheAndRoute(self.__WB_MANIFEST);   // the shell opens offline
registerRoute(offlibraryMatch, offlibraryHandler({ fallback: new NetworkOnly() })); // the downloads play offline
```

Don't precache large media: precaching downloads everything at install, for every user. That's exactly what Offlibrary's per-item, user-driven downloads are for.

The end-to-end test does exactly this: Workbox precaches the page and its script, Offlibrary downloads two audio files, and offline both the app (from the precache) and the audio (from Offlibrary, with seeking) work.

## RangeRequestsPlugin

[`workbox-range-requests`](https://developer.chrome.com/docs/workbox/modules/workbox-range-requests) turns a cached `200` into a `206` for `Range` requests. Offlibrary does the same for its own files, so:

- **With the [route](/offlibrary/workbox/route/)**: you don't need `RangeRequestsPlugin` for stored files. Add it to your `fallback` strategy if that strategy caches media of its own.
- **With the [plugin](/offlibrary/workbox/plugin/)**: keep both. The order doesn't matter: `RangeRequestsPlugin` passes `206` responses through untouched, and Offlibrary only acts on URLs it stores.

```js
new CacheFirst({
  cacheName: 'media',
  plugins: [new OfflibraryPlugin(), new RangeRequestsPlugin()],
});
```

Offlibrary's range handling was inspired by `workbox-range-requests` (MIT); it's an independent implementation that also answers out-of-range requests with `416`.
