importScripts('/dist/offlibrary-sw.iife.js');
offlibrary.offlibrarySW();
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
