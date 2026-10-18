// Build: per-module ESM + .d.ts with tsc (best for tree-shaking), plus minified bundles for CDNs
// and an IIFE service-worker build for importScripts().
import { execFileSync } from 'node:child_process';
import { rmSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const banner = { js: `/*! offlibrary v${pkg.version} | MIT | github.com/webmaxru/offlibrary */` };

rmSync('dist', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' });

const common = { bundle: true, minify: true, target: 'es2020', legalComments: 'none', banner, logLevel: 'warning' };
await Promise.all([
  build({ ...common, entryPoints: ['src/index.ts'], format: 'esm', outfile: 'dist/offlibrary.min.js' }),
  build({ ...common, entryPoints: ['src/sw.ts'], format: 'esm', outfile: 'dist/offlibrary-sw.min.js' }),
  build({ ...common, entryPoints: ['src/sw.ts'], format: 'iife', globalName: 'offlibrary', outfile: 'dist/offlibrary-sw.iife.js' }),
]);
console.log(`built offlibrary v${pkg.version}`);
