---
title: Collections
description: Collections group files that share a policy. They are the core of Offlibrary's configuration.
sidebar:
  order: 1
---

A **collection** is a named group of downloadable items that share a policy: podcast `episodes`, course `lessons`, map `areas`, AI `models`. You declare collections once, when you create the library:

```js
import { createOfflibrary } from 'offlibrary';

const library = createOfflibrary({
  namespace: 'podcast',
  collections: {
    episodes: { maxItems: 20 },                                  // LRU: keep the 20 most recently used
    bonus: { strategy: 'fetch', maxBytes: 500 * 1024 ** 2 },      // 500 MB cap, streaming fetch only
  },
});

const episodes = library.collection('episodes');
```

`library.collection(name)` returns a [`Collection`](/offlibrary/reference/collection/). Asking for a name that isn't in the config throws `unknown-collection`, so typos fail loudly.

## What a collection decides

| Policy | Options | Learn more |
|---|---|---|
| Which transport runs | `strategy`, `backgroundFetchThreshold` | [Strategies](/offlibrary/concepts/strategies/) |
| How much it may keep | `maxItems`, `maxBytes`, `evict` | [Storage and quota](/offlibrary/concepts/storage/) |
| How hard it tries | `retries`, `retryDelay`, `resumable` | [Strategies](/offlibrary/concepts/strategies/#the-fetch-fallback) |
| How requests are made | `requestInit`, `autoSize` | [Configuration](/offlibrary/reference/configuration/) |
| What the user sees | `ui.title`, `ui.successTitle`, `ui.failTitle`, `ui.icons`, `clickUrl` | [Configuration](/offlibrary/reference/configuration/) |

Every field is optional; `createOfflibrary` validates the config and throws `invalid-config` with a message naming the problem. The resolved policy, with defaults filled in, is on `collection.config`.

## Namespaces

`namespace` (default `'default'`) isolates IDs, caches and metadata from other Offlibrary instances on the same origin, for example two apps on one domain, or a test build. Files live in one cache per collection, named `offlibrary:<namespace>:<collection>`, keyed by their original URL. Metadata lives in the shared `offlibrary` IndexedDB database.

## Items have your IDs

Every item has an `id` you choose: an episode GUID, a lesson slug, a map area name. It is unique within its collection and stays stable across sessions, which is what lets Offlibrary:

- skip a download when the item is already stored (same `id` and `version`);
- re-attach to a running Background Fetch after a reload;
- resume a half-finished fetch download on the next visit;
- reconcile with your feed through [`sync()`](/offlibrary/concepts/sync/).

```js
await episodes.download({ id: 'ep-42', url: 'https://cdn.example.com/ep-42.mp3', title: 'Episode 42' });
episodes.peek('ep-42'); // → { id: 'ep-42', status: 'downloading', progress: 0.12, … }
```

## Typed metadata

Keep anything structured-cloneable with an item through `meta`, and type it per collection:

```ts
const episodes = library.collection<{ author: string; duration: number }>('episodes');
await episodes.download({ id: 'ep-42', url, meta: { author: 'Dickens', duration: 1820 } });
episodes.peek('ep-42')?.meta?.author; // string
```

## One state for every tab

Item metadata is stored in IndexedDB and changes are announced on a `BroadcastChannel`, so every open tab and the service worker see the same statuses and progress. Events fire in every tab; see [Events and state](/offlibrary/concepts/events/).
