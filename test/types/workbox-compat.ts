// Compile-time check: Offlibrary's Workbox objects fit Workbox's own types (workbox-core 7).
// Run by `npm run typecheck`; never executed.
import type { RouteHandler, RouteMatchCallback, WorkboxPlugin } from 'workbox-core/types.js';
import { CacheFirst, NetworkOnly } from 'workbox-strategies';
import { registerRoute } from 'workbox-routing';
import { OfflibraryPlugin, offlibraryHandler, offlibraryMatch } from '../../src/workbox.js';

const plugin: WorkboxPlugin = new OfflibraryPlugin();
const match: RouteMatchCallback = offlibraryMatch;
const handler: RouteHandler = offlibraryHandler({ fallback: new NetworkOnly() });
registerRoute(offlibraryMatch, offlibraryHandler());
registerRoute(({ request }) => request.destination === 'audio', new CacheFirst({ plugins: [new OfflibraryPlugin()] }));
export { plugin, match, handler };
