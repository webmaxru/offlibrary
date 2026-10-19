---
title: OfflibraryPlugin
description: A Workbox plugin that lets CacheFirst, CacheOnly, NetworkFirst and NetworkOnly serve files Offlibrary stored, with Range support.
---

`OfflibraryPlugin` adds Offlibrary's storage to a strategy you already have:

```js
import { registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { OfflibraryPlugin } from 'offlibrary/workbox';

registerRoute(
  ({ request }) => request.destination === 'audio' || request.destination === 'video',
  new CacheFirst({ cacheName: 'media', plugins: [new OfflibraryPlugin()] }),
);
```

It implements two [plugin callbacks](https://developer.chrome.com/docs/workbox/using-plugins):

| Callback | When Workbox calls it | What the plugin does |
|---|---|---|
| `cachedResponseWillBeUsed` | A strategy looked in its cache | If Offlibrary has the URL, returns the stored file (`206` for `Range`) instead of the cache result |
| `handlerDidError` | The strategy failed (offline, no cache entry) | If Offlibrary has the URL, returns the stored file as the response |

Requests for URLs Offlibrary doesn't store are left exactly as the strategy handles them.

## In each strategy

| Strategy | Stored by Offlibrary | Online request made? |
|---|---|---|
| `CacheFirst` | Served from the device | No |
| `CacheOnly` | Served from the device, even if the strategy's cache is empty | No |
| `NetworkFirst` | Online: from the network. Offline: from the device (via the cache step, or `handlerDidError`) | Yes, when online |
| `NetworkOnly` | Online: from the network. Offline: from the device (`handlerDidError`) | Yes, when online |
| `StaleWhileRevalidate` | Served from the device, but Workbox still revalidates in the background, downloading the whole file again | Yes, always |

For media, prefer `CacheFirst` (or the [ready-made route](/offlibrary/workbox/route/)): the user downloaded the file so it would come from the device. `StaleWhileRevalidate` defeats that, and `NetworkFirst`/`NetworkOnly` only use the download when offline.

A stored file wins over the strategy's own cache: it's the copy the user chose to keep, and its integrity was checked if you gave a hash.

## Options

```js
new OfflibraryPlugin({ serveFromCache: true, fallbackOnError: true }); // the defaults
```

| Option | Callback it enables | Set `false` to… |
|---|---|---|
| `serveFromCache` | `cachedResponseWillBeUsed` | use stored files only when the strategy fails |
| `fallbackOnError` | `handlerDidError` | keep strategy failures as failures |

## With other plugins

- **`RangeRequestsPlugin`**: keep it. Offlibrary's responses to `Range` requests are already `206`, and `RangeRequestsPlugin` passes `206` responses through untouched. See [Precaching and RangeRequestsPlugin](/offlibrary/workbox/precaching-and-ranges/).
- **`ExpirationPlugin`** only manages the strategy's own cache. Offlibrary's files follow your collection limits (`maxItems`, `maxBytes`), not Workbox expiration.
- **`CacheableResponsePlugin`** decides what Workbox writes to its cache; it doesn't affect what Offlibrary serves.

## Tested

The unit suite runs `OfflibraryPlugin` inside the real `workbox-strategies` classes (`CacheFirst`, `CacheOnly`, `NetworkFirst`, `NetworkOnly`), alone and next to `RangeRequestsPlugin` in both orders, online and offline. The end-to-end suite plays and seeks a stored file offline through a `NetworkFirst` route that uses the plugin, in a real bundled Workbox service worker.
