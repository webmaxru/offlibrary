import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Sha256 } from '../src/internal/sha256.js';

const ref = (b: Uint8Array) => createHash('sha256').update(b).digest('base64');

describe('Sha256 (streaming)', () => {
  it('matches node:crypto for many lengths', () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000, 4097]) {
      const data = new Uint8Array(randomBytes(n));
      expect(new Sha256().update(data).digestBase64(), `n=${n}`).toBe(ref(data));
    }
  });

  it('gives the same digest for any chunking', () => {
    const data = new Uint8Array(randomBytes(100_003));
    const h = new Sha256();
    for (let i = 0; i < data.length; ) {
      const step = 1 + ((i * 7919) % 5000);
      h.update(data.subarray(i, i + step));
      i += step;
    }
    expect(h.digestBase64()).toBe(ref(data));
  });

  it('survives a state round-trip (resume)', () => {
    const data = new Uint8Array(randomBytes(70_001));
    const a = new Sha256().update(data.subarray(0, 33_333));
    const saved = JSON.parse(JSON.stringify(a.state()));
    const b = Sha256.from(saved).update(data.subarray(33_333));
    expect(b.length).toBe(70_001);
    expect(b.digestBase64()).toBe(ref(data));
  });

  it('hashes 64 MiB at a usable speed', () => {
    const data = new Uint8Array(64 * 1024 * 1024).fill(7);
    const t = performance.now();
    const h = new Sha256();
    for (let i = 0; i < data.length; i += 1 << 20) h.update(data.subarray(i, i + (1 << 20)));
    const out = h.digestBase64();
    const ms = performance.now() - t;
    expect(out).toBe(ref(data));
    console.log(`sha256 throughput: ${(64 / (ms / 1000)).toFixed(0)} MiB/s`);
  });
});
