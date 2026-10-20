/**
 * OPFS backend, dedicated-worker mode, resume, storage refusal and multi-tab tests in real Chromium.
 * The local server mimics Hugging Face: /__redirect/<file> answers 302 to a fresh signed URL each time,
 * the target supports Range + If-Range with a stable ETag.
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
  server = await createServer({ root: '.', throttle: { chunk: 64 * 1024, delayMs: 25 } });
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
  page.on('console', (m) => m.type() === 'error' && console.error('[console]', m.text()));
  await page.goto(`${server.origin}/e2e/fixtures/harness.html`);
  await page.waitForFunction(() => (window as any).ready === true);
  return page;
}

const gets = () => server.requests.filter((r: any) => r.method === 'GET' && r.path.startsWith('/__redirect/'));
const redirect = (name: string) => `${server.origin}/__redirect/${name}`;
const sriOf = async (name: string) => {
  const buf = Buffer.from(await (await fetch(`${server.origin}/__media/${name}`)).arrayBuffer());
  return { sri: `sha256-${createHash('sha256').update(buf).digest('base64')}`, b64: createHash('sha256').update(buf).digest('base64'), size: buf.length };
};
const CONFIG = (extra: Record<string, unknown> = {}) => ({
  namespace: 'e2e',
  persist: 'never',
  progressInterval: 50,
  serviceWorker: false,
  collections: { models: { storage: 'opfs', retryDelay: 50, ...extra } },
});

describe('OPFS backend in a dedicated worker (Stemina shape)', () => {
  it('downloads through a 302 to a signed URL into OPFS with the sync handle, streaming integrity and rate/ETA', async () => {
    const page = await open();
    const name = 'slowfull-3000000.bin';
    const { sri, b64, size } = await sriOf(name);
    await page.evaluate(() => (window as any).startWorker());
    const out = await page.evaluate(
      ([config, url, sri]) =>
        (window as any).worker.run(
          `const lib = ctx.make(arg.config); ctx.state.lib = lib;
           const models = lib.collection('models');
           await models.download({ id: 'm1', url: arg.url, integrity: arg.sri });
           const item = await models.done('m1');
           const bytes = await models.bytes('m1');
           const root = await navigator.storage.getDirectory();
           const dir = await (await (await root.getDirectoryHandle('offlibrary')).getDirectoryHandle('e2e')).getDirectoryHandle('models');
           const names = []; for await (const [n] of dir.entries()) names.push(n);
           const metaName = names.find((n) => n.endsWith('.meta.json'));
           const meta = JSON.parse(await (await (await dir.getFileHandle(metaName)).getFile()).text());
           return { item, caps: lib.capabilities, hash: await ctx.sha256(bytes), names, meta, events: ctx.events };`,
          { config, url, sri },
        ),
      [CONFIG(), redirect(name), sri] as const,
    );
    expect(out.caps.syncAccessHandle).toBe(true);
    expect(out.item).toMatchObject({ status: 'completed', storage: 'opfs', bytes: size });
    expect(out.hash).toBe(b64);
    expect(out.names.sort()).toEqual([expect.stringMatching(/^m1~.*\.0\.bin$/), expect.stringMatching(/\.0\.bin\.meta\.json$/)]);
    expect(out.meta).toMatchObject({ url: redirect(name), etag: `"${name}"`, size, integrity: sri, complete: true });
    const progress = out.events.filter((e: any) => e.type === 'progress');
    expect(progress.length).toBeGreaterThan(3);
    expect(progress.some((e: any) => typeof e.rate === 'number' && e.rate > 0 && typeof e.eta === 'number')).toBe(true);
    // Redirected once, never followed with a Range (fresh download).
    expect(gets().length).toBe(1);
  });

  it('resumes exactly after the worker is killed mid-download (Range + If-Range on the logical URL)', async () => {
    const page = await open();
    const name = 'slowkill-5000000.bin';
    const { sri, b64, size } = await sriOf(name);
    await page.evaluate(() => (window as any).startWorker());
    await page.evaluate(
      ([config, url, sri]) =>
        (window as any).worker.run(
          `const lib = ctx.make(arg.config); ctx.state.lib = lib;
           await lib.collection('models').download({ id: 'k1', url: arg.url, integrity: arg.sri });`,
          { config, url, sri },
        ),
      [CONFIG(), redirect(name), sri] as const,
    );
    for (let i = 0; i < 200; i++) {
      const d = await page.evaluate(() => (window as any).worker.run(`return ctx.state.lib.collection('models').peek('k1')?.downloaded ?? 0`));
      if (d > 1_500_000) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await page.evaluate(() => (window as any).worker.terminate()); // kill: no cleanup runs
    await page.evaluate(() => (window as any).startWorker());
    const out = await page.evaluate(
      ([config]) =>
        (window as any).worker.run(
          `const lib = ctx.make(arg.config); await lib.ready; // resumeOnStart picks it up
           const models = lib.collection('models');
           const before = models.peek('k1');
           const item = await models.done('k1');
           return { before, item, hash: await ctx.sha256(await models.bytes('k1')), events: ctx.events };`,
          { config },
        ),
      [CONFIG()] as const,
    );
    expect(out.before.status).toBe('downloading');
    if (out.item.resumed !== true) console.log('kill/resume item', JSON.stringify(out.item), JSON.stringify(server.requests));
    expect(out.item).toMatchObject({ status: 'completed', storage: 'opfs', bytes: size, resumed: true });
    expect(out.hash).toBe(b64);
    const g = gets();
    expect(g.length).toBe(2);
    expect(g[1].range).toMatch(/^bytes=\d+-$/);
    expect(Number(/bytes=(\d+)-/.exec(g[1].range)![1])).toBeGreaterThan(1_000_000);
    expect(g[1].ifRange).toBe(`"${name}"`);
    expect(out.events.some((e: any) => e.type === 'progress' && e.resumed)).toBe(true);
  });

  it('short writes (incognito-style) → finishes in memory with onStorageRefused: "memory"', async () => {
    const page = await open();
    const name = 'short-3000000.bin';
    const { sri, b64, size } = await sriOf(name);
    await page.evaluate(() => (window as any).startWorker());
    const out = await page.evaluate(
      ([config, url, sri]) =>
        (window as any).worker.run(
          `// Chromium's private-mode OPFS returns a short count instead of throwing when it is full.
           let budget = 1_000_000;
           const orig = FileSystemSyncAccessHandle.prototype.write;
           FileSystemSyncAccessHandle.prototype.write = function (buf, opts) {
             if (budget <= 0) return 0;
             const n = Math.min(buf.byteLength, budget);
             budget -= n;
             return orig.call(this, n === buf.byteLength ? buf : buf.subarray(0, n), opts);
           };
           const lib = ctx.make(arg.config);
           const models = lib.collection('models');
           await models.download({ id: 's1', url: arg.url, integrity: arg.sri });
           const item = await models.done('s1');
           const bytes = await models.bytes('s1');
           const root = await navigator.storage.getDirectory();
           const dir = await (await (await root.getDirectoryHandle('offlibrary')).getDirectoryHandle('e2e')).getDirectoryHandle('models');
           const names = []; for await (const [n] of dir.entries()) names.push(n);
           return { item, hash: await ctx.sha256(bytes), isU8: bytes instanceof Uint8Array, names, refused: ctx.events.filter((e) => e.type === 'storage-refused') };`,
          { config, url, sri },
        ),
      [CONFIG({ onStorageRefused: 'memory' }), redirect(name), sri] as const,
    );
    expect(out.item).toMatchObject({ status: 'completed', storage: 'memory', storageRefused: 'short-write', bytes: size });
    expect(out.hash).toBe(b64);
    expect(out.isU8).toBe(true);
    expect(out.names).toEqual([]); // the partial file was moved to memory and removed
    expect(out.refused).toEqual([expect.objectContaining({ reason: 'short-write' })]);
    // Nothing was fetched twice.
    expect(gets().length).toBe(1);
  });

  it('short writes with the default onStorageRefused: "error" → quota-exceeded', async () => {
    const page = await open();
    await page.evaluate(() => (window as any).startWorker());
    const out = await page.evaluate(
      ([config, url]) =>
        (window as any).worker.run(
          `FileSystemSyncAccessHandle.prototype.write = function () { return 0; };
           const lib = ctx.make(arg.config);
           const models = lib.collection('models');
           await models.download({ id: 'e1', url: arg.url });
           return await models.done('e1').then(() => 'resolved', (e) => e.code);`,
          { config, url },
        ),
      [CONFIG(), redirect('err-200000.bin')] as const,
    );
    expect(out).toBe('quota-exceeded');
  });

  it('rejects a corrupted model (integrity) and removes the file', async () => {
    const page = await open();
    await page.evaluate(() => (window as any).startWorker());
    const out = await page.evaluate(
      ([config, url]) =>
        (window as any).worker.run(
          `const lib = ctx.make(arg.config);
           const models = lib.collection('models');
           await models.download({ id: 'bad', url: arg.url, integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' });
           const code = await models.done('bad').then(() => 'resolved', (e) => e.code);
           const root = await navigator.storage.getDirectory();
           const dir = await (await (await root.getDirectoryHandle('offlibrary')).getDirectoryHandle('e2e')).getDirectoryHandle('models');
           const names = []; for await (const [n] of dir.entries()) names.push(n);
           return { code, names };`,
          { config, url },
        ),
      [CONFIG(), redirect('bad-300000.bin')] as const,
    );
    expect(out).toEqual({ code: 'integrity', names: [] });
  });

  it('delete(), usage() and storage.estimate() work with OPFS items', async () => {
    const page = await open();
    await page.evaluate(() => (window as any).startWorker());
    const out = await page.evaluate(
      ([config, url]) =>
        (window as any).worker.run(
          `const lib = ctx.make(arg.config);
           const models = lib.collection('models');
           await models.download({ id: 'd1', url: arg.url });
           await models.done('d1');
           const usage = await models.usage();
           const est = await lib.storage.estimate();
           await models.delete('d1');
           const root = await navigator.storage.getDirectory();
           const dir = await (await (await root.getDirectoryHandle('offlibrary')).getDirectoryHandle('e2e')).getDirectoryHandle('models');
           const names = []; for await (const [n] of dir.entries()) names.push(n);
           return { usage, est, names, after: await models.get('d1') };`,
          { config, url },
        ),
      [CONFIG(), redirect('del-400000.bin')] as const,
    );
    expect(out.usage).toEqual({ count: 1, bytes: 400000 });
    expect(out.est.supported).toBe(true);
    expect(out.names).toEqual([]);
    expect(out.after).toBeUndefined();
  });
});

describe('OPFS backend on a page (createWritable)', () => {
  it('downloads, pauses (commits the prefix) and resumes in place', async () => {
    const page = await open();
    const name = 'slowpage-3000000.bin';
    const { sri, b64 } = await sriOf(name);
    const out = await page.evaluate(
      async ([config, url, sri]) => {
        const w = window as any;
        const lib = w.make(config);
        const models = lib.collection('models');
        await models.download({ id: 'p1', url, integrity: sri });
        while ((models.peek('p1')?.downloaded ?? 0) < 1_000_000) await new Promise((r) => setTimeout(r, 50));
        const paused = await models.pause('p1');
        await models.resume('p1');
        const item = await models.done('p1');
        const blob = await models.blob('p1');
        return { paused, item, caps: lib.capabilities, hash: await w.sha256(await blob.arrayBuffer()), isFile: blob instanceof File };
      },
      [CONFIG(), redirect(name), sri] as const,
    );
    expect(out.caps.syncAccessHandle).toBe(false);
    expect(out.paused.status).toBe('paused');
    expect(out.item).toMatchObject({ status: 'completed', storage: 'opfs', resumed: true });
    expect(out.hash).toBe(b64);
    expect(out.isFile).toBe(true); // disk-backed, not a copy in memory
    const g = gets();
    expect(gets()[1].range).toBe(`bytes=${out.paused.downloaded}-`);
  });

  it('QuotaExceededError from createWritable → memory fallback', async () => {
    const page = await open();
    const name = 'quota-2500000.bin';
    const { b64, size } = await sriOf(name);
    const out = await page.evaluate(
      async ([config, url]) => {
        const w = window as any;
        let budget = 800_000;
        const orig = (window as any).FileSystemWritableFileStream.prototype.write;
        (window as any).FileSystemWritableFileStream.prototype.write = function (data: any) {
          budget -= data.byteLength ?? 0;
          if (budget < 0) return Promise.reject(new DOMException('full', 'QuotaExceededError'));
          return orig.call(this, data);
        };
        const lib = w.make(config);
        const models = lib.collection('models');
        await models.download({ id: 'q1', url });
        const item = await models.done('q1');
        return { item, hash: await w.sha256(await models.arrayBuffer('q1')) };
      },
      [CONFIG({ onStorageRefused: 'memory' }), redirect(name)] as const,
    );
    expect(out.item).toMatchObject({ status: 'completed', storage: 'memory', storageRefused: 'quota', bytes: size });
    expect(out.hash).toBe(b64);
  });
});

describe('multiple tabs', () => {
  it('a second tab follows the first one’s download and takes over when that tab closes', async () => {
    const a = await open();
    const b = await open();
    const name = 'slowtabs-4000000.bin';
    const { b64, size } = await sriOf(name);
    const config = { namespace: 'e2e', persist: 'never', progressInterval: 50, serviceWorker: false, collections: { models: { storage: 'opfs', retryDelay: 50 } } };
    await a.evaluate(
      async ([config, url]) => {
        const w = window as any;
        w.lib = w.make(config);
        await w.lib.collection('models').download({ id: 't1', url });
      },
      [config, redirect(name)] as const,
    );
    await a.waitForFunction(() => ((window as any).lib.collection('models').peek('t1')?.downloaded ?? 0) > 300_000);
    // Tab B asks for the same item: it must not start a second download.
    const bStart = await b.evaluate(
      async ([config, url]) => {
        const w = window as any;
        w.lib = w.make(config);
        const item = await w.lib.collection('models').download({ id: 't1', url });
        return item.status;
      },
      [config, redirect(name)] as const,
    );
    expect(bStart).toBe('downloading');
    await b.waitForFunction(() => (window as any).events.filter((e: any) => e.type === 'progress' && e.id === 't1').length > 2, null, { timeout: 10_000 });
    const requestsWhileShared = gets().length;
    expect(requestsWhileShared).toBe(1);
    await a.close(); // tab A goes away mid-download
    const out = await b.evaluate(async () => {
      const w = window as any;
      const models = w.lib.collection('models');
      const item = await models.done('t1');
      return { item, hash: await w.sha256(await models.arrayBuffer('t1')) };
    });
    expect(out.item).toMatchObject({ status: 'completed', bytes: size });
    expect(out.hash).toBe(b64);
    expect(gets().length).toBe(2);
  });
});

describe.runIf(process.env.OFFLIBRARY_E2E_QUOTA)('real private-mode quota (opt-in, ~700 MB)', () => {
  it('a 700 MB model in an off-the-record context completes (OPFS or memory fallback)', async () => {
    const page = await open();
    await page.evaluate(() => (window as any).startWorker());
    const out = await page.evaluate(
      ([config, url]) =>
        (window as any).worker.run(
          `const lib = ctx.make(arg.config);
           const models = lib.collection('models');
           const t = performance.now();
           await models.download({ id: 'big', url: arg.url });
           const item = await models.done('big');
           const est = await navigator.storage.estimate();
           return { item, ms: performance.now() - t, quota: est.quota, refused: ctx.events.filter((e) => e.type === 'storage-refused') };`,
          { config, url },
        ),
      [CONFIG({ onStorageRefused: 'memory' }), `${server.origin}/__media/big-700000000.bin`] as const,
    );
    console.log('private-mode 700 MB:', JSON.stringify(out));
    expect(out.item.status).toBe('completed');
    expect(out.item.bytes).toBe(700_000_000);
  }, 300_000);
});
