import { OfflibraryError } from '../errors.js';
import { parseIntegrity, verifyIntegrity, verifyOthers } from './integrity.js';
import { Sha256 } from './sha256.js';
import type { Sha256State } from './sha256.js';

/** @internal Feed a blob (or part of one) into a hasher, 4 MiB at a time. */
export async function hashBlob(blob: Blob, h: Sha256, start = 0, end = blob.size): Promise<Sha256> {
  const STEP = 4 * 1024 * 1024;
  for (let pos = start; pos < end; pos += STEP) {
    h.update(new Uint8Array(await blob.slice(pos, Math.min(end, pos + STEP)).arrayBuffer()));
  }
  return h;
}

/**
 * @internal Streaming integrity check for one download.
 *
 * When the SRI string has a `sha256-` token, bytes are hashed as they arrive and the hash state
 * travels with every checkpoint (`state()` / `resume`), so a resumed download never re-reads what
 * it already hashed. Otherwise (`sha384`/`sha512` only) it verifies the finished blob at the end.
 */
export class IntegrityCheck {
  readonly integrity: string;
  readonly streaming: boolean;
  private _h: Sha256 | undefined;

  constructor(integrity: string, resume?: Sha256State) {
    this.integrity = integrity;
    this.streaming = parseIntegrity(integrity).some((t) => t.algo === 'SHA-256');
    if (this.streaming) this._h = resume ? Sha256.from(resume) : new Sha256();
  }

  /** Bytes hashed so far (streaming only). */
  get hashed(): number {
    return this._h?.length ?? 0;
  }

  update(chunk: Uint8Array): void {
    this._h?.update(chunk);
  }

  /** Start over (the server sent the whole file again). */
  reset(): void {
    if (this.streaming) this._h = new Sha256();
  }

  /** Bring the hash up to `blob.size` by hashing `blob[hashed..]` (used after a resume). */
  async catchUp(blob: Blob, upTo = blob.size): Promise<void> {
    if (this._h && this._h.length < upTo) await hashBlob(blob, this._h, this._h.length, upTo);
  }

  state(): Sha256State | undefined {
    return this._h?.state();
  }

  /** Throw `integrity` if the finished file does not match. `blob` is only read for non-streaming checks. */
  async verify(url: string, blob: () => Promise<Blob>): Promise<void> {
    if (!this._h) return verifyIntegrity(await blob(), this.integrity, url);
    const actual = this._h.digestBase64();
    const tokens = parseIntegrity(this.integrity);
    if (tokens.some((t) => t.algo === 'SHA-256' && t.digest === actual)) return;
    if (tokens.some((t) => t.algo !== 'SHA-256')) return verifyOthers(await blob(), tokens, url);
    throw new OfflibraryError('integrity', `Integrity check failed${url ? ` for ${url}` : ''} (got sha256-${actual}).`);
  }
}
