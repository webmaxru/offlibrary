/**
 * Offlibrary for Workbox service workers.
 *
 * Serve files that Offlibrary downloaded (with `Range` support, so `<audio>` and `<video>` seek
 * offline) from inside Workbox routes and strategies, and handle Background Fetch events next to
 * Workbox's own routing.
 *
 * This entry imports nothing from Workbox: the plugin and route handler are plain objects that
 * match Workbox's plugin and route-handler interfaces (Workbox 6 and 7, bundled or via `workbox-sw`).
 *
 * ```js
 * // sw.js
 * import { precacheAndRoute } from 'workbox-precaching';
 * import { registerRoute } from 'workbox-routing';
 * import { NetworkOnly } from 'workbox-strategies';
 * import { initOfflibrary, offlibraryMatch, offlibraryHandler } from 'offlibrary/workbox';
 *
 * initOfflibrary();
 * precacheAndRoute(self.__WB_MANIFEST);
 * registerRoute(offlibraryMatch, offlibraryHandler({ fallback: new NetworkOnly() }));
 * ```
 * @packageDocumentation
 * @module offlibrary/workbox
 */
import { isOfflibraryRequest, matchOfflibrary, watchIndex } from './internal/serve.js';
import { offlibrarySW } from './sw.js';
import type { OfflibrarySWOptions } from './sw.js';

export { isOfflibraryRequest, matchOfflibrary } from './internal/serve.js';

/**
 * Options Workbox passes to route match callbacks. Structurally compatible with
 * `RouteMatchCallbackOptions` from `workbox-core`.
 */
export interface WorkboxRouteMatchOptions {
  request: Request;
  url?: URL;
  sameOrigin?: boolean;
  event?: unknown;
}

/**
 * Options Workbox passes to route handlers. Structurally compatible with
 * `RouteHandlerCallbackOptions` from `workbox-core`.
 */
export interface WorkboxRouteHandlerOptions {
  request: Request | string;
  /** The `FetchEvent` (or other `ExtendableEvent`) being handled. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Workbox types this as ExtendableEvent; kept loose so strategies fit without a Workbox import.
  event: any;
  url?: URL;
  params?: unknown;
}

/** A Workbox route handler: a callback, or an object with `handle()` such as a strategy instance. */
export type WorkboxRouteHandler =
  | ((options: WorkboxRouteHandlerOptions) => Promise<Response>)
  | { handle(options: WorkboxRouteHandlerOptions): Promise<Response> };

/**
 * Workbox route match callback: true when the request is for a file Offlibrary has stored.
 *
 * Synchronous, as Workbox requires. While the routing index is still loading right after the
 * service worker starts, audio, video, track and image requests and any `Range` request are matched
 * as well; {@link offlibraryHandler} then answers them from the device or passes them to its
 * `fallback`. Register this route before broader media routes.
 *
 * @example
 * ```js
 * registerRoute(offlibraryMatch, offlibraryHandler({ fallback: new NetworkOnly() }));
 * ```
 */
export const offlibraryMatch = (options: WorkboxRouteMatchOptions): boolean => isOfflibraryRequest(options.request);

/** Options for {@link offlibraryHandler}. */
export interface OfflibraryHandlerOptions {
  /**
   * What to do when the file is not stored: a Workbox strategy (`new NetworkOnly()`,
   * `new CacheFirst({ cacheName: 'media' })`…), any route handler, or nothing for a plain `fetch()`.
   */
  fallback?: WorkboxRouteHandler;
}

/**
 * A Workbox route handler that answers from Offlibrary's storage (`200`, or `206` for `Range`) and
 * otherwise hands the request to `fallback` (default: the network).
 *
 * @example
 * ```js
 * import { registerRoute } from 'workbox-routing';
 * import { NetworkOnly } from 'workbox-strategies';
 * import { offlibraryMatch, offlibraryHandler } from 'offlibrary/workbox';
 *
 * registerRoute(offlibraryMatch, offlibraryHandler({ fallback: new NetworkOnly() }));
 * ```
 */
export function offlibraryHandler(options: OfflibraryHandlerOptions = {}): { handle(options: WorkboxRouteHandlerOptions): Promise<Response> } {
  const { fallback } = options;
  return {
    async handle(params: WorkboxRouteHandlerOptions): Promise<Response> {
      const request = typeof params.request === 'string' ? new Request(params.request) : params.request;
      const stored = await matchOfflibrary(request);
      if (stored) return stored;
      if (!fallback) return fetch(request);
      const next = { ...params, request };
      return typeof fallback === 'function' ? fallback(next) : fallback.handle(next);
    },
  };
}

/** Options for {@link OfflibraryPlugin}. */
export interface OfflibraryPluginOptions {
  /**
   * Answer from Offlibrary's storage when the strategy's own cache has no entry
   * (`cachedResponseWillBeUsed`: CacheFirst, CacheOnly, StaleWhileRevalidate, NetworkFirst's cache step).
   * Default `true`.
   */
  serveFromCache?: boolean;
  /**
   * Answer from Offlibrary's storage when the strategy fails, e.g. offline under NetworkOnly or
   * NetworkFirst (`handlerDidError`). Default `true`.
   */
  fallbackOnError?: boolean;
}

/** Parameters Workbox passes to `cachedResponseWillBeUsed` (structural subset). */
export interface CachedResponseWillBeUsedParam {
  request: Request;
  cachedResponse?: Response;
  cacheName?: string;
  event?: unknown;
  state?: unknown;
}

/** Parameters Workbox passes to `handlerDidError` (structural subset). */
export interface HandlerDidErrorParam {
  request: Request;
  error?: unknown;
  event?: unknown;
  state?: unknown;
}

/**
 * Workbox plugin that lets any strategy serve files Offlibrary has stored, with `Range` support.
 *
 * - `cachedResponseWillBeUsed`: when the strategy's cache has no entry for the URL, the stored file
 *   is used instead. A stored file wins over the runtime cache, because it is the copy the user
 *   chose to download and it has been verified. `Range` requests get a `206`.
 * - `handlerDidError`: when the strategy fails (offline under `NetworkOnly`/`NetworkFirst`), the
 *   stored file becomes the response.
 *
 * Requests for files Offlibrary does not store pass through untouched.
 *
 * @example
 * ```js
 * import { registerRoute } from 'workbox-routing';
 * import { CacheFirst } from 'workbox-strategies';
 * import { OfflibraryPlugin } from 'offlibrary/workbox';
 *
 * registerRoute(
 *   ({ request }) => request.destination === 'audio',
 *   new CacheFirst({ cacheName: 'audio', plugins: [new OfflibraryPlugin()] }),
 * );
 * ```
 */
export class OfflibraryPlugin {
  /** Workbox plugin callback. Not meant to be called directly. */
  readonly cachedResponseWillBeUsed?: (param: CachedResponseWillBeUsedParam) => Promise<Response | undefined | null>;
  /** Workbox plugin callback. Not meant to be called directly. */
  readonly handlerDidError?: (param: HandlerDidErrorParam) => Promise<Response | undefined>;

  constructor(options: OfflibraryPluginOptions = {}) {
    watchIndex();
    // Arrow functions as own properties, the way Workbox's own plugins are written, so the
    // callbacks work however they are invoked.
    if (options.serveFromCache !== false) {
      this.cachedResponseWillBeUsed = async ({ request, cachedResponse }) =>
        (await matchOfflibrary(request)) ?? cachedResponse ?? null;
    }
    if (options.fallbackOnError !== false) {
      this.handlerDidError = async ({ request }) => matchOfflibrary(request);
    }
  }
}

/** Options for {@link initOfflibrary}: everything {@link offlibrarySW} takes except `serve`. */
export type InitOfflibraryOptions = Omit<OfflibrarySWOptions, 'serve'>;

/**
 * Install Offlibrary's Background Fetch handling in a Workbox service worker, without adding a
 * `fetch` listener: stored files are served through your Workbox routes ({@link offlibraryMatch} +
 * {@link offlibraryHandler}, or {@link OfflibraryPlugin}). Same as `offlibrarySW({ serve: false })`.
 * Call it once at the top level of the service worker.
 */
export function initOfflibrary(options: InitOfflibraryOptions = {}): void {
  offlibrarySW({ ...options, serve: false });
}
