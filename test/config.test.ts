import { describe, expect, it } from 'vitest';
import { resolveConfig, validateItem } from '../src/config.js';
import { OfflibraryError } from '../src/errors.js';

const abs = (u: string) => new URL(u, 'https://app.test/').href;

describe('resolveConfig', () => {
  it('fills defaults', () => {
    const c = resolveConfig({ collections: { episodes: {} } });
    expect(c.namespace).toBe('default');
    expect(c.persist).toBe('on-download');
    expect(c.resumeOnStart).toBe(true);
    expect(c.collections.episodes).toMatchObject({
      strategy: 'auto',
      backgroundFetchThreshold: 5 * 1024 * 1024,
      autoSize: true,
      evict: 'lru',
      retries: 3,
      retryDelay: 1000,
      resumable: true,
    });
  });

  it.each([
    [{ collections: {} }, /at least one collection/],
    [{ namespace: 'a b', collections: { x: {} } }, /namespace/],
    [{ collections: { 'bad name': {} } }, /collection name/],
    [{ collections: { x: { strategy: 'magic' } } }, /strategy/],
    [{ collections: { x: { maxItems: 1.5 } } }, /maxItems/],
    [{ collections: { x: { maxBytes: -1 } } }, /maxBytes/],
    [{ collections: { x: { evict: 'fifo' } } }, /evict/],
    [{ persist: 'always', collections: { x: {} } }, /persist/],
  ])('rejects %j', (cfg, msg) => {
    expect(() => resolveConfig(cfg as never)).toThrow(msg);
    try {
      resolveConfig(cfg as never);
    } catch (e) {
      expect(e).toBeInstanceOf(OfflibraryError);
      expect((e as OfflibraryError).code).toBe('invalid-config');
    }
  });
});

describe('validateItem', () => {
  it('resolves relative URLs', () => {
    expect(validateItem({ id: 'a', url: '/m/a.mp3' }, abs)).toEqual(['https://app.test/m/a.mp3']);
    expect(validateItem({ id: 'a', urls: ['a.mp4', 'a.vtt'] }, abs)).toHaveLength(2);
  });
  it.each([
    [{ url: 'x' }, /id/],
    [{ id: 'a' }, /url/],
    [{ id: 'a', urls: [] }, /url/],
    [{ id: 'a', url: 'data:text/plain,hi' }, /http/],
    [{ id: 'a', urls: ['x', 'x'] }, /same URL twice/],
    [{ id: 'a', url: 'x', size: -3 }, /size/],
    [{ id: 'a', urls: ['x', 'y'], integrity: 'sha256-abc' }, /integrity/],
  ])('rejects %j', (item, msg) => {
    expect(() => validateItem(item as never, abs)).toThrow(msg);
  });
});
