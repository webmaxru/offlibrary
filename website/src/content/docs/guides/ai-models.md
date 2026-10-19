---
title: AI models and other large assets
description: Download model weights once, verify them, keep them, and load them offline.
sidebar:
  order: 4
---

On-device AI needs files measured in tens or hundreds of megabytes that must arrive intact and stay put.

```js
import { createOfflibrary } from 'offlibrary';

const models = createOfflibrary({
  collections: { models: { strategy: 'background-fetch' } },
}).collection('models');

await models.download({
  id: 'whisper-tiny-q8',
  url: 'https://cdn.example.com/models/whisper-tiny-q8.onnx',
  size: 41_234_567,          // enables the quota check before anything downloads
  integrity: 'sha256-…',     // verified before the file is stored
  pinned: true,              // never evicted by limits or quota pressure
});

await models.done('whisper-tiny-q8');
const weights = await (await models.blob('whisper-tiny-q8')).arrayBuffer();
```

Why these options:

- **`strategy: 'background-fetch'`**: in Chromium the download survives the user leaving the page; elsewhere the resumable fallback picks up where it stopped on the next visit.
- **`integrity`**: a truncated or tampered model is worse than none. A mismatch fails the item with `integrity` and stores nothing.
- **`pinned`**: models are infrastructure, not content; LRU eviction should never touch them.
- **`persist: 'on-download'`** (the default) asks the browser to make storage persistent on the first download.

Ship a new model by changing `version`: the item downloads again and the new file replaces the old one. Keep the old `id` and `version` while you don't want a re-download; repeat calls are cheap no-ops.
