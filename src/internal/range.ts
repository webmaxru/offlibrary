/** A resolved byte range, inclusive on both ends. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parse a `Range` header against a known size.
 * Returns `null` when there is no usable range (serve the full body),
 * or `'unsatisfiable'` when the range lies outside the resource (answer 416).
 * Only the first range of a multi-range request is honoured.
 */
export function parseRange(header: string | null | undefined, size: number): ByteRange | null | 'unsatisfiable' {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*(?:,|$)/i.exec(header);
  if (!m) return null;
  const [, a = '', b = ''] = m;
  if (a === '' && b === '') return null;
  let start: number;
  let end: number;
  if (a === '') {
    // Suffix range: last N bytes.
    const n = Number(b);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

/**
 * Build a `206 Partial Content` (or `416`) response for `rangeHeader` from a full cached response.
 * If there is no range header, the original response is returned untouched.
 * Inspired by workbox-range-requests (MIT); independent implementation.
 */
export async function createRangeResponse(response: Response, rangeHeader: string | null | undefined): Promise<Response> {
  if (!rangeHeader || response.status !== 200) return response;
  const blob = await response.blob();
  const range = parseRange(rangeHeader, blob.size);
  const headers = new Headers(response.headers);
  headers.set('Accept-Ranges', 'bytes');
  if (range === null) {
    headers.set('Content-Length', String(blob.size));
    return new Response(blob, { status: 200, statusText: 'OK', headers });
  }
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      statusText: 'Range Not Satisfiable',
      headers: { 'Content-Range': `bytes */${blob.size}` },
    });
  }
  const slice = blob.slice(range.start, range.end + 1);
  headers.set('Content-Range', `bytes ${range.start}-${range.end}/${blob.size}`);
  headers.set('Content-Length', String(slice.size));
  return new Response(slice, { status: 206, statusText: 'Partial Content', headers });
}

/** @internal Parse `Content-Range: bytes a-b/total`. */
export function parseContentRange(header: string | null): { start: number; end: number; total: number } | null {
  if (!header) return null;
  const m = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/i.exec(header);
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? 0 : Number(m[3]) };
}
