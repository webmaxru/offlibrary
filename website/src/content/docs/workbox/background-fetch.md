---
title: Background Fetch next to Workbox
description: initOfflibrary() handles Background Fetch events in a Workbox service worker without competing with Workbox routing.
---

In Chromium, Offlibrary downloads large files with [Background Fetch](/offlibrary/concepts/strategies/#background-fetch). When one finishes, the browser wakes the service worker with a `backgroundfetchsuccess` event, and *something* has to store the files and tell the page. In a Workbox worker, that's `initOfflibrary()`:

```js
import { initOfflibrary } from 'offlibrary/workbox';

initOfflibrary();
```

It handles:

| Event | What happens |
|---|---|
| `backgroundfetchsuccess` | Files are checked (status, CORS, `integrity`), written to the collection's cache, the item becomes `completed`, the notification shows `ui.successTitle`, and pages get a `complete` event |
| `backgroundfetchfail` | The item becomes `failed` with a mapped error code; the notification shows `ui.failTitle` |
| `backgroundfetchabort` | The user cancelled from the browser UI; the item is removed and pages get an `abort` event |
| `backgroundfetchclick` | Focuses an open app window, or opens the item's `clickUrl` (same-origin only) |

Events for Background Fetches that aren't Offlibrary's are ignored, so your own Background Fetch code can live next to it.

**It adds no `fetch` listener.** Serving stored files is left to your Workbox routes ([the route](/offlibrary/workbox/route/) or [the plugin](/offlibrary/workbox/plugin/)), so it never competes with Workbox's router. It's exactly `offlibrarySW({ ...options, serve: false })`.

## Options

The same callbacks as `offlibrarySW()`:

```js
initOfflibrary({
  onComplete: (item, event) => self.registration.showNotification(`${item.title} is ready offline`),
  onFail: (item, event) => console.warn('download failed', item.id, item.error?.code),
  onClick: (item, event) => false, // return true to skip the default focus/open
});
```

## Do I need it?

- If any collection can use Background Fetch (the default `strategy: 'auto'` does in Chromium): **yes**. Without it, finished Background Fetches are never stored.
- If every collection uses `strategy: 'fetch'`, downloads run in the page and you can skip it. Calling it anyway is harmless and keeps the routing index fresh.

Workbox has no Background Fetch module of its own (`workbox-background-sync` replays failed requests, a different job), so there's nothing to configure on the Workbox side.
