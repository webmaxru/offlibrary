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
- A mismatch fails the item with `integrity`. Nothing is kept: no cache entry, no OPFS file, no partial download to resume.
- Both transports verify: the fetch transport while it downloads, and the service worker before it stores a Background Fetch result.

### Streaming SHA-256 (any size, constant memory)

WebCrypto's `crypto.subtle.digest()` only hashes a complete buffer, which would mean holding a 700 MB model in memory just to check it. When the integrity string has a `sha256-` token, the fetch transport hashes **each chunk as it arrives** with a small built-in incremental SHA-256, so memory stays flat whatever the file size.

On resume it doesn't start over either: the hash state (32 bytes plus a tail of under 64 bytes) is saved with every checkpoint, next to the byte offset it belongs to. A resumed download restores that state and only hashes the bytes written after the last checkpoint (for an OPFS file, the tail between the checkpoint and the file's real size), then continues. Nothing already verified is read twice.

Throughput is about 130 MB/s in Chromium (measured: 256 MiB in a worker went from 0.67 s to 2.5 s with integrity on, on a local server). Over a real network the hash keeps up with the download; the Hugging Face test below (353 MB, about 47 MB/s) took 8.4 s in total with verification.

`sha384` and `sha512` tokens fall back to WebCrypto over the finished file, which reads it into memory once. Prefer `sha256` for large files.

### Hugging Face gives you the hash

For files stored with Git LFS or Xet on Hugging Face, the `302` from `/resolve/` carries `X-Linked-Etag`: the file's SHA-256 as hex (the LFS object id). Turn it into an SRI string once, at build time, and pin it in your code:

```js
// node: build-time helper
const res = await fetch(url, { method: 'HEAD', redirect: 'manual' });
const hex = res.headers.get('x-linked-etag').replaceAll('"', '');
const integrity = `sha256-${Buffer.from(hex, 'hex').toString('base64')}`;
```

It's worth it for model weights, map packs and anything your code executes or parses: a truncated or tampered file then fails loudly instead of as an opaque parse error later.

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
