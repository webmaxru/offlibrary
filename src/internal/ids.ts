/** Prefix of every Background Fetch id and cache name Offlibrary owns. */
export const PREFIX = 'offlibrary';

/** @internal */
export const scopeOf = (namespace: string, collection: string): string => `${namespace}/${collection}`;
/** @internal */
export const itemKey = (namespace: string, collection: string, id: string): string =>
  `${namespace}/${collection}/${id}`;
/** @internal */
export const cacheNameOf = (namespace: string, collection: string): string =>
  `${PREFIX}:${namespace}:${collection}`;
/** @internal Background Fetch id for an item key. */
export const bgFetchIdOf = (key: string): string => `${PREFIX}:${key}`;
/** @internal Item key for a Background Fetch id, or `undefined` if the id is not ours. */
export const keyFromBgFetchId = (id: string): string | undefined =>
  id.startsWith(`${PREFIX}:`) ? id.slice(PREFIX.length + 1) : undefined;
/** @internal */
export const partKeyOf = (key: string, index: number): string => `${key}#${index}`;
