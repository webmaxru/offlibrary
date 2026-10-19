---
title: Migrating from offlibrarySW()
description: Move an existing Offlibrary service worker onto Workbox, or replace hand-written Workbox glue with offlibrary/workbox.
---

## From `offlibrarySW()` to Workbox

If your worker calls `offlibrarySW()` and you're adopting Workbox, replace the one call with the Workbox pieces:

```diff
- import { offlibrarySW } from 'offlibrary/sw';
- offlibrarySW({ onComplete });
+ import { registerRoute } from 'workbox-routing';
+ import { NetworkOnly } from 'workbox-strategies';
+ import { initOfflibrary, offlibraryMatch, offlibraryHandler } from 'offlibrary/workbox';
+
+ initOfflibrary({ onComplete });
+ registerRoute(offlibraryMatch, offlibraryHandler({ fallback: new NetworkOnly() }));
```

What maps to what:

| `offlibrarySW()` did | Now done by |
|---|---|
| Background Fetch events, notifications, page updates | `initOfflibrary()` (same options) |
| A `fetch` listener for stored files, with `Range` | `registerRoute(offlibraryMatch, offlibraryHandler())` |
| `fetch(request)` for misses | `offlibraryHandler({ fallback })`, any strategy |

Nothing changes in the page, in IndexedDB or in the caches: already downloaded files keep working, and in-flight Background Fetches finish normally.

Keep calling `initOfflibrary()` (or `offlibrarySW()`) **exactly once**. Calling both, or `offlibrarySW()` with its default `serve: true` next to Workbox routes, adds a second `fetch` listener that answers stored URLs before Workbox sees them.

## From hand-written Workbox glue (Offlibrary 0.1)

Offlibrary 0.1's README suggested this:

```js
import { registerRoute } from 'workbox-routing';
import { offlibrarySW, matchOfflibrary } from 'offlibrary/sw';

offlibrarySW({ serve: false });
registerRoute(({ request }) => request.destination === 'audio', async ({ request }) =>
  (await matchOfflibrary(request)) ?? fetch(request));
```

It still works. The 0.2 equivalent is shorter and covers more:

```js
import { registerRoute } from 'workbox-routing';
import { NetworkOnly } from 'workbox-strategies';
import { initOfflibrary, offlibraryMatch, offlibraryHandler } from 'offlibrary/workbox';

initOfflibrary();
registerRoute(offlibraryMatch, offlibraryHandler({ fallback: new NetworkOnly() }));
```

- `offlibraryMatch` matches every stored URL (video, subtitles, tiles, models, not only `audio`), plus the cold-start cases.
- Misses go to a real Workbox strategy, with its plugins, instead of a bare `fetch`.
- `initOfflibrary()` names the intent; it's the same as `offlibrarySW({ serve: false })`.

`matchOfflibrary()` and `offlibrarySW({ serve: false })` remain supported for custom routing.
