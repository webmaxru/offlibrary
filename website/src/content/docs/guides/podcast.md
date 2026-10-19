---
title: Build a podcast app
description: A podcast PWA that syncs with its feed, downloads episodes with progress, keeps the latest ones and plays offline with seeking.
sidebar:
  order: 1
---

This is the shape of [Offlibrary Radio](/offlibrary/demo/), the demo app ([source](https://github.com/webmaxru/offlibrary/tree/main/demo)): a feed, a download button per episode, a storage meter, and offline playback.

## 1. Configure the collection

```js
// library.js
import { createOfflibrary } from 'offlibrary';

navigator.serviceWorker.register('/sw.js');

export const library = createOfflibrary({
  namespace: 'podcast',
  collections: {
    episodes: {
      maxItems: 10,                                   // keep the 10 most recently played
      backgroundFetchThreshold: 5 * 1024 * 1024,      // the default: Background Fetch from 5 MB
      ui: {
        icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
        successTitle: (ep) => `${ep.title} is ready to play offline`,
      },
      clickUrl: (ep) => `/#${ep.id}`,                 // tapping the notification opens the episode
    },
  },
});

export const episodes = library.collection('episodes');
```

## 2. The service worker

```js
// sw.js
import { offlibrarySW } from 'offlibrary/sw';

offlibrarySW();
// …your app-shell caching below, so the UI itself opens offline.
```

The demo adds a tiny network-first cache for its own HTML, CSS and JS after `offlibrarySW()`. Offlibrary only claims stored episode URLs, so the two don't collide.

## 3. Sync with the feed

```js
const feed = await (await fetch('/feed.json')).json();

// Update titles of stored episodes, delete the ones that left the feed (pinned ones stay).
const states = await episodes.sync(feed.items.map(({ guid, title }) => ({ id: guid, title })), { prune: true });

renderList(feed.items, states); // states[i] is undefined when not downloaded
```

## 4. Download, pause, cancel

```js
function download(ep) {
  return episodes.download({
    id: ep.guid,
    url: ep.enclosure.url,
    title: ep.title,
    size: ep.enclosure.length, // from the feed: skips a HEAD request and enables the quota check
  });
}

pauseButton.onclick = () => episodes.pause(ep.guid);   // fetch transport only
resumeButton.onclick = () => episodes.resume(ep.guid);
cancelButton.onclick = () => episodes.cancel(ep.guid);
deleteButton.onclick = () => episodes.delete(ep.guid);
```

Disable the pause button when `item.strategy === 'background-fetch'`: Background Fetch has no pause, and `pause()` throws `not-supported` there.

## 5. Render progress

```js
episodes.subscribe(() => {
  for (const item of episodes.snapshot()) {
    const row = document.getElementById(item.id);
    row.dataset.status = item.status;                 // downloading | paused | completed | failed
    row.querySelector('progress').value = item.progress ?? 0;
  }
});

library.on('error', ({ item, error }) => showError(item.id, error.code));
```

## 6. Play, online or offline

```js
function play(ep) {
  audio.src = ep.enclosure.url; // same URL either way; the SW answers from the device when stored
  audio.play();
  episodes.touch(ep.guid);      // counts as "recently used" for maxItems
}
```

Seeking works offline because the service worker answers `Range` with `206`. See [Offline playback](/offlibrary/concepts/offline-playback/).

## 7. Show storage

```js
const { usage, quota } = await library.storage.estimate();
meter.textContent = `${formatBytes(usage)} of ${formatBytes(quota)}`;
```

`formatBytes` is exported from `offlibrary`.

## Auto-download the newest episode

```js
const [latest] = feed.items;
if (!(await episodes.has(latest.guid))) download(latest);
```

With `maxItems: 10`, the least recently played episode is evicted when the eleventh arrives; mark favourites with `pinned: true` to keep them.
