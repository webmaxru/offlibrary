---
title: Offline map tiles
description: Download an area of map tiles as one pinned, versioned and integrity-checked item.
sidebar:
  order: 3
---

Offline maps are a perfect fit for multi-file items: an area is a few hundred small tiles that should arrive, update and disappear together.

```js
import { createOfflibrary } from 'offlibrary';

const maps = createOfflibrary({
  namespace: 'maps',
  collections: {
    areas: {
      strategy: 'fetch',                // many small files: the streaming transport is a good fit
      evict: 'none',                    // never silently drop an area the user saved
      maxBytes: 300 * 1024 ** 2,        // 300 MB for all areas
    },
  },
}).collection('areas');

const tiles = tileUrlsFor(bbox, { minZoom: 12, maxZoom: 15 }); // your helper: z/x/y URLs for the area

await maps.download({
  id: 'oslo-center',
  title: 'Oslo centre',
  urls: tiles,
  version: '2026-10',                   // bump when the tiles are re-rendered
  pinned: true,
});
```

Your map library keeps requesting tile URLs as usual. With `offlibrarySW()` (or the [Workbox route](/offlibrary/workbox/)) in your service worker, stored tiles are answered from the device; tiles outside saved areas go to the network.

## Check the tile server

- **CORS.** Tile servers must send `Access-Control-Allow-Origin`, or every tile fails with `opaque-response`.
- **Terms of use.** Bulk-downloading tiles is forbidden by many public tile servers, including the OpenStreetMap Foundation's. Use a provider whose terms allow offline use, or host your own tiles.

## Integrity for tile packs

If you publish a manifest of tile hashes, pass them per URL:

```js
await maps.download({ id: 'oslo-center', urls: tiles, integrity: tiles.map((u) => manifest[u]) });
```

A single bad tile fails the item with `integrity`, and nothing is stored.

## Updating an area

```js
await maps.download({ id: 'oslo-center', urls: tiles, version: '2026-11' }); // replaces the 2026-10 copy
```

Same `id` and `version` is a no-op (it only marks the area as recently used), so it's safe to call on every app start.

## When the area doesn't fit

With `evict: 'none'`, a download that would exceed `maxBytes` or the origin's quota throws before it starts:

```js
try {
  await maps.download(area);
} catch (error) {
  if (error.code === 'limit-exceeded' || error.code === 'quota-exceeded') offerToDeleteOldAreas();
  else throw error;
}
```
