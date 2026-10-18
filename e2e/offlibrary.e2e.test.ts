/**
 * End-to-end tests in real Chromium (full browser, new headless mode). chrome-headless-shell exposes
 * Background Fetch but never completes a fetch, so the full build is required.
 * Set CHROMIUM_PATH to use a specific binary; otherwise Playwright's own Chromium is used.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { createServer } from '../scripts/serve.mjs';

let server: Awaited<ReturnType<typeof createServer>>;
let browser: Browser;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  server = await createServer({ root: '.', throttle: { chunk: 64 * 1024, delayMs: 30 } });
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    channel: process.env.CHROMIUM_PATH ? undefined : 'chromium',
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
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

async function open(strategy = 'auto'): Promise<Page> {
  page = await context.newPage();
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  const url = `${server.origin}/e2e/fixtures/index.html?strategy=${strategy}`;
  await page.goto(url);
  await page.waitForFunction(() => (window as any).ready === true);
  // Reload once so the service worker controls the page (needed for range serving).
  await page.reload();
  await page.waitForFunction(() => (window as any).ready === true && !!navigator.serviceWorker.controller);
  return page;
}

const media = (name: string) => `${server.origin}/__media/${name}`;

describe('Background Fetch (real Chromium)', () => {
  it('is supported in this browser', async () => {
    await open();
    expect(await page.evaluate(() => (window as any).bgSupported)).toBe(true);
  });

  it('downloads with Background Fetch, stores via the SW, and reports progress', async () => {
    await open('background-fetch');
    const url = media('slowbg-2000000.bin');
    const started = await page.evaluate((u) => (window as any).media.download({ id: 'bg1', url: u, title: 'BG one' }), url);
    expect(started.strategy).toBe('background-fetch');
    const done = await page.evaluate(() => (window as any).media.done('bg1'));
    expect(done).toMatchObject({ status: 'completed', bytes: 2_000_000, strategy: 'background-fetch' });
    const events = await page.evaluate(() => (window as any).events);
    expect(events.filter((e: any) => e.type === 'progress').length).toBeGreaterThan(1);
    expect(events.at(-1)).toMatchObject({ type: 'complete', id: 'bg1' });
    const size = await page.evaluate(async () => (await (window as any).media.blob('bg1')).size);
    expect(size).toBe(2_000_000);
    const ids = await page.evaluate(async () => (await navigator.serviceWorker.ready as any).backgroundFetch.getIds());
    expect(ids).toEqual([]);
  });

  it('re-attaches to a running Background Fetch after a reload', async () => {
    await open('background-fetch');
    const url = media('slowreload-3000000.bin');
    await page.evaluate((u) => (window as any).media.download({ id: 'r1', url: u }), url);
    await page.waitForFunction(() => ((window as any).media.peek('r1')?.downloaded ?? 0) > 0);
    await page.reload();
    await page.waitForFunction(() => (window as any).ready === true);
    expect(await page.evaluate(() => (window as any).media.peek('r1')?.status)).toBe('downloading');
    const done = await page.evaluate(() => (window as any).media.done('r1'));
    expect(done.bytes).toBe(3_000_000);
    const gets = server.requests.filter((r) => r.path.endsWith('slowreload-3000000.bin') && r.method === 'GET');
    expect(gets).toHaveLength(1); // the browser kept downloading; nothing restarted
  });

  it('cancels a Background Fetch and forgets the item', async () => {
    await open('background-fetch');
    await page.evaluate((u) => (window as any).media.download({ id: 'c1', url: u }), media('slowcancel-4000000.bin'));
    await page.waitForFunction(() => ((window as any).media.peek('c1')?.downloaded ?? 0) > 0);
    await page.evaluate(() => (window as any).media.cancel('c1'));
    expect(await page.evaluate(() => (window as any).media.peek('c1'))).toBeUndefined();
    const ids = await page.evaluate(async () => (await navigator.serviceWorker.ready as any).backgroundFetch.getIds());
    expect(ids).toEqual([]);
    expect((await page.evaluate(() => (window as any).events)).at(-1)).toMatchObject({ type: 'abort', id: 'c1' });
  });
});

describe('fetch fallback (real Chromium)', () => {
  it('downloads with streaming fetch and progress', async () => {
    await open('fetch');
    await page.evaluate((u) => (window as any).media.download({ id: 'f1', url: u }), media('slowfetch-1500000.bin'));
    const done = await page.evaluate(() => (window as any).media.done('f1'));
    expect(done).toMatchObject({ status: 'completed', bytes: 1_500_000, strategy: 'fetch' });
    const progress = (await page.evaluate(() => (window as any).events)).filter((e: any) => e.type === 'progress');
    expect(progress.length).toBeGreaterThan(3);
    expect(progress[0].total).toBe(1_500_000);
  });

  it('pauses and resumes with an HTTP Range request', async () => {
    await open('fetch');
    await page.evaluate((u) => (window as any).media.download({ id: 'p1', url: u }), media('slowpause-2000000.bin'));
    await page.waitForFunction(() => ((window as any).media.peek('p1')?.downloaded ?? 0) > 500_000);
    const paused = await page.evaluate(() => (window as any).media.pause('p1'));
    expect(paused.status).toBe('paused');
    await page.evaluate(() => (window as any).media.resume('p1'));
    const done = await page.evaluate(() => (window as any).media.done('p1'));
    expect(done.bytes).toBe(2_000_000);
    const gets = server.requests.filter((r) => r.path.endsWith('slowpause-2000000.bin') && r.method === 'GET');
    expect(gets.length).toBe(2);
    expect(gets[1]!.range).toMatch(/^bytes=\d+-$/);
    expect(Number(/bytes=(\d+)-/.exec(gets[1]!.range!)![1])).toBeGreaterThan(0);
    expect(gets[1]!.ifRange).toBe('"slowpause-2000000.bin"');
  });

  it('resumes an interrupted download after a page reload', async () => {
    await open('fetch');
    await page.evaluate((u) => (window as any).media.download({ id: 'i1', url: u }), media('slowreload2-6000000.bin'));
    await page.waitForFunction(() => ((window as any).media.peek('i1')?.downloaded ?? 0) > 4_300_000); // past the first 4 MiB segment
    await page.reload();
    await page.waitForFunction(() => (window as any).ready === true);
    const done = await page.evaluate(() => (window as any).media.done('i1'));
    expect(done.bytes).toBe(6_000_000);
    const gets = server.requests.filter((r) => r.path.endsWith('slowreload2-6000000.bin') && r.method === 'GET');
    expect(gets.at(-1)!.range).toBe('bytes=4194304-');
  });
});

describe('offline playback', () => {
  it('serves stored media with Range from the SW while offline, and <audio> can seek', async () => {
    await open('fetch');
    const url = media('tone-20s.wav');
    await page.evaluate((u) => (window as any).media.download({ id: 'wav', url: u }), url);
    await page.evaluate(() => (window as any).media.done('wav'));
    await context.setOffline(true);
    const partial = await page.evaluate(async (u) => {
      const r = await fetch(u, { headers: { Range: 'bytes=0-99' } });
      return { status: r.status, len: (await r.arrayBuffer()).byteLength, range: r.headers.get('Content-Range') };
    }, url);
    expect(partial).toEqual({ status: 206, len: 100, range: 'bytes 0-99/320044' });
    const played = await page.evaluate(async (u) => {
      const audio = document.getElementById('player') as HTMLAudioElement;
      audio.src = u;
      await audio.play();
      audio.currentTime = 15;
      await new Promise((r) => audio.addEventListener('seeked', r, { once: true }));
      await new Promise((r) => setTimeout(r, 300));
      const t = audio.currentTime;
      audio.pause();
      return { duration: Math.round(audio.duration), t, error: audio.error?.code ?? null };
    }, url);
    expect(played.error).toBeNull();
    expect(played.duration).toBe(20);
    expect(played.t).toBeGreaterThanOrEqual(15);
    await context.setOffline(false);
  });

  it('deletes stored media', async () => {
    await open('fetch');
    const url = media('del-1000.bin');
    await page.evaluate((u) => (window as any).media.download({ id: 'd1', url: u }), url);
    await page.evaluate(() => (window as any).media.done('d1'));
    expect(await page.evaluate(() => (window as any).media.delete('d1'))).toBe(true);
    const cached = await page.evaluate(async (u) => !!(await caches.match(u)), url);
    expect(cached).toBe(false);
  });
});
