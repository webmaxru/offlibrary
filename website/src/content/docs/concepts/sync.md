---
title: Syncing with a feed
description: Reconcile stored items with your source of truth using collection.sync().
sidebar:
  order: 8
---

Your app has a source of truth: an RSS feed, a course API, a list of map areas. `collection.sync()` reconciles stored items with it:

```js
const feed = await (await fetch('/feed.json')).json();

const states = await episodes.sync(
  feed.items.map(({ guid, title, author }) => ({ id: guid, title, meta: { author } })),
  { prune: true },
);
// states[i] is the stored item for feed.items[i], or undefined if it isn't downloaded
```

What it does:

- **Updates** `title` and `meta` of stored items whose values changed, emitting a `change` event with `type: 'update'`.
- **With `prune: true`**, deletes stored items whose `id` isn't in the list. Pinned items are kept.
- **Returns** the current state for each input, in order, so you can render the list with download states in one pass.

`sync()` never starts downloads; it's for bookkeeping. Combine it with your own policy, for example "keep the newest three episodes":

```js
const newest = feed.items.slice(0, 3);
await episodes.downloadAll(newest.map((ep) => ({ id: ep.guid, url: ep.enclosure.url, title: ep.title, size: ep.enclosure.length })));
```

With `maxItems: 3` on the collection, older episodes are evicted as new ones arrive.
