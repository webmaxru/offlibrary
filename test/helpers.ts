/** In-memory Cache / CacheStorage good enough for unit tests. */
class MemoryCache {
  readonly entries = new Map<string, { body: ArrayBuffer; status: number; headers: [string, string][] }>();
  #url(req: RequestInfo | URL): string {
    return typeof req === 'string' ? new URL(req).href : req instanceof URL ? req.href : req.url;
  }
  async put(req: RequestInfo | URL, res: Response): Promise<void> {
    this.entries.set(this.#url(req), { body: await res.arrayBuffer(), status: res.status, headers: [...res.headers] });
  }
  async match(req: RequestInfo | URL): Promise<Response | undefined> {
    const e = this.entries.get(this.#url(req));
    return e ? new Response(e.body.slice(0), { status: e.status, headers: e.headers }) : undefined;
  }
  async delete(req: RequestInfo | URL): Promise<boolean> {
    return this.entries.delete(this.#url(req));
  }
  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((u) => new Request(u));
  }
}

export class MemoryCacheStorage {
  readonly stores = new Map<string, MemoryCache>();
  async open(name: string): Promise<MemoryCache> {
    let c = this.stores.get(name);
    if (!c) this.stores.set(name, (c = new MemoryCache()));
    return c;
  }
  async has(name: string): Promise<boolean> {
    return this.stores.has(name);
  }
  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }
  async keys(): Promise<string[]> {
    return [...this.stores.keys()];
  }
  async match(req: RequestInfo | URL): Promise<Response | undefined> {
    for (const c of this.stores.values()) {
      const r = await c.match(req);
      if (r) return r;
    }
    return undefined;
  }
}

export function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

export interface ServerOptions {
  /** Bytes per streamed chunk. */
  chunk?: number;
  /** Delay between chunks in ms. */
  delay?: number;
  /** Honour Range requests (default true). */
  ranges?: boolean;
  /** ETag to send (default "v1"). Set null to send none. */
  etag?: string | null;
  /** Fail the body stream with a network error after this many bytes (once per request count listed). */
  dropAfter?: number;
  /** Requests (1-based) that should drop. Default: only the first. */
  dropOn?: number[];
  /** Status codes to answer for the first N requests, e.g. [503, 503]. */
  statuses?: number[];
}

export interface MockServer {
  fetch: typeof fetch;
  requests: { url: string; method: string; range: string | null; ifRange: string | null }[];
}

/** A fetch() that serves `files` (absolute URL → bytes) with optional Range support, throttling and faults. */
export function mockServer(files: Record<string, Uint8Array>, opts: ServerOptions = {}): MockServer {
  const requests: MockServer['requests'] = [];
  const { chunk = 1024, delay = 0, ranges = true, dropOn = [1] } = opts;
  const etag = opts.etag === undefined ? '"v1"' : opts.etag;
  const statuses = [...(opts.statuses ?? [])];
  let getCount = 0;
  const impl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? new URL(input).href : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    const method = (init.method ?? 'GET').toUpperCase();
    const signal = init.signal ?? undefined;
    requests.push({ url, method, range: headers.get('Range'), ifRange: headers.get('If-Range') });
    if (signal?.aborted) throw signal.reason;
    const file = files[url];
    if (!file) return new Response('not found', { status: 404 });
    const base: Record<string, string> = { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': ranges ? 'bytes' : 'none' };
    if (etag) base.ETag = etag;
    if (method === 'HEAD') return new Response(null, { status: 200, headers: { ...base, 'Content-Length': String(file.length) } });
    getCount++;
    const forced = statuses.shift();
    if (forced) return new Response('err', { status: forced });
    let start = 0;
    let status = 200;
    const range = headers.get('Range');
    const ifRange = headers.get('If-Range');
    const out: Record<string, string> = { ...base };
    if (range && ranges && (!ifRange || ifRange === etag)) {
      start = Number(/bytes=(\d+)-/.exec(range)![1]);
      status = 206;
      out['Content-Range'] = `bytes ${start}-${file.length - 1}/${file.length}`;
    }
    const body = file.subarray(start);
    out['Content-Length'] = String(body.length);
    const thisRequest = getCount;
    const shouldDrop = opts.dropAfter !== undefined && dropOn.includes(thisRequest);
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (signal?.aborted) {
          controller.error(signal.reason);
          return;
        }
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (signal?.aborted) {
          controller.error(signal.reason);
          return;
        }
        if (shouldDrop && offset >= opts.dropAfter!) {
          controller.error(new TypeError('network connection lost'));
          return;
        }
        if (offset >= body.length) {
          controller.close();
          return;
        }
        const end = Math.min(body.length, offset + chunk);
        controller.enqueue(body.slice(offset, end));
        offset = end;
      },
    });
    return new Response(stream, { status, headers: out });
  };
  return { fetch: impl as typeof fetch, requests };
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Wait until `fn` returns truthy (polling). */
export async function until<T>(fn: () => T | Promise<T>, timeout = 3000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('until(): timed out');
    await tick(5);
  }
}
