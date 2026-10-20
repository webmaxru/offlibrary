// Size budget: minified + gzip/brotli size of each public entry, bundled the way an app would.
import { build } from 'esbuild';
import { brotliCompressSync, gzipSync } from 'node:zlib';

const budgets = [
  // 0.2.0 grew the page entry from ~10.3 KB to ~17.5 KB gzip: OPFS backend + worker fast path, append-only
  // checkpoints, streaming SHA-256, storage-refusal fallback, multi-tab takeover and runtime helpers.
  { name: 'offlibrary (page)', entry: 'src/index.ts', gzip: 18 * 1024 },
  { name: 'offlibrary/sw', entry: 'src/sw.ts', gzip: 5 * 1024 },
  { name: 'offlibrary/workbox', entry: 'src/workbox.ts', gzip: 5.25 * 1024 },
  // What a Workbox SW pays for the common case alone (tree-shaken): match + handler, no Background Fetch handling.
  {
    name: 'workbox route only',
    stdin: "import { offlibraryMatch, offlibraryHandler } from './src/workbox.ts'; self.r = [offlibraryMatch, offlibraryHandler()];",
    gzip: 2.6 * 1024,
  },
];
let failed = false;
for (const b of budgets) {
  const input = b.stdin ? { stdin: { contents: b.stdin, resolveDir: '.', loader: 'ts' } } : { entryPoints: [b.entry] };
  const out = await build({ ...input, bundle: true, minify: true, format: 'esm', target: 'es2020', write: false, legalComments: 'none' });
  const code = out.outputFiles[0].contents;
  const gz = gzipSync(code, { level: 9 }).length;
  const br = brotliCompressSync(code).length;
  const ok = gz <= b.gzip;
  failed ||= !ok;
  console.log(`${ok ? '✓' : '✗'} ${b.name.padEnd(20)} ${String(code.length).padStart(6)} B min  ${String(gz).padStart(5)} B gzip  ${String(br).padStart(5)} B brotli  (budget ${b.gzip} B gzip)`);
}
if (failed) {
  console.error('Size budget exceeded.');
  process.exit(1);
}
