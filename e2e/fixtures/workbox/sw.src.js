// A real Workbox service worker (bundled by the e2e test with esbuild) using offlibrary/workbox.
import { clientsClaim } from 'workbox-core';
import { precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { NetworkFirst, NetworkOnly } from 'workbox-strategies';
import { OfflibraryPlugin, initOfflibrary, offlibraryHandler, offlibraryMatch } from 'offlibrary/workbox'; // aliased to the built dist/ by the test

self.skipWaiting();
clientsClaim();

// Background Fetch events, no fetch listener: Workbox owns routing.
initOfflibrary();

// App shell, precached by Workbox.
precacheAndRoute([
  { url: 'index.html', revision: '1' },
  { url: '/dist/offlibrary.min.js', revision: '1' },
]);

// 1) An existing Workbox route that gains Offlibrary through the plugin.
registerRoute(({ url }) => url.searchParams.has('via-plugin'), new NetworkFirst({ cacheName: 'media', plugins: [new OfflibraryPlugin()] }));

// 2) The common case: stored files from the device, everything else from the network.
registerRoute(offlibraryMatch, offlibraryHandler({ fallback: new NetworkOnly() }));
