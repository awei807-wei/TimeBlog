const CACHE = 'timeline-shell-v3';
const APP_SHELL = ['/','/manifest.webmanifest','/robots.txt'];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_SHELL))); self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin') || url.pathname.startsWith('/login') || url.pathname.startsWith('/recovery') || url.pathname.startsWith('/private-media/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request);
        if (response.ok && url.origin === self.location.origin) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy)));
        }
        return response;
      } catch {
        return (await caches.match(event.request)) || caches.match('/');
      }
    })());
    return;
  }
  if (event.request.destination === 'image') {
    event.respondWith((async () => {
      const cached = await caches.match(event.request);
      const network = fetch(event.request).then(response => {
        if (response.ok && url.origin === self.location.origin) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy)));
        }
        return response;
      }).catch(() => undefined);
      if (cached) {
        void network;
        return cached;
      }
      return (await network) || caches.match('/');
    })());
    return;
  }
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => { const copy = response.clone(); if (response.ok && url.origin === self.location.origin) caches.open(CACHE).then(cache => cache.put(event.request, copy)); return response; })));
});
