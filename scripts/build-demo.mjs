// Build the demo PWA into demo/dist (deployed to GitHub Pages).
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { build } from 'esbuild';

const out = 'demo/dist';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync('demo/public', out, { recursive: true });
cpSync('demo/index.html', join(out, 'index.html'));
cpSync('demo/styles.css', join(out, 'styles.css'));

const alias = { offlibrary: './src/index.ts', 'offlibrary/sw': './src/sw.ts' };
await build({ entryPoints: ['demo/src/app.js'], outfile: join(out, 'app.js'), bundle: true, minify: true, format: 'esm', target: 'es2020', alias, sourcemap: true, legalComments: 'none' });

const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const shellFiles = walk(out).filter((f) => !f.endsWith('.map')).map((f) => relative(out, f).split('\\').join('/'));
const hash = createHash('sha256');
for (const f of shellFiles.sort()) hash.update(f).update(readFileSync(join(out, f)));
const version = hash.digest('hex').slice(0, 10);
const shell = ['./', ...shellFiles.filter((f) => f !== 'index.html')];

await build({
  entryPoints: ['demo/src/sw.js'],
  outfile: join(out, 'sw.js'),
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  alias,
  legalComments: 'none',
  define: { __SHELL_VERSION__: JSON.stringify(version), __SHELL_FILES__: JSON.stringify(shell) },
});
writeFileSync(join(out, '.nojekyll'), '');
console.log(`demo built → ${out} (shell ${version}, ${shell.length} files)`);
