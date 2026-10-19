---
title: Integrity and versions
description: Verify downloads with Subresource Integrity hashes and replace stored files with new versions.
sidebar:
  order: 7
---

## Integrity

Pass an [SRI](https://developer.mozilla.org/docs/Web/Security/Subresource_Integrity) string and Offlibrary checks the downloaded bytes **before anything is stored**:

```js
await models.download({
  id: 'whisper-tiny-q8',
  url: 'https://cdn.example.com/models/whisper-tiny-q8.onnx',
  integrity: 'sha256-…',
});
```

- `sha256`, `sha384` and `sha512` are supported; several hashes separated by spaces are allowed, as in SRI.
- For multi-file items, pass an array with one entry per URL (`undefined` to skip one).
- A mismatch fails the item with `integrity`. Nothing is written to the cache.
- Both transports verify: the fetch fallback before storing, and the service worker before it stores a Background Fetch result.

Hashing needs the whole file in memory, so integrity is optional. It's worth it for model weights, map packs and anything your code executes or parses.

## Versions

A stored item is identified by `id`. Downloading the same `id` again:

| Situation | What happens |
|---|---|
| Same `version` (or both unset), same URLs, already completed | Nothing is downloaded; the item is marked as recently used |
| Same `version`, paused or failed | It resumes |
| Same `version`, still downloading | You get the current state; nothing restarts |
| Different `version` or different URLs | A fresh download starts and replaces the stored copy |

```js
await areas.download({ id: 'oslo-center', urls: tiles, version: '2026-10' });
// next month
await areas.download({ id: 'oslo-center', urls: tiles, version: '2026-11' }); // downloads again
```

Use a content hash, a release date or an episode's `updated` timestamp as the version. The idea is borrowed from `workbox-precaching`'s revisioned manifests.
