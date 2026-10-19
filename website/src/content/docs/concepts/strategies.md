---
title: Strategies
description: How Offlibrary chooses between Background Fetch and the resumable fetch fallback, and what each one does.
sidebar:
  order: 2
---

Offlibrary has two transports. The collection's `strategy` picks between them, and `item.strategy` tells you which one ran.

| `strategy` | Behaviour |
|---|---|
| `'auto'` (default) | Background Fetch if the browser supports it **and** the item is at least `backgroundFetchThreshold` bytes (default 5 MiB) or of unknown size. Otherwise streaming `fetch`. |
| `'background-fetch'` | Background Fetch whenever it's supported, regardless of size. Still falls back to `fetch` where it isn't. |
| `'fetch'` | Always the streaming fetch transport. |

If Background Fetch refuses to start, for example because no service worker is active within `serviceWorkerTimeout` (3 s by default), Offlibrary falls back to `fetch` for that item.

## How the size is known

The threshold and the quota check need a size. Pass `size` in the item if you know it (a podcast feed's `enclosure length`). Otherwise, with `autoSize: true` (the default), Offlibrary sends a `HEAD` request to read `Content-Length`. Items whose size stays unknown use Background Fetch under `'auto'`, because they might be large.

## Background Fetch

Where supported, Background Fetch hands the download to the browser:

- it keeps going when the tab or the browser closes;
- the browser shows a notification with progress, using your `ui.title` and `ui.icons`;
- when it finishes, the browser wakes your service worker, and `offlibrarySW()` (or `initOfflibrary()`) stores the files in the collection's cache, updates the notification with `ui.successTitle`, and tells every open tab.

Offlibrary passes `downloadTotal` when the size is known. If more bytes arrive than declared, the browser fails the fetch; Offlibrary reports `download-total-exceeded` and retries once without a declared size.

There is no pause in the spec: `pause()` on a Background Fetch item throws `not-supported`, while `cancel()` aborts it. Users can also cancel from the browser's download UI; that arrives as an `abort` event.

### Re-attaching after a reload

Background Fetch IDs are deterministic (`offlibrary:<namespace>/<collection>/<id>`), not random. When your page loads, Offlibrary asks the browser for its running fetches and re-attaches to them, so progress continues in the UI and nothing downloads twice. If the browser no longer knows a fetch that was marked as running, the item fails with `lost`, and `retry()` starts it again.

## The fetch fallback

Everywhere else, and for small files under `'auto'`:

1. **Streaming download.** `fetch()` in `cors` mode, read with a stream reader. `progress` events fire as bytes arrive, throttled by `progressInterval` (150 ms).
2. **Checkpoints.** Every ~4 MiB, the received bytes are written to IndexedDB as a Blob segment, with the response's `ETag` or `Last-Modified`.
3. **Resume.** After a pause, a network drop or a page reload, the request is sent with `Range: bytes=<received>-` and `If-Range: <validator>`:
   - `206` with a matching `Content-Range` → append to what's there;
   - `200` → the file changed or the server ignores ranges → start over cleanly.
4. **Retries.** Network errors, `5xx`, `408` and `429` back off exponentially (`retryDelay × 2ⁿ`, with jitter), up to `retries` (3) times.
5. **Finish.** Segments are joined into one Blob, checked against `integrity` if given, and stored in the Cache API under the original URL. The segments are then deleted.

`pause()`, `resume()` and `cancel()` all work here. Set `resumable: false` to skip the checkpoints (a failed download then starts from zero).

**The trade-off:** the fallback runs in the page, so closing the tab pauses it. On the next visit, `resumeOnStart: true` (the default) resumes it from the last checkpoint. With several tabs open, [Web Locks](https://developer.mozilla.org/docs/Web/API/Web_Locks_API) make sure only one of them downloads.

## Item lifecycle

```
download() ──▶ downloading ──▶ completed
                 │   ▲   │
         pause() │   │   │ error (after retries)
                 ▼   │   ▼
               paused  failed ──retry()──▶ downloading
```

`cancel()`, `delete()` and eviction remove the item. A completed item downloaded again with the same `version` is just marked as recently used; a different `version` downloads it again (see [Integrity and versions](/offlibrary/concepts/integrity-and-versions/)).
