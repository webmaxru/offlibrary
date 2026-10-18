import { describe, expect, it } from 'vitest';
import { createRangeResponse, parseContentRange, parseRange } from '../src/internal/range.js';

describe('parseRange', () => {
  it('parses closed, open and suffix ranges', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=100-', 1000)).toEqual({ start: 100, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
  });
  it('clamps the end to the size', () => {
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
  });
  it('honours only the first of multiple ranges', () => {
    expect(parseRange('bytes=0-9, 20-29', 1000)).toEqual({ start: 0, end: 9 });
  });
  it('reports unsatisfiable ranges', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=50-10', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable');
  });
  it('ignores missing or malformed headers', () => {
    expect(parseRange(null, 10)).toBeNull();
    expect(parseRange('items=0-1', 10)).toBeNull();
    expect(parseRange('bytes=-', 10)).toBeNull();
  });
});

describe('createRangeResponse', () => {
  const full = () => new Response(new Uint8Array(Array.from({ length: 100 }, (_, i) => i)), { headers: { 'Content-Type': 'audio/mpeg' } });

  it('returns a 206 slice with Content-Range', async () => {
    const res = await createRangeResponse(full(), 'bytes=10-19');
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 10-19/100');
    expect(res.headers.get('Content-Length')).toBe('10');
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg');
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });
  it('answers bytes=0- with the whole body as 206 (what media elements send)', async () => {
    const res = await createRangeResponse(full(), 'bytes=0-');
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 0-99/100');
    expect((await res.arrayBuffer()).byteLength).toBe(100);
  });
  it('returns 416 for unsatisfiable ranges', async () => {
    const res = await createRangeResponse(full(), 'bytes=500-');
    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe('bytes */100');
  });
  it('passes through without a Range header', async () => {
    const original = full();
    expect(await createRangeResponse(original, null)).toBe(original);
  });
});

describe('parseContentRange', () => {
  it('parses totals and unknown totals', () => {
    expect(parseContentRange('bytes 10-19/100')).toEqual({ start: 10, end: 19, total: 100 });
    expect(parseContentRange('bytes 10-19/*')).toEqual({ start: 10, end: 19, total: 0 });
    expect(parseContentRange('nonsense')).toBeNull();
  });
});
