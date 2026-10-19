// The Offlibrary Radio demo used to live at this path (/offlibrary/), and its service worker
// controlled the whole site. The demo moved to ./demo/, and this file replaces that old worker:
// it removes the old demo's app-shell caches, unregisters itself and reloads open pages, so
// returning visitors get the documentation site.
// Downloaded episodes (Offlibrary's caches and IndexedDB) are kept: the demo at ./demo/ uses them.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('radio-shell-')) await caches.delete(name);
      }
      await self.registration.unregister();
      for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url);
    })(),
  );
});
