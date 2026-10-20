import { OfflibraryError } from '../errors.js';

const ALGOS: Record<string, string> = { sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };

function toBase64(buf: ArrayBuffer): string {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

export interface Token {
  algo: string;
  digest: string;
}

/** @internal Parse an SRI string into the tokens we can check. */
export function parseIntegrity(integrity: string): Token[] {
  return integrity
    .trim()
    .split(/\s+/)
    .map((t) => {
      const i = t.indexOf('-');
      return { algo: ALGOS[t.slice(0, i).toLowerCase()]!, digest: t.slice(i + 1).split('?')[0]! };
    })
    .filter((t) => t.algo && t.digest);
}

/**
 * Verify a blob against a Subresource-Integrity string (`sha256-…`, several tokens allowed).
 * Throws `OfflibraryError('integrity')` on mismatch or when no supported algorithm is present.
 *
 * WebCrypto, which needs the whole blob in memory. Downloads use {@link IntegrityCheck} instead,
 * which hashes SHA-256 while the bytes stream in.
 */
export async function verifyIntegrity(blob: Blob, integrity: string, url = ''): Promise<void> {
  const tokens = parseIntegrity(integrity);
  if (!tokens.length) throw new OfflibraryError('integrity', `Unsupported integrity value "${integrity}".`);
  return verifyOthers(blob, tokens, url, true);
}

export async function verifyOthers(blob: Blob, tokens: Token[], url: string, all = false): Promise<void> {
  const others = all ? tokens : tokens.filter((t) => t.algo !== 'SHA-256');
  if (!others.length) throw new OfflibraryError('integrity', `Integrity check failed${url ? ` for ${url}` : ''}.`);
  const data = await blob.arrayBuffer();
  const cache = new Map<string, string>();
  for (const t of others) {
    let actual = cache.get(t.algo);
    if (!actual) {
      actual = toBase64(await crypto.subtle.digest(t.algo, data));
      cache.set(t.algo, actual);
    }
    if (actual === t.digest) return;
  }
  throw new OfflibraryError('integrity', `Integrity check failed${url ? ` for ${url}` : ''}.`);
}

