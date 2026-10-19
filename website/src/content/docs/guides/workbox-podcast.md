---
title: "Recipe: podcast PWA on Workbox"
description: A complete Workbox service worker and page for a podcast app whose episodes download with Offlibrary and play offline.
sidebar:
  order: 5
---

The [podcast guide](/offlibrary/guides/podcast/) uses `offlibrarySW()`. This is the same app on Workbox: precached shell, runtime caching for artwork, and episodes served by Offlibrary.

## Service worker

```js
// src/sw.js (built with injectManifest)
import { clientsClaim } from 'workbox-core';
import { precacheAndRoute, createHandlerBoundToURL } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { CacheFirst, NetworkOnly, StaleWhileRevalidate } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { initOfflibrary, offlibraryMatch, offlibraryHandler } from 'offlibrary/workbox';

self.skipWaiting();
clientsClaim();

// 1. Background Fetch: store finished episode downloads, update the notification.
initOfflibrary({
  onComplete: (item) => self.registration.showNotification(`${item.title} is ready offline`, { tag: item.id }),
});

// 2. The app shell.
precacheAndRoute(self.__WB_MANIFEST);
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')));

// 3. Episodes the user downloaded: from the device, with seeking. Everything else: network.
//    Registered before the artwork route so stored files are never answered by it.
const artwork = new CacheFirst({
  cacheName: 'artwork',
  plugins: [new ExpirationPlugin({ maxEntries: 300, maxAgeSeconds: 30 * 24 * 3600 })],
});
registerRoute(offlibraryMatch, offlibraryHandler({ fallback: new NetworkOnly() }));

// 4. Cover art and the feed.
registerRoute(({ request }) => request.destination === 'image', artwork);
registerRoute(({ url }) => url.pathname.endsWith('/feed.json'), new StaleWhileRevalidate({ cacheName: 'feed' }));
```

Why `NetworkOnly` as the fallback: episodes the user *didn't* download should stream from the CDN, not fill a runtime cache with 50 MB files. Artwork that happens to be requested during a cold start is matched by `offlibraryMatch` for a moment (images are a cold-start destination); if you want it to land in the `artwork` cache even then, use `offlibraryHandler({ fallback: artwork })` for a route limited to images, or see [Troubleshooting](/offlibrary/workbox/troubleshooting/).

## Page

```js
// src/main.js
import { createOfflibrary } from 'offlibrary';
import { registerSW } from 'virtual:pwa-register'; // vite-plugin-pwa; or navigator.serviceWorker.register('/sw.js')

registerSW({ immediate: true });

const library = createOfflibrary({
  namespace: 'podcast',
  collections: {
    episodes: {
      maxItems: 10,
      ui: { icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }] },
      clickUrl: (ep) => `/#${ep.id}`,
    },
  },
});
const episodes = library.collection('episodes');

export const download = (ep) =>
  episodes.download({ id: ep.guid, url: ep.enclosure.url, title: ep.title, size: ep.enclosure.length });

export function play(ep) {
  audio.src = ep.enclosure.url; // stored → device (206 for seeks); not stored → network
  audio.play();
  episodes.touch(ep.guid);
}

episodes.subscribe(() => render(episodes.snapshot()));
```

## Check it

1. Download an episode; wait for `complete`.
2. DevTools → Network → Offline. Reload: the shell comes from the precache.
3. Play the episode and seek: requests show `206` from the service worker.
4. Play an episode you didn't download: it fails offline, as it should, and streams online.
