---
title: Offline playback with Range
description: How Offlibrary's service worker answers Range requests from the cache so audio and video can seek offline.
sidebar:
  order: 5
---

`<audio>` and `<video>` don't download a whole file. They ask for byte ranges (`Range: bytes=1048576-`) and expect `206 Partial Content` back, especially when the user seeks. `cache.match()` ignores `Range` and returns the full `200` response, which most browsers can't seek in. Offline playback that can't seek is not offline playback.

Offlibrary's service-worker code answers `Range` from the stored file:

| Request | Response |
|---|---|
| No `Range` | `200` with the whole file |
| `Range: bytes=start-end`, `bytes=start-`, `bytes=-suffix` | `206` with `Content-Range: bytes start-end/size` and the slice |
| A range outside the file | `416 Range Not Satisfiable` with `Content-Range: bytes */size` |

## Use the original URL

Files are stored under the URL you downloaded them from. Keep using it:

```js
audio.src = 'https://cdn.example.com/ep-42.mp3'; // online: network; stored: device
```

The service worker claims a request only when the URL is stored, so everything else, your app shell included, stays with your own handlers. URL fragments (`#t=30`) are ignored when matching.

## The service-worker side

<a id="serving"></a>

Pick one:

```js
// 1. Your own service worker: everything in one call.
import { offlibrarySW } from 'offlibrary/sw';
offlibrarySW(); // Background Fetch handling + a fetch listener for stored files

// 2. Your own routing: keep Background Fetch handling, answer requests yourself.
import { offlibrarySW, matchOfflibrary } from 'offlibrary/sw';
offlibrarySW({ serve: false });
self.addEventListener('fetch', (event) => {
  event.respondWith((async () => (await matchOfflibrary(event.request)) ?? fetch(event.request))());
});

// 3. Workbox: see "Using with Workbox".
import { initOfflibrary, offlibraryMatch, offlibraryHandler } from 'offlibrary/workbox';
```

Call `offlibrarySW()` at the top level of the worker, before your other `fetch` listeners.

## Right after the worker starts

Service workers stop when idle and restart for the next request. On a cold start, the in-memory index of stored URLs is still loading from IndexedDB, but the routing decision must be synchronous. During those first milliseconds Offlibrary claims requests whose `destination` is `audio`, `video`, `track` or `image`, and any request with a `Range` header; it then looks them up and falls through to the network if they turn out not to be stored. This is what makes "press play on an episode after the phone was in a pocket" work offline. `isOfflibraryRequest(request)` exposes the same decision.

## Without a service worker

You can still play stored files from a Blob URL:

```js
const blob = await episodes.blob('ep-42');
audio.src = URL.createObjectURL(blob);
```

Blob URLs support seeking natively, but use memory and need `URL.revokeObjectURL()`; the service-worker route is the better default.
