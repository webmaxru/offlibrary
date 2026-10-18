// Service worker for Offlibrary Radio.
// 1) Offlibrary handles Background Fetch events and serves downloaded episodes (with Range support).
// 2) A tiny app-shell cache makes the UI itself open offline.
import { offlibrarySW } from 'offlibrary/sw';

offlibrarySW();

const SHELL_CACHE = `radio-shell-${__SHELL_VERSION__}`;
const SHELL = __SHELL_FILES__;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('radio-shell-') && name !== SHELL_CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  // Network-first for the shell so updates show up, cache when offline.
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        const fresh = await fetch(request);
        if (fresh.ok && SHELL.some((p) => new URL(p, self.registration.scope).href === request.url.split('?')[0])) {
          cache.put(request, fresh.clone());
        }
        return fresh;
      } catch {
        const cached = (await cache.match(request, { ignoreSearch: true })) ?? (request.mode === 'navigate' ? await cache.match('./') : undefined);
        return cached ?? Response.error();
      }
    })(),
  );
});
