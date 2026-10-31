/**
 * collection.adopt() in real Chromium: take over a model another downloader already wrote to OPFS
 * (Stemina's migration from its own `stemina/models/` folder), without downloading it again.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { createServer } from '../scripts/serve.mjs';

let server: Awaited<ReturnType<typeof createServer>>;
let browser: Browser;
let context: BrowserContext;

beforeAll(async () => {
  server = await createServer({ root: '.' });
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    channel: process.env.CHROMIUM_PATH ? undefined : 'chromium',
    headless: true,
  });
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
});
beforeEach(async () => {
  await context?.close();
  context = await browser.newContext();
  server.requests.length = 0;
});

async function open(): Promise<Page> {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  await page.goto(`${server.origin}/e2e/fixtures/harness.html`);
  await page.waitForFunction(() => (window as any).ready === true);
  return page;
}

const redirect = (name: string) => `${server.origin}/__redirect/${name}`;
const gets = () => server.requests.filter((r: any) => r.method === 'GET' && r.path.startsWith('/__redirect/'));
const fileOf = async (name: string) => {
  const buf = Buffer.from(await (await fetch(`${server.origin}/__media/${name}`)).arrayBuffer());
  const b64 = createHash('sha256').update(buf).digest('base64');
  return { b64, sri: `sha256-${b64}`, size: buf.length };
};
const CONFIG = { namespace: 'e2e', persist: 'never', serviceWorker: false, collections: { models: { storage: 'opfs' } } };

// Writes the fixture where a hand-written downloader would have left it: /stemina/models/model.onnx.
const WRITE_LEGACY = `
  const bytes = new Uint8Array(await (await fetch(arg.media)).arrayBuffer());
  let dir = await navigator.storage.getDirectory();
  for (const n of ['stemina', 'models']) dir = await dir.getDirectoryHandle(n, { create: true });
  const h = await dir.getFileHandle('model.onnx', { create: true });
  const w = await h.createWritable(); await w.write(bytes); await w.close();
  ctx.state.legacyDir = dir;
  ctx.state.legacy = h;
  const listLegacy = async () => { const out = []; for await (const [n] of ctx.state.legacyDir.entries()) out.push(n); return out; };
  ctx.state.listLegacy = listLegacy;
`;

describe('collection.adopt() with OPFS', () => {
  it('moves an existing OPFS file into place in a worker, verified, and a later download() fetches nothing', async () => {
    const page = await open();
    const name = 'adopt-3000000.bin';
    const { sri, b64, size } = await fileOf(name);
    await page.evaluate(() => (window as any).startWorker());
    const code = WRITE_LEGACY + `
           const lib = ctx.make(arg.config);
           const models = lib.collection('models');
           const t0 = performance.now();
           const item = await models.adopt({ id: 'm', url: arg.url, size: arg.size, integrity: arg.sri, pinned: true }, ctx.state.legacy);
           const ms = performance.now() - t0;
           const again = await models.download({ id: 'm', url: arg.url, size: arg.size, integrity: arg.sri, pinned: true });
           const stored = await models.bytes('m');
           return { item, again, ms, hash: await ctx.sha256(stored), legacyLeft: await ctx.state.listLegacy() };`;
    const out = await page.evaluate(
      ([code, config, url, media, sri, size]) => (window as any).worker.run(code, { config, url, media, sri, size }),
      [code, CONFIG, redirect(name), `${server.origin}/__media/${name}`, sri, size] as const,
    );
    expect(out.item).toMatchObject({ status: 'completed', storage: 'opfs', bytes: size, pinned: true });
    expect(out.again.status).toBe('completed');
    expect(out.hash).toBe(b64);
    expect(out.legacyLeft).toEqual([]); // moved, not copied
    expect(gets().length).toBe(0); // nothing downloaded
  });

  it('leaves the source untouched when the integrity check fails', async () => {
    const page = await open();
    const name = 'adoptbad-1000000.bin';
    const { size } = await fileOf(name);
    await page.evaluate(() => (window as any).startWorker());
    const code = WRITE_LEGACY + `
           const lib = ctx.make(arg.config);
           const models = lib.collection('models');
           const wrong = 'sha256-' + btoa('x'.repeat(32));
           const err = await models.adopt({ id: 'm', url: arg.url, size: arg.size, integrity: wrong }, ctx.state.legacy).catch((e) => e);
           return { code: err && err.code, has: await models.has('m'), legacyLeft: await ctx.state.listLegacy(), legacySize: (await ctx.state.legacy.getFile()).size };`;
    const out = await page.evaluate(
      ([code, config, url, media, size]) => (window as any).worker.run(code, { config, url, media, size }),
      [code, CONFIG, redirect(name), `${server.origin}/__media/${name}`, size] as const,
    );
    expect(out).toEqual({ code: 'integrity', has: false, legacyLeft: ['model.onnx'], legacySize: size });
  });

  it('copies with { move: false } on a page and keeps the source', async () => {
    const page = await open();
    const name = 'adoptcopy-2000000.bin';
    const { sri, b64, size } = await fileOf(name);
    const out = await page.evaluate(
      async ([config, url, media, sri, size, code]) => {
        const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
        const off = (window as any).offlibrary;
        const ctx: any = { state: {} };
        await new AsyncFunction('ctx', 'arg', code)(ctx, { media });
        const lib = off.createOfflibrary(config);
        const models = lib.collection('models');
        const item = await models.adopt({ id: 'c', url, size, integrity: sri }, ctx.state.legacy, { move: false });
        const bytes = await models.bytes('c');
        const hash = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))));
        return { item, hash, legacyLeft: await ctx.state.listLegacy() };
      },
      [CONFIG, redirect(name), `${server.origin}/__media/${name}`, sri, size, WRITE_LEGACY] as const,
    );
    expect(out.item).toMatchObject({ status: 'completed', storage: 'opfs', bytes: size });
    expect(out.hash).toBe(b64);
    expect(out.legacyLeft).toEqual(['model.onnx']);
    expect(gets().length).toBe(0);
  });
});
