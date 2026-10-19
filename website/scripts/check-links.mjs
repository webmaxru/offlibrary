// Crawl the built site and check every internal link and asset resolves under the base path.
// Usage: node scripts/check-links.mjs [dist] [base]
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const dist = process.argv[2] || 'dist';
const base = (process.argv[3] || process.env.SITE_BASE || '/offlibrary').replace(/\/$/, '');

const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const html = walk(dist).filter((f) => f.endsWith('.html'));

function resolveTarget(pathname) {
  if (!pathname.startsWith(`${base}/`) && pathname !== base) return { ok: false, why: `outside base ${base}` };
  let p = decodeURIComponent(pathname.slice(base.length)) || '/';
  const file = join(dist, p);
  if (p.endsWith('/')) return { ok: existsSync(join(file, 'index.html')), file: join(file, 'index.html') };
  if (existsSync(file) && statSync(file).isFile()) return { ok: true, file };
  if (existsSync(join(file, 'index.html'))) return { ok: true, file: join(file, 'index.html') };
  return { ok: false };
}

const idsCache = new Map();
function ids(file) {
  if (!idsCache.has(file)) {
    const s = readFileSync(file, 'utf8');
    idsCache.set(file, new Set([...s.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  }
  return idsCache.get(file);
}

let checked = 0;
const broken = [];
for (const file of html) {
  const page = '/' + relative(dist, file).split('\\').join('/');
  const pageUrl = new URL(`${base}${page.replace(/index\.html$/, '')}`, 'https://site.invalid');
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const raw = m[1].replace(/&amp;/g, '&');
    if (/^(https?:|mailto:|data:|javascript:|#$)/.test(raw) && !raw.startsWith('https://site.invalid')) continue;
    const url = new URL(raw, pageUrl);
    if (url.origin !== 'https://site.invalid') continue;
    checked++;
    const t = resolveTarget(url.pathname);
    if (!t.ok) {
      broken.push(`${page} → ${raw}${t.why ? ` (${t.why})` : ''}`);
      continue;
    }
    if (url.hash && url.hash.length > 1 && t.file.endsWith('.html')) {
      const id = decodeURIComponent(url.hash.slice(1));
      if (!ids(t.file).has(id)) broken.push(`${page} → ${raw} (missing #${id})`);
    }
  }
}
console.log(`${html.length} pages, ${checked} internal links/assets checked under ${base}/`);
if (broken.length) {
  console.error(`${broken.length} broken:\n` + [...new Set(broken)].slice(0, 200).join('\n'));
  process.exit(1);
}
console.log('✓ no broken internal links');
