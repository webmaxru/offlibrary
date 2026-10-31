import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createOfflibrary, OfflibraryError } from '../src/index.js';
import type { Offlibrary, OfflibraryConfig } from '../src/index.js';
import { bytes, mockServer } from './helpers.js';

const A = 'https://cdn.test/model.onnx';
const sri = (b: Uint8Array) => `sha256-${createHash('sha256').update(b).digest('base64')}`;

const libs: Offlibrary[] = [];
function make(collection: OfflibraryConfig['collections'][string] = {}) {
  const lib = createOfflibrary({ serviceWorker: false, persist: 'never', progressInterval: 0, collections: { models: { retryDelay: 1, ...collection } } });
  libs.push(lib);
  return lib;
}
afterEach(() => {
  for (const l of libs.splice(0)) l.destroy();
  vi.unstubAllGlobals();
});

describe('collection.adopt()', () => {
  it('takes over bytes already on the device as a completed item, with no network request', async () => {
    const file = bytes(40_000);
    const server = mockServer({ [A]: file });
    vi.stubGlobal('fetch', server.fetch);
    const lib = make();
    const models = lib.collection('models');
    const completes: string[] = [];
    lib.on('complete', ({ item }) => completes.push(item.id));

    const item = await models.adopt({ id: 'm', url: A, size: file.length, integrity: sri(file), pinned: true }, new Blob([file]));
    expect(item).toMatchObject({ status: 'completed', bytes: 40_000, total: 40_000, progress: 1, pinned: true, storage: 'cache' });
    expect(new Uint8Array((await models.bytes('m'))!)).toEqual(file);
    expect(server.requests).toHaveLength(0);
    expect(completes).toEqual(['m']);
    // A later download() of the same item is a no-op: it is already complete.
    const again = await models.download({ id: 'm', url: A, size: file.length, integrity: sri(file) });
    expect(again.status).toBe('completed');
    expect(server.requests).toHaveLength(0);
  });

  it('refuses bytes that do not match the integrity value and stores nothing', async () => {
    const file = bytes(10_000);
    const other = bytes(10_000, 7);
    const lib = make();
    const models = lib.collection('models');
    const err = await models.adopt({ id: 'm', url: A, integrity: sri(other) }, new Blob([file])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OfflibraryError);
    expect((err as OfflibraryError).code).toBe('integrity');
    expect(await models.has('m')).toBe(false);
  });

  it('refuses a size mismatch', async () => {
    const lib = make();
    const err = await lib.collection('models').adopt({ id: 'm', url: A, size: 5 }, new Blob([bytes(6)])).catch((e: unknown) => e);
    expect((err as OfflibraryError).code).toBe('integrity');
  });

  it('is a no-op for an item that is already completed with the same content', async () => {
    const file = bytes(2_000);
    const lib = make();
    const models = lib.collection('models');
    await models.adopt({ id: 'm', url: A, version: '1' }, new Blob([file]));
    const wrong = new Blob([bytes(2_000, 3)]);
    const item = await models.adopt({ id: 'm', url: A, version: '1' }, wrong);
    expect(item.status).toBe('completed');
    expect(new Uint8Array((await models.bytes('m'))!)).toEqual(file);
  });

  it('replaces a different version', async () => {
    const lib = make();
    const models = lib.collection('models');
    await models.adopt({ id: 'm', url: A, version: '1' }, new Blob([bytes(100)]));
    const v2 = bytes(300, 9);
    const item = await models.adopt({ id: 'm', url: A, version: '2' }, new Blob([v2]));
    expect(item).toMatchObject({ version: '2', bytes: 300 });
    expect(new Uint8Array((await models.bytes('m'))!)).toEqual(v2);
  });

  it('needs one source per URL', async () => {
    const lib = make();
    const err = await lib
      .collection('models')
      .adopt({ id: 'm', urls: [A, `${A}.json`] }, new Blob([bytes(1)]))
      .catch((e: unknown) => e);
    expect((err as OfflibraryError).code).toBe('invalid-item');
  });
});
