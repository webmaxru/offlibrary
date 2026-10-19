// After `astro build`: put the demo app under dist/demo/ so one Pages artifact serves both.
// The demo is built in the repo root with `npm run demo:build` (demo/dist). All its paths are
// relative, so it works under /offlibrary/demo/ unchanged, and its service worker's scope is /offlibrary/demo/.
import { cpSync, existsSync } from 'node:fs';

const demo = new URL('../../demo/dist/', import.meta.url);
const target = new URL('../dist/demo/', import.meta.url);
if (!existsSync(demo)) {
  if (process.env.CI) {
    console.error('demo/dist is missing: run `npm run demo:build` in the repo root before building the site.');
    process.exit(1);
  }
  console.warn('demo/dist not found; skipping the demo copy (run `npm run demo:build` in the repo root).');
} else {
  cpSync(demo, target, { recursive: true });
  console.log('demo copied to dist/demo/');
}
