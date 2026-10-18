import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyIntegrity } from '../src/internal/integrity.js';

const data = new TextEncoder().encode('offline first');
const sri = (algo: string) => `${algo}-${createHash(algo).update(data).digest('base64')}`;

describe('verifyIntegrity', () => {
  it('accepts matching sha256/384/512', async () => {
    for (const a of ['sha256', 'sha384', 'sha512']) await expect(verifyIntegrity(new Blob([data]), sri(a))).resolves.toBeUndefined();
  });
  it('accepts when any of several tokens matches', async () => {
    await expect(verifyIntegrity(new Blob([data]), `sha256-AAAA ${sri('sha384')}`)).resolves.toBeUndefined();
  });
  it('rejects mismatches with code "integrity"', async () => {
    await expect(verifyIntegrity(new Blob([data]), 'sha256-AAAA')).rejects.toMatchObject({ code: 'integrity' });
  });
  it('rejects unsupported algorithms', async () => {
    await expect(verifyIntegrity(new Blob([data]), 'md5-xyz')).rejects.toMatchObject({ code: 'integrity' });
  });
});
