// Tiny static server with Range, ETag and CORS support. Used by `npm run demo` and the e2e tests.
// Also serves virtual test media: /__media/<name>-<bytes>.bin (deterministic bytes) and
// /__media/<name>-<seconds>s.wav (a playable sine tone). Names starting with "slow" are throttled.
import { createServer as createHttpServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.bin': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8', '.vtt': 'text/vtt',
};

function pseudoBytes(n, seed) {
  const out = Buffer.allocUnsafe(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

function wav(seconds, freq = 440) {
  const rate = 8000;
  const samples = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000), 44 + i * 2);
  return buf;
}

const virtualCache = new Map();
function virtualMedia(name) {
  if (virtualCache.has(name)) return virtualCache.get(name);
  let m = /^([a-z0-9_]+)-(\d+)\.bin$/i.exec(name);
  let body;
  if (m) body = pseudoBytes(Number(m[2]), [...m[1]].reduce((a, c) => a + c.charCodeAt(0), 7));
  else if ((m = /^([a-z0-9_]+)-(\d+)s\.wav$/i.exec(name))) body = wav(Number(m[2]));
  if (!body) return undefined;
  const entry = { body, slow: name.startsWith('slow'), etag: `"${name}"`, type: TYPES[extname(name)] };
  virtualCache.set(name, entry);
  return entry;
}

/**
 * @param {{ root: string, port?: number, host?: string, log?: boolean, throttle?: { chunk: number, delayMs: number } }} options
 */
export function createServer({ root, port = 0, host = '127.0.0.1', log = false, throttle = { chunk: 64 * 1024, delayMs: 40 } }) {
  const requests = [];
  const base = resolve(root);
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const entry = { method: req.method, path: url.pathname, search: url.search, range: req.headers.range ?? null, ifRange: req.headers['if-range'] ?? null, time: Date.now() };
    requests.push(entry);
    if (log) console.log(req.method, url.pathname, req.headers.range ?? '');
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range, If-Range',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, ETag, Accept-Ranges',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    };
    if (req.method === 'OPTIONS') return res.writeHead(204, headers).end();
    if (url.pathname.startsWith('/__redirect/')) {
      // Like Hugging Face's /resolve/: a 302 to a fresh "signed" URL on every request.
      const target = `/__media/${url.pathname.slice('/__redirect/'.length)}?sig=${Math.random().toString(36).slice(2)}&exp=${Date.now() + 3600_000}`;
      return res.writeHead(302, { ...headers, Location: target }).end();
    }
    if (url.pathname === '/__requests') {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(requests.filter((r) => r.path.startsWith('/__media/') || r.path.startsWith('/__redirect/'))));
    }

    let body;
    let slow = false;
    let etag;
    let type;
    if (url.pathname.startsWith('/__media/')) {
      const v = virtualMedia(url.pathname.slice('/__media/'.length));
      if (!v) return res.writeHead(404, headers).end('not found');
      ({ body, slow, etag, type } = v);
    } else {
      let path = normalize(join(base, decodeURIComponent(url.pathname)));
      if (!path.startsWith(base)) return res.writeHead(403, headers).end();
      try {
        if (statSync(path).isDirectory()) path = join(path, 'index.html');
        const st = statSync(path);
        etag = `"${st.size}-${Math.round(st.mtimeMs)}"`;
        type = TYPES[extname(path)] ?? 'application/octet-stream';
        body = { path, size: st.size };
      } catch {
        return res.writeHead(404, headers).end('not found');
      }
    }
    const size = Buffer.isBuffer(body) ? body.length : body.size;
    Object.assign(headers, { 'Content-Type': type, ETag: etag });
    if (url.pathname.endsWith('sw.js')) headers['Service-Worker-Allowed'] = '/';

    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = req.headers.range;
    const ifRange = req.headers['if-range'];
    if (range && (!ifRange || ifRange === etag)) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        if (m[1] === '') start = Math.max(0, size - Number(m[2]));
        else {
          start = Number(m[1]);
          if (m[2]) end = Math.min(size - 1, Number(m[2]));
        }
        if (start >= size || start > end) {
          return res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }).end();
        }
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      }
    }
    headers['Content-Length'] = String(end - start + 1);
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    if (!Buffer.isBuffer(body)) return createReadStream(body.path, { start, end }).pipe(res);
    const data = body.subarray(start, end + 1);
    if (!slow) return res.end(data);
    let offset = 0;
    const pump = () => {
      if (res.destroyed) return;
      if (offset >= data.length) return res.end();
      const next = data.subarray(offset, offset + throttle.chunk);
      offset += next.length;
      res.write(next);
      setTimeout(pump, throttle.delayMs);
    };
    pump();
  });
  return new Promise((resolveListen) => {
    server.listen(port, host, () => {
      const { port: actual } = server.address();
      resolveListen({ server, port: actual, origin: `http://${host}:${actual}`, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? '.';
  const port = Number(process.env.PORT ?? 5173);
  const { origin } = await createServer({ root, port, host: process.env.HOST ?? '127.0.0.1', log: !!process.env.LOG });
  console.log(`Serving ${resolve(root)} at ${origin}`);
}
