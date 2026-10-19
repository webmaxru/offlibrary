---
title: Errors
description: OfflibraryError and its stable error codes.
sidebar:
  order: 3
---

Offlibrary throws, rejects with, and reports in `error` events an `OfflibraryError`. Match on `error.code`, never on the message.

```js
import { OfflibraryError } from 'offlibrary';

try {
  await episodes.download(ep);
} catch (error) {
  if (error instanceof OfflibraryError && error.code === 'quota-exceeded') askToFreeSpace();
  else throw error;
}
```

| Property | Type | |
|---|---|---|
| `code` | `OfflibraryErrorCode` | Stable, machine-readable reason (below) |
| `status` | `number?` | HTTP status, for `http-error` |
| `retryable` | `boolean` | Whether retrying may succeed |
| `message`, `cause` | | Human message; the underlying error when there is one |

Each `OfflibraryError` has a stable `code` (plus `status` for HTTP errors, and `retryable`):

| Code | Meaning |
|---|---|
| `invalid-config`, `invalid-item`, `unknown-collection`, `not-found` | Usage errors. The message names the problem. |
| `not-supported` | e.g. `pause()` on a Background Fetch download. |
| `quota-exceeded` | Not enough storage, even after evicting (or eviction is off). |
| `limit-exceeded` | Bigger than `maxBytes`, or limits reached with `evict: 'none'`. |
| `http-error` | Non-OK response (`error.status`). 5xx, 408 and 429 are retried. |
| `network-error` | Connection failed or ended early. Retried. |
| `opaque-response` | Cross-origin file without CORS. |
| `integrity` | Hash mismatch. Nothing was stored. |
| `download-total-exceeded` | More bytes than the declared `size` (Background Fetch). Retried once automatically. |
| `aborted`, `lost`, `unknown` | Cancelled / the browser no longer knows a Background Fetch / anything else. |

Failed items keep a serialisable copy on `item.error` (`{ code, message, status? }`) so the failure survives reloads; `collection.retry(id)` starts again.
