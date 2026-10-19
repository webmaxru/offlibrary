---
title: The route
description: offlibraryMatch and offlibraryHandler, the ready-made Workbox route for files Offlibrary stored.
---

```js
import { registerRoute } from 'workbox-routing';
import { NetworkOnly } from 'workbox-strategies';
import { offlibraryMatch, offlibraryHandler } from 'offlibrary/workbox';

registerRoute(offlibraryMatch, offlibraryHandler({ fallback: new NetworkOnly() }));
```

## offlibraryMatch

A Workbox [match callback](https://developer.chrome.com/docs/workbox/modules/workbox-routing#matching-and-handling-in-routes). It returns `true` when the request's URL is stored by Offlibrary (any collection, any namespace on the origin), ignoring the `#fragment`. It never matches navigations or non-`GET` requests.

Workbox needs this decision synchronously, so Offlibrary keeps an in-memory index of stored URLs. It is loaded from IndexedDB when the worker starts and refreshed whenever a page or the worker completes or deletes an item.

### Cold starts

Browsers stop idle service workers and start them again for the next request. In the first moments after a start, the index is still loading. During that window `offlibraryMatch` also matches:

- requests whose `destination` is `audio`, `video`, `track` or `image`;
- any request with a `Range` header.

`offlibraryHandler` then looks them up properly and passes misses to `fallback`. Without this, pressing play offline on a phone that has been asleep would miss the stored file. If you have a separate image route with its own cache, pass that strategy as the `fallback` so a cold-start miss still lands there (or see [Troubleshooting](/offlibrary/workbox/troubleshooting/)).

`isOfflibraryRequest(request)`, also exported, is the same decision for your own match callbacks.

## offlibraryHandler(options)

A Workbox route handler object (it has `handle()`, like a strategy):

1. Look the request up in Offlibrary's storage.
2. Found: answer with the file, `200`, or `206 Partial Content` (or `416`) for `Range` requests. No network request is made.
3. Not found: hand the request to `fallback`.

| Option | Type | Default |
|---|---|---|
| `fallback` | A Workbox strategy (`new NetworkOnly()`, `new CacheFirst({ cacheName: 'media' })`, …), any object with `handle()`, or a handler callback `({ request, event, url, params }) => Promise<Response>` | `fetch(request)` |

The fallback receives the same options Workbox gave the handler, so strategies behave exactly as if they were the route's handler.

```js
// Media you don't store goes to a cache-first route with expiration:
import { CacheFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

registerRoute(
  offlibraryMatch,
  offlibraryHandler({
    fallback: new CacheFirst({ cacheName: 'images', plugins: [new ExpirationPlugin({ maxEntries: 200 })] }),
  }),
);
```

## Route order

Workbox uses the **first** registered route that matches. Register the Offlibrary route before broad routes such as "every image" or "every audio file", or those routes will answer stored URLs from their own cache or the network. If you prefer to keep a broad route first, add [`OfflibraryPlugin`](/offlibrary/workbox/plugin/) to it instead.
