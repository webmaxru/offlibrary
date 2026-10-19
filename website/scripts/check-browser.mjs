// Open the built site in Chromium at phone and desktop widths: no console errors, no failed
// requests, every sidebar page loads; the demo works under /demo/; the retired root worker
// unregisters itself. Saves landing-page screenshots to SHOTS_DIR (default: ./screenshots).
// Usage: npm run build && CHROMIUM_PATH=/path/to/chrome node scripts/check-browser.mjs
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || '../../node_modules/playwright-core');

const dist = 'dist';
const base = (process.env.SITE_BASE || '/offlibrary').replace(/\/$/, '');
const shots = process.env.SHOTS_DIR || 'screenshots';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.xml': 'application/xml', '.txt': 'text/plain', '.woff2': 'font/woff2', '.pf_meta': 'application/octet-stream', '.pf_fragment': 'application/octet-stream', '.pf_index': 'application/octet-stream', '.wasm': 'application/wasm' };

let oldWorker = null; // when set, served at <base>/sw.js in place of the real file (handover test)
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (oldWorker && url.pathname === `${base}/sw.js`) {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' });
    return res.end(oldWorker);
  }
  if (!url.pathname.startsWith(`${base}/`)) return res.writeHead(404).end('outside base');
  let file = join(dist, decodeURIComponent(url.pathname.slice(base.length)));
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    return createReadStream(join(dist, '404.html')).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
mkdirSync(shots, { recursive: true });

const problems = [];
async function visit(context, path, label) {
  const page = await context.newPage();
  const errs = [];
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('requestfailed', (r) => errs.push(`request failed: ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => r.status() >= 400 && r.url().startsWith(origin) && errs.push(`${r.status()} ${r.url()}`));
  await page.goto(origin + path, { waitUntil: 'networkidle' });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) errs.push(`horizontal overflow ${overflow}px`);
  for (const e of errs) problems.push(`[${label}] ${path}: ${e}`);
  return page;
}

const sizes = { phone: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, desktop: { width: 1280, height: 800, deviceScaleFactor: 1 } };
let pages = [];
for (const [label, s] of Object.entries(sizes)) {
  for (const scheme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width: s.width, height: s.height }, isMobile: s.isMobile, hasTouch: s.hasTouch, deviceScaleFactor: s.deviceScaleFactor, colorScheme: scheme });
    const home = await visit(context, `${base}/`, `${label}/${scheme}`);
    await home.screenshot({ path: join(shots, `landing-${label}-${scheme}.png`), fullPage: label === 'desktop' });
    if (label === 'desktop' && scheme === 'dark') {
      pages = await home.evaluate((b) => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => h.startsWith(b + '/') && !h.includes('/demo/')), base);
      const docs = await visit(context, `${base}/getting-started/`, label);
      pages.push(...(await docs.evaluate(() => [...document.querySelectorAll('nav.sidebar a[href]')].map((a) => a.getAttribute('href')))));
      await docs.screenshot({ path: join(shots, `docs-${label}.png`) });
    }
    await context.close();
  }
}

// Every page linked from the landing page and the sidebar, at phone width.
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const unique = [...new Set(pages.filter((p) => p && p.startsWith(base + '/') && !p.includes('/demo/')))];
for (const p of unique) await (await visit(phone, p, 'phone')).close();
await phone.close();

// The demo under /demo/: loads, registers its own worker with the /demo/ scope.
const demoCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const demo = await visit(demoCtx, `${base}/demo/`, 'demo');
await demo.waitForFunction(() => navigator.serviceWorker.controller || navigator.serviceWorker.ready, null, { timeout: 15000 });
const scope = await demo.evaluate(async () => (await navigator.serviceWorker.ready).scope);
if (!scope.endsWith(`${base}/demo/`)) problems.push(`[demo] service worker scope is ${scope}`);
const episodes = await demo.evaluate(async () => {
  for (let i = 0; i < 50 && !document.querySelector('#episodes li:not(.loading)'); i++) await new Promise((r) => setTimeout(r, 100));
  return document.querySelectorAll('#episodes li:not(.loading)').length;
});
if (!episodes) problems.push('[demo] no episodes rendered');
await demo.screenshot({ path: join(shots, 'demo-phone.png') });
await demoCtx.close();

// The retired root worker. A returning demo visitor still has the OLD demo worker at the site
// root, controlling the page and holding its app-shell cache. Serve that old worker first, then
// switch the server to the real dist/sw.js: the browser's update check must install it, and it must
// clear the old shell cache, unregister and reload the page, while Offlibrary's data stays.
const OLD_WORKER = `self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open('radio-shell-old').then((c) => c.put('shell', new Response('old shell')))); });
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => e.respondWith(fetch(e.request)));`;
oldWorker = OLD_WORKER;
const killCtx = await browser.newContext();
const kill = await killCtx.newPage();
const killErrs = [];
kill.on('pageerror', (e) => killErrs.push(e.message));
await kill.goto(`${origin}${base}/`);
const before = await kill.evaluate(async (b) => {
  await navigator.serviceWorker.register(`${b}/sw.js`, { scope: `${b}/` });
  await navigator.serviceWorker.ready;
  for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i++) await new Promise((r) => setTimeout(r, 100));
  const data = await caches.open('offlibrary:radio:episodes');
  await data.put('/episode.mp3', new Response('audio'));
  return { controlled: !!navigator.serviceWorker.controller, caches: await caches.keys() };
}, base);
if (!before.controlled || !before.caches.includes('radio-shell-old')) problems.push(`[handover] old worker did not take control: ${JSON.stringify(before)}`);
oldWorker = null; // deploy: the site's own sw.js now answers at the old path
await kill.reload({ waitUntil: 'load' }); // navigation triggers the update check
let left;
for (let i = 0; i < 60; i++) {
  await kill.waitForTimeout(250);
  left = await kill
    .evaluate(async (b) => ({
      regs: (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope),
      controlled: !!navigator.serviceWorker.controller,
      caches: await caches.keys(),
      title: document.title,
    }), base)
    .catch(() => null); // the worker reloads the page mid-evaluate
  if (left && !left.regs.some((s) => s.endsWith(`${base}/`)) && !left.controlled) break;
}
if (!left || left.regs.some((s) => s.endsWith(`${base}/`)) || left.controlled || left.caches.includes('radio-shell-old') || !left.caches.includes('offlibrary:radio:episodes') || killErrs.length) {
  problems.push(`[handover] unexpected state: ${JSON.stringify({ left, killErrs })}`);
} else {
  console.log(`handover: old root worker replaced and unregistered; page uncontrolled ("${left.title}"); kept caches: ${left.caches.join(', ')}`);
}
await killCtx.close();

await browser.close();
server.close();
console.log(`checked ${unique.length} pages at phone width, landing at 2 widths × 2 color schemes, the demo and the retired root worker`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`✓ no console errors, failed requests or overflow; screenshots in ${shots}/`);
