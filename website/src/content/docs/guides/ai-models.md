---
title: Large AI model files (Stemina case study)
description: Download 300–700 MB model weights in a worker, straight into OPFS, resume exactly, survive private windows, verify them, and hand them to onnxruntime-web or Transformers.js.
sidebar:
  order: 4
---

On-device AI needs files measured in hundreds of megabytes that must arrive intact, resume when the connection drops, and stay put. This guide uses a real app as the yardstick.

## The case

[Stemina](https://github.com/webmaxru/stemina) separates music into stems in the browser with an ONNX model from Hugging Face: **353 MB** (fp16) or **701 MB** (fp32). Its requirements:

- download in a **dedicated Web Worker**, where onnxruntime-web runs;
- store the file in **OPFS** and read it back whole as a `Uint8Array` for `InferenceSession.create()`;
- **resume exactly** after a reload or a dropped connection. Hugging Face answers `/resolve/…` with a `302` to a signed CDN URL that expires after an hour; the CDN supports `Range` and `If-Range` with a stable `ETag`;
- keep working in a **private window**, where OPFS is small and in memory and writes come back short instead of failing;
- show **progress**: bytes, rate, time left, whether it resumed.

Stemina did this with about 900 lines of its own code. Offlibrary 0.2.0 covers all of it, and adds what Stemina's code didn't have: a SHA-256 check that streams, `navigator.storage.persist()`, delete/usage/eviction, and a second tab that waits instead of fighting over the file lock.

## The integration

```js
// engine.worker.js (a dedicated worker)
import { createOfflibrary } from 'offlibrary';
import * as ort from 'onnxruntime-web';

const library = createOfflibrary({
  namespace: 'stemina',
  serviceWorker: false,
  collections: { models: { storage: 'opfs', onStorageRefused: 'memory' } },
});
const models = library.collection('models');
library.on('progress', ({ loaded, total, rate, eta, resumed }) => postMessage({ type: 'progress', loaded, total, rate, eta, resumed }));
library.on('storage-refused', ({ reason }) => postMessage({ type: 'not-cached', reason }));

export async function loadModel({ dtype, url, byteLength, integrity }) {
  await models.download({ id: dtype, url, size: byteLength, integrity, pinned: true });
  await models.done(dtype); // rejects with an OfflibraryError (code, retryable) on failure
  return ort.InferenceSession.create(await models.bytes(dtype), { executionProviders: ['webgpu', 'wasm'] });
}
```

What each piece does:

- **`storage: 'opfs'`**: the model is written once, straight into `/offlibrary/stemina/models/…`. In the worker that goes through `createSyncAccessHandle()` with every write's byte count checked. An interrupted download resumes in the same file from its byte offset.
- **Resume** happens on its own: the next `download()` (or simply creating the library again, `resumeOnStart` is on by default) sends `Range: bytes=<offset>-` with `If-Range: <ETag>` to the **logical URL** you passed. The `302` to a fresh signed URL is followed every time, so an expired signature never matters. If the file changed on the server (the ETag no longer matches, the server sends `200` instead of `206`, or a different range), the download restarts cleanly from zero instead of splicing old and new bytes. Weak ETags (`W/"…"`) can't be used with `If-Range`, so they fall back to `Last-Modified` or a clean restart.
- **`onStorageRefused: 'memory'`**: in a private window, when OPFS refuses bytes, the download continues in memory from the same byte and `models.bytes()` returns that buffer. The model runs; it just isn't kept after the page closes.
- **`integrity`**: optional, but cheap. It's hashed while streaming and the hash state survives resumes. Hugging Face hands you the value: see [Hugging Face gives you the hash](/offlibrary/concepts/integrity-and-versions/#hugging-face-gives-you-the-hash).
- **`pinned: true`**: models are infrastructure, so limits and quota eviction never remove them. `persist: 'on-download'` (the default) asks for persistent storage on the first download.
- **`models.bytes(id)`** reads the OPFS file into one `Uint8Array`, the shape `InferenceSession.create()` takes. Use `models.blob(id)` for a disk-backed `File` instead (for example to stream it somewhere).

### Measured

On a 256 MiB file in headless Chromium (local server), the hand-written worker took 0.77 s and wrote 256 MB; Offlibrary with `storage: 'opfs'` in a worker took 0.67 s and wrote 256 MB. Full table: [Storage backends](/offlibrary/concepts/storage/#storage-backends-cache-or-opfs).

Against the real thing: Stemina's fp16 model from Hugging Face (353 MB), downloaded in a worker into OPFS with the SHA-256 check, the worker **killed at about 100 MB**, a new worker started: it resumed with `Range` + `If-Range` through a fresh signed redirect, verified the hash, and finished in **8.4 s** in total from a server with a fast connection. Reading the file back with `models.bytes()` took 0.5 s. (This test is in the repo: `OFFLIBRARY_E2E_HF=1 npm run test:e2e`.)

And the private-window case: a 700 MB download in an off-the-record Chromium context got a short write at 515 MiB (while `estimate()` claimed 10.7 GB of quota), moved to memory without re-fetching and completed in 11 s with `storage: 'memory'`, `storageRefused: 'short-write'` (`OFFLIBRARY_E2E_QUOTA=1 npm run test:e2e`).

## Transformers.js

Transformers.js caches model files itself (in the Cache API). To use Offlibrary's downloads instead (OPFS, resume, integrity, progress), download the files first and hand them over through Transformers.js' custom cache hook, which asks for `match(request)` and `put(request, response)`:

```js
import { env, pipeline } from '@huggingface/transformers';

const base = 'https://huggingface.co/Xenova/whisper-tiny/resolve/main/';
const files = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'preprocessor_config.json', 'generation_config.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'];
await Promise.all(files.map((f) => models.download({ id: f, url: base + f })));
await Promise.all(files.map((f) => models.done(f)));

env.useBrowserCache = false;
env.useCustomCache = true;
env.customCache = {
  match: async (request) => {
    const url = typeof request === 'string' ? request : request.url;
    const id = files.find((f) => url === base + f);
    return id ? models.match(id) : undefined; // misses go to the network as usual
  },
  put: async () => {}, // Offlibrary already stored it
};
const transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny');
```

This sketch follows Transformers.js' documented `env.customCache` contract; it hasn't been run against a specific Transformers.js release yet.

## Background Fetch for models?

Background Fetch (Chromium) keeps downloading after the user leaves the page, and Offlibrary uses it for media by default. For model files in a worker it's the wrong tool:

- it needs a service worker, and it can only store into the Cache API, not OPFS, so the file can't be resumed in place or hashed while streaming;
- it's started from a page or service worker, not from a dedicated worker;
- it does follow the `302` to a signed URL (the request is an ordinary `fetch` with redirects), and Hugging Face's CDN sends the CORS headers it needs. How Chromium resumes a Background Fetch that was interrupted for longer than the signed URL's one-hour life is **not verified**: if it retries the signed URL rather than the original one, it would get a `403` and fail, and the next attempt would start from zero.

Use `storage: 'opfs'` with the fetch transport for models. Keep Background Fetch for media the user wants to keep while they're away.
