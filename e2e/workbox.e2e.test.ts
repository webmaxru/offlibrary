/**
 * Offlibrary inside a real Workbox service worker (workbox-precaching, -routing and -strategies from
 * npm, bundled with esbuild), in real Chromium: offline playback with seeking, served through
 * `offlibraryMatch` + `offlibraryHandler` and through `OfflibraryPlugin` in a NetworkFirst route.
 */
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { createServer } from '../scripts/serve.mjs';

const DIR = 'e2e/.tmp/workbox';
let server: Awaited<ReturnType<typeof createServer>>;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];

beforeAll(async () => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  cpSync('e2e/fixtures/workbox/index.html', `${DIR}/index.html`);
  await build({
    entryPoints: ['e2e/fixtures/workbox/sw.src.js'],
    outfile: `${DIR}/sw.js`,
    bundle: true,
    format: 'iife',
    target: 'es2020',
    alias: { 'offlibrary/workbox': './dist/workbox.js' }, // the built package output, as an app would get it
    define: { 'process.env.NODE_ENV': '"development"' }, // Workbox's dev build: runs its own argument assertions
    logLevel: 'warning',
  });
  server = await createServer({ root: '.', throttle: { chunk: 64 * 1024, delayMs: 5 } });
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    channel: process.env.CHROMIUM_PATH ? undefined : 'chromium',
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  context = await browser.newContext();
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`${server.origin}/${DIR}/index.html`);
  await page.waitForFunction(() => (window as any).ready === true && !!navigator.serviceWorker.controller);
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  rmSync(DIR, { recursive: true, force: true });
});

const media = (name: string) => `${server.origin}/__media/${name}`;
const gets = (name: string) => server.requests.filter((r) => r.path === `/__media/${name}` && r.method === 'GET');

async function download(id: string, url: string) {
  await page.evaluate(([i, u]) => (window as any).media.download({ id: i, url: u }), [id, url]);
  return page.evaluate((i) => (window as any).media.done(i), id);
}

async function playAndSeek(url: string, to: number) {
  return page.evaluate(
    async ([u, t]) => {
      const audio = document.getElementById('player') as HTMLAudioElement;
      audio.src = u as string;
      await audio.play();
      audio.currentTime = t as number;
      await new Promise((r) => audio.addEventListener('seeked', r, { once: true }));
      await new Promise((r) => setTimeout(r, 300));
      const result = { duration: Math.round(audio.duration || 0), at: audio.currentTime, error: audio.error?.code ?? null };
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      return result;
    },
    [url, to],
  );
}

describe('offlibrary/workbox in a real Workbox service worker', () => {
  it('serves a downloaded file from the device through offlibraryMatch + offlibraryHandler, online', async () => {
    const url = media('wbtone-20s.wav');
    expect(await download('t20', url)).toMatchObject({ status: 'completed', bytes: 320044 });
    const before = gets('wbtone-20s.wav').length;
    const res = await page.evaluate(async (u) => {
      const r = await fetch(u, { headers: { Range: 'bytes=100-199' } });
      return { status: r.status, len: (await r.arrayBuffer()).byteLength, range: r.headers.get('Content-Range') };
    }, url);
    expect(res).toEqual({ status: 206, len: 100, range: 'bytes 100-199/320044' });
    expect(gets('wbtone-20s.wav').length).toBe(before); // no network request
  });

  it('passes files Offlibrary does not store to the fallback strategy', async () => {
    const url = media('wbother-1000.bin');
    const status = await page.evaluate(async (u) => (await fetch(u)).status, url);
    expect(status).toBe(200);
    expect(gets('wbother-1000.bin')).toHaveLength(1);
  });

  it('plays and seeks offline through the handler route', async () => {
    await context.setOffline(true);
    try {
      const played = await playAndSeek(media('wbtone-20s.wav'), 15);
      expect(played).toMatchObject({ error: null, duration: 20 });
      expect(played.at).toBeGreaterThanOrEqual(15);
    } finally {
      await context.setOffline(false);
    }
  });

  it('serves from the device right after the service worker was stopped (cold start, index not loaded yet)', async () => {
    // Note: Chromium does not restart a stopped worker under Playwright's offline emulation, so this
    // runs online and proves the device copy was used by checking the server saw no request.
    const cdp = await context.newCDPSession(page);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await cdp.detach();
    const before = gets('wbtone-20s.wav').length;
    const played = await playAndSeek(media('wbtone-20s.wav'), 12);
    expect(played).toMatchObject({ error: null, duration: 20 });
    expect(played.at).toBeGreaterThanOrEqual(12);
    expect(gets('wbtone-20s.wav').length).toBe(before);
  });

  it('plays and seeks offline through OfflibraryPlugin in a NetworkFirst route', async () => {
    const url = `${media('wbplug-12s.wav')}?via-plugin=1`;
    expect(await download('t12', url)).toMatchObject({ status: 'completed' });
    await context.setOffline(true);
    try {
      const partial = await page.evaluate(async (u) => {
        const r = await fetch(u, { headers: { Range: 'bytes=0-9' } });
        return { status: r.status, len: (await r.arrayBuffer()).byteLength };
      }, url);
      expect(partial).toEqual({ status: 206, len: 10 });
      const played = await playAndSeek(url, 9);
      expect(played).toMatchObject({ error: null, duration: 12 });
      expect(played.at).toBeGreaterThanOrEqual(9);
      // Workbox's own precache still serves the app shell offline.
      await page.reload();
      await page.waitForFunction(() => (window as any).ready === true);
    } finally {
      await context.setOffline(false);
    }
  });

  it('logged no errors', () => {
    expect(errors.filter((e) => !/net::ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(e))).toEqual([]);
  });
});
