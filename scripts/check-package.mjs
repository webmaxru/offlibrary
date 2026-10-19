// Pack the library, install the tarball into a throwaway consumer project, and type-check
// code that uses the public API (both entry points) with skipLibCheck off.
// Catches broken exports maps, missing files and .d.ts files that reference stripped types.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve('.');
const dir = mkdtempSync(join(tmpdir(), 'offlibrary-consumer-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' }).toString().trim();
try {
  const tgz = run(npm, ['pack', '--silent', '--pack-destination', dir], root).split('\n').pop();
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  run(npm, ['install', '--offline', '--no-audit', '--no-fund', '--silent', `./${tgz}`], dir);
  writeFileSync(
    join(dir, 'page.ts'),
    `import { createOfflibrary, formatBytes, isBackgroundFetchSupported, OfflibraryError } from 'offlibrary';
import type { OfflibraryConfig, OfflibraryItem, OfflibraryErrorCode } from 'offlibrary';
const config: OfflibraryConfig = { namespace: 'app', collections: { episodes: { maxItems: 3, ui: { title: (i) => i.title ?? i.id } } } };
const library = createOfflibrary(config);
const episodes = library.collection<{ author: string }>('episodes');
const off = library.on('error', ({ item, error }) => { const code: OfflibraryErrorCode = error.code; console.log(item.id, code); });
episodes.subscribe(({ item }) => { const p: number | null = item.progress; console.log(p, item.meta?.author); });
export async function demo(): Promise<void> {
  const item: OfflibraryItem<{ author: string }> = await episodes.download({ id: 'a', url: '/a.mp3', meta: { author: 'x' } });
  const threshold: number = episodes.config.backgroundFetchThreshold;
  console.log(item.status, threshold, formatBytes(1), isBackgroundFetchSupported(), library.capabilities.backgroundFetch, episodes.snapshot().length);
  console.log(new OfflibraryError('aborted', 'x').retryable, (await library.storage.estimate()).available);
  off();
}
`,
  );
  writeFileSync(
    join(dir, 'sw.ts'),
    `import { offlibrarySW, matchOfflibrary, createRangeResponse, parseRange } from 'offlibrary/sw';
offlibrarySW({ serve: true, onComplete: (item) => console.log(item.bytes) });
export const m = (r: Request) => matchOfflibrary(r);
export const c = (r: Response) => createRangeResponse(r, 'bytes=0-1');
export const p = parseRange('bytes=0-1', 10);
`,
  );
  writeFileSync(
    join(dir, 'workbox-sw.ts'),
    `import { OfflibraryPlugin, initOfflibrary, offlibraryHandler, offlibraryMatch, matchOfflibrary } from 'offlibrary/workbox';
import type { OfflibraryHandlerOptions } from 'offlibrary/workbox';
initOfflibrary({ onComplete: (item) => console.log(item.id) });
const options: OfflibraryHandlerOptions = { fallback: async ({ request }) => fetch(request) };
export const route = [offlibraryMatch, offlibraryHandler(options)] as const;
export const plugins = [new OfflibraryPlugin({ fallbackOnError: false })];
export const m = (r: Request) => matchOfflibrary(r);
`,
  );
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, lib: ['ES2022', 'DOM'], skipLibCheck: false }, files: ['page.ts', 'sw.ts', 'workbox-sw.ts'] }),
  );
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', dir], { stdio: 'inherit' });
  console.log(`✓ ${tgz} installs and type-checks as a dependency (NodeNext resolution, skipLibCheck off)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
