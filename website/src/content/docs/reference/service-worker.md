---
title: Service worker exports
description: Everything offlibrary/sw and offlibrary/workbox export, at a glance.
sidebar:
  order: 4
---

## offlibrary/sw

```js
import { offlibrarySW } from 'offlibrary/sw';
offlibrarySW();
```

| Export | Description |
|---|---|
| `offlibrarySW(options?)` | Installs the handlers. Options: `serve` (default `true`), `onComplete(item, event)`, `onFail(item, event)`, `onClick(item, event)` (return `true` to skip the default focus/open). Call it at the top level, before your other `fetch` listeners. |
| `matchOfflibrary(request)` | `Promise<Response \| undefined>`: the stored file for a request, with `Range` handled. Use it in your own routing. |
| `isOfflibraryRequest(request)` | Synchronous: would Offlibrary answer this request? Stored URL, or media/`Range` while the index loads after a worker start. |
| `handleBackgroundFetchEvent(event, options?)` | Handles one `backgroundfetch*` event. Resolves `false` for IDs that aren't Offlibrary's, so you can chain your own handling. |
| `createRangeResponse(response, rangeHeader)` / `parseRange(header, size)` | The `Range` helpers on their own. |
| `verifyIntegrity(blob, sri)` | The SRI check. |
| `OfflibraryError` | The error class. |

Without a bundler: `importScripts('https://cdn.jsdelivr.net/npm/offlibrary@0/dist/offlibrary-sw.iife.js')`, then `offlibrary.offlibrarySW()`.

## offlibrary/workbox

| Export | Description |
|---|---|
| `offlibraryMatch` | Workbox route match callback: `true` for stored files (plus media/`Range` requests while the index loads after a worker start). |
| `offlibraryHandler({ fallback })` | Workbox route handler: the stored file (`200`/`206`), else `fallback` (any strategy or handler; default `fetch`). |
| `new OfflibraryPlugin({ serveFromCache, fallbackOnError })` | Workbox plugin: `cachedResponseWillBeUsed` and `handlerDidError`. |
| `initOfflibrary(options?)` | `offlibrarySW({ ...options, serve: false })`. |
| `matchOfflibrary`, `isOfflibraryRequest` | Re-exported from `offlibrary/sw`. |

Without a bundler: `importScripts('https://cdn.jsdelivr.net/npm/offlibrary@0/dist/offlibrary-workbox.iife.js')`; the exports are on `self.offlibraryWorkbox`. Details: [Using with Workbox](/offlibrary/workbox/).
