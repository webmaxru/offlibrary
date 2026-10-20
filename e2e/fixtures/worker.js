// Dedicated module worker for e2e tests: runs code sent by the page with `ctx` (offlibrary + state).
import * as offlibrary from '/dist/offlibrary.min.js';

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const ctx = { offlibrary, events: [], state: {} };
ctx.make = (config) => {
  const lib = offlibrary.createOfflibrary(config);
  for (const type of ['progress', 'complete', 'error', 'storage-refused']) {
    lib.on(type, (d) => ctx.events.push({ type, id: d.item.id, status: d.item.status, storage: d.item.storage, downloaded: d.item.downloaded, total: d.item.total, resumed: d.resumed ?? d.item.resumed, rate: d.rate, eta: d.eta, reason: d.reason, code: d.error?.code }));
  }
  return lib;
};
ctx.sha256 = async (bytes) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))));

self.onmessage = async (e) => {
  const { id, code, arg } = e.data;
  try {
    const value = await new AsyncFunction('ctx', 'arg', code)(ctx, arg);
    self.postMessage({ id, value });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.stack || err) });
  }
};
