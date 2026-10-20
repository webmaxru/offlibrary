/**
 * Incremental SHA-256 (FIPS 180-4) with a serialisable state.
 *
 * WebCrypto's `crypto.subtle.digest()` needs the whole input at once, which means holding a
 * 700 MB model in memory just to check it. This hashes chunk by chunk as bytes arrive, and its
 * state can be saved next to a download checkpoint so a resumed download keeps hashing where it
 * stopped instead of re-reading everything.
 * @internal
 */

const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const W = new Int32Array(64);
const IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

/** Serialisable SHA-256 state (structured-cloneable, fits in IndexedDB or JSON). */
export interface Sha256State {
  /** The eight working words. */
  h: number[];
  /** Bytes hashed so far. */
  length: number;
  /** Unprocessed tail (< 64 bytes), base64. */
  tail: string;
}

const b64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
};
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Streaming SHA-256. `update()` as often as you like, then `digest()` once. */
export class Sha256 {
  private readonly _h = new Int32Array(IV);
  private readonly _block = new Uint8Array(64);
  private _blockLen = 0;
  private _length = 0;

  /** Restore a hasher from {@link Sha256.state}. */
  static from(state: Sha256State): Sha256 {
    const s = new Sha256();
    s._h.set(state.h);
    s._length = state.length;
    const tail = unb64(state.tail);
    s._block.set(tail);
    s._blockLen = tail.length;
    return s;
  }

  /** Bytes hashed so far. */
  get length(): number {
    return this._length;
  }

  /** Snapshot the state (to persist next to a checkpoint). */
  state(): Sha256State {
    return { h: Array.from(this._h), length: this._length, tail: b64(this._block.subarray(0, this._blockLen)) };
  }

  update(data: Uint8Array): this {
    let pos = 0;
    const n = data.length;
    this._length += n;
    if (this._blockLen > 0) {
      const take = Math.min(64 - this._blockLen, n);
      this._block.set(data.subarray(0, take), this._blockLen);
      this._blockLen += take;
      pos = take;
      if (this._blockLen < 64) return this;
      this._compress(this._block, 0);
      this._blockLen = 0;
    }
    while (pos + 64 <= n) {
      this._compress(data, pos);
      pos += 64;
    }
    if (pos < n) {
      this._block.set(data.subarray(pos), 0);
      this._blockLen = n - pos;
    }
    return this;
  }

  /** Finish and return the 32-byte digest. The hasher must not be used afterwards. */
  digest(): Uint8Array {
    const bits = this._length * 8;
    const pad = new Uint8Array(((this._blockLen + 9 + 63) >> 6) << 6);
    pad.set(this._block.subarray(0, this._blockLen));
    pad[this._blockLen] = 0x80;
    const dv = new DataView(pad.buffer);
    dv.setUint32(pad.length - 8, Math.floor(bits / 0x100000000));
    dv.setUint32(pad.length - 4, bits >>> 0);
    for (let i = 0; i < pad.length; i += 64) this._compress(pad, i);
    const out = new Uint8Array(32);
    const ov = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) ov.setInt32(i * 4, this._h[i]!);
    return out;
  }

  /** Finish and return the digest as base64 (the SRI encoding). */
  digestBase64(): string {
    return b64(this.digest());
  }

  private _compress(p: Uint8Array, o: number): void {
    const w = W;
    const h = this._h;
    for (let i = 0; i < 16; i++) {
      const j = o + i * 4;
      w[i] = (p[j]! << 24) | (p[j + 1]! << 16) | (p[j + 2]! << 8) | p[j + 3]!;
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + ((K[i]! + w[i]!) | 0)) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0]! + a) | 0;
    h[1] = (h[1]! + b) | 0;
    h[2] = (h[2]! + c) | 0;
    h[3] = (h[3]! + d) | 0;
    h[4] = (h[4]! + e) | 0;
    h[5] = (h[5]! + f) | 0;
    h[6] = (h[6]! + g) | 0;
    h[7] = (h[7]! + hh) | 0;
  }
}
