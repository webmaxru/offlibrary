---
title: Events and state
description: Typed events, subscribe() and snapshots for wiring Offlibrary into any UI framework.
sidebar:
  order: 6
---

Offlibrary is an event source. Every change to an item, in any tab or in the service worker, becomes a typed event in every open tab.

```js
const off = library.on('progress', ({ item }) => {
  bar.value = item.progress ?? 0; // null when the size is unknown
});
library.on('complete', ({ item }) => toast(`${item.title} is ready offline`));
library.on('error', ({ item, error }) => {
  if (error.code === 'quota-exceeded') askToFreeSpace();
});
off(); // unsubscribe
```

| Event | Detail | When |
|---|---|---|
| `progress` | `{ item }` | Bytes arrived (throttled by `progressInterval`) |
| `complete` | `{ item }` | Stored and available offline |
| `error` | `{ item, error }` | Failed; `item.status === 'failed'`, `error` is an `OfflibraryError` |
| `abort` | `{ item }` | Cancelled, by the app or from the browser's download UI. The item is gone |
| `delete` | `{ item }` | Deleted |
| `evict` | `{ item, reason }` | Removed for `max-items`, `max-bytes` or `quota` |
| `click` | `{ item }` | The user tapped the download notification while the app was open |
| `change` | `{ item, type }` | After every event above, plus `start`, `pause`, `resume` and `update` |

`Offlibrary` is also a regular `EventTarget`: `library.addEventListener('complete', (e) => e.detail.item)` works too.

## subscribe() and snapshot()

For UI state, you usually want "something changed, re-read". `subscribe()` calls you on every `change`, and `snapshot()` returns a **referentially stable** array that only changes when the collection does:

```js
const episodes = library.collection('episodes');
const unsubscribe = episodes.subscribe(() => render(episodes.snapshot()));
```

`library.subscribe()` does the same across all collections.

## React

`subscribe` + `snapshot` is the `useSyncExternalStore` contract:

```jsx
import { useSyncExternalStore } from 'react';

function useCollection(collection) {
  return useSyncExternalStore((cb) => collection.subscribe(cb), () => collection.snapshot());
}

function Episode({ ep }) {
  const items = useCollection(episodes);
  const item = items.find((i) => i.id === ep.id);
  if (!item) return <button onClick={() => episodes.download(ep)}>Download</button>;
  if (item.status === 'completed') return <span>✓ offline</span>;
  return <progress value={item.progress ?? undefined} />;
}
```

The same pattern works for Vue (`shallowRef` + `subscribe`), Svelte stores, Solid or Preact signals.

## Across tabs and the service worker

Metadata changes are written to IndexedDB and announced on a `BroadcastChannel`. Background Fetch results arrive from the service worker the same way. When a page becomes visible again, Offlibrary re-reads metadata (`library.refresh()` does it on demand).

## Service-worker callbacks

In the worker, `offlibrarySW()` and `initOfflibrary()` take callbacks for Background Fetch outcomes, for example to show your own notification:

```js
offlibrarySW({
  onComplete: (item) => self.registration.showNotification(`${item.title} is ready`),
  onFail: (item) => console.warn('failed', item.id, item.error?.code),
  onClick: (item) => false, // return true to skip the default focus/open behaviour
});
```
