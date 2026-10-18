import { OfflibraryError } from '../errors.js';

const ALGOS: Record<string, string> = { sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };

function toBase64(buf: ArrayBuffer): string {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

/**
 * Verify a blob against a Subresource-Integrity string (`sha256-…`, several tokens allowed).
 * Throws `OfflibraryError('integrity')` on mismatch or when no supported algorithm is present.
 */
export async function verifyIntegrity(blob: Blob, integrity: string, url = ''): Promise<void> {
  const tokens = integrity.trim().split(/\s+/).map((t) => {
    const i = t.indexOf('-');
    return { algo: ALGOS[t.slice(0, i).toLowerCase()], digest: t.slice(i + 1).split('?')[0] };
  }).filter((t) => t.algo && t.digest);
  if (!tokens.length) throw new OfflibraryError('integrity', `Unsupported integrity value "${integrity}".`);
  const data = await blob.arrayBuffer();
  const cache = new Map<string, string>();
  for (const t of tokens) {
    let actual = cache.get(t.algo!);
    if (!actual) {
      actual = toBase64(await crypto.subtle.digest(t.algo!, data));
      cache.set(t.algo!, actual);
    }
    if (actual === t.digest) return;
  }
  throw new OfflibraryError('integrity', `Integrity check failed${url ? ` for ${url}` : ''}.`);
}
