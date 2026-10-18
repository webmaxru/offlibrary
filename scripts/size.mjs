// Size budget: minified + gzip/brotli size of each public entry, bundled the way an app would.
import { build } from 'esbuild';
import { brotliCompressSync, gzipSync } from 'node:zlib';

const budgets = [
  { name: 'offlibrary (page)', entry: 'src/index.ts', gzip: 11 * 1024 },
  { name: 'offlibrary/sw', entry: 'src/sw.ts', gzip: 4.5 * 1024 },
];
let failed = false;
for (const b of budgets) {
  const out = await build({ entryPoints: [b.entry], bundle: true, minify: true, format: 'esm', target: 'es2020', write: false, legalComments: 'none' });
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
