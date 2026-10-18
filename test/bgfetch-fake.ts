import { vi } from 'vitest';
import { handleBackgroundFetchEvent } from '../src/sw.js';
import type { MockServer } from './helpers.js';

/** Simulates Chromium's Background Fetch + the service worker running offlibrarySW(). */
export class FakeRegistration extends EventTarget {
  downloaded = 0;
  result: '' | 'success' | 'failure' = '';
  failureReason = '';
  recordsAvailable = true;
  records: { request: Request; responseReady: Promise<Response> }[] = [];
  aborted = false;
  constructor(
    readonly id: string,
    readonly downloadTotal: number,
  ) {
    super();
  }
  async abort(): Promise<boolean> {
    this.aborted = true;
    return true;
  }
  async matchAll() {
    return this.records;
  }
}

export interface FakeOptions {
  /** Pretend the browser reports this failure reason instead of succeeding. */
  failWith?: string;
  /** Only fail the first download. */
  failOnce?: boolean;
  /** Hold every download until release() is called. */
  hold?: boolean;
}

export class FakeBackgroundFetch {
  readonly regs = new Map<string, FakeRegistration>();
  readonly calls: { id: string; urls: string[]; options: { title?: string; downloadTotal?: number; icons?: unknown[] } }[] = [];
  readonly updateUI = vi.fn(async (_o: { title?: string }) => {});
  readonly #release: (() => void)[] = [];
  options: FakeOptions;
  constructor(
    private server: MockServer,
    options: FakeOptions = {},
  ) {
    this.options = { ...options };
  }

  release(): void {
    for (const r of this.#release.splice(0)) r();
  }

  async fetch(id: string, requests: Request[], options: { title?: string; downloadTotal?: number; icons?: unknown[] } = {}) {
    if (this.regs.has(id)) throw new TypeError('Duplicate id');
    this.calls.push({ id, urls: requests.map((r) => r.url), options });
    const reg = new FakeRegistration(id, options.downloadTotal ?? 0);
    this.regs.set(id, reg);
    void this.#run(reg, requests);
    return reg;
  }
  async get(id: string) {
    return this.regs.get(id);
  }
  async getIds() {
    return [...this.regs.keys()];
  }

  async #run(reg: FakeRegistration, requests: Request[]) {
    if (this.options.hold) await new Promise<void>((r) => this.#release.push(r));
    const event = (type: string) => ({
      type,
      registration: reg,
      waitUntil: () => {},
      updateUI: this.updateUI,
    });
    for (const request of requests) {
      if (reg.aborted) break;
      const res = await this.server.fetch(request.url);
      const buf = new Uint8Array(await res.arrayBuffer());
      reg.downloaded += buf.length;
      reg.dispatchEvent(new Event('progress'));
      reg.records.push({ request, responseReady: Promise.resolve(new Response(buf, { status: res.status, headers: res.headers })) });
    }
    if (reg.aborted) {
      reg.result = 'failure';
      reg.failureReason = 'aborted';
      await handleBackgroundFetchEvent(event('backgroundfetchabort') as never);
    } else if (this.options.failWith) {
      reg.result = 'failure';
      reg.failureReason = this.options.failWith;
      if (this.options.failOnce) this.options.failWith = undefined;
      reg.dispatchEvent(new Event('progress'));
      await handleBackgroundFetchEvent(event('backgroundfetchfail') as never);
    } else {
      reg.result = 'success';
      reg.dispatchEvent(new Event('progress'));
      await handleBackgroundFetchEvent(event('backgroundfetchsuccess') as never);
    }
    this.regs.delete(reg.id);
  }
}
