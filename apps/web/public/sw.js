const CACHE = 'timeline-shell-v4';
const APP_SHELL = ['/','/manifest.webmanifest','/robots.txt'];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_SHELL))); self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())); });
self.addEventListener('message', event => {
  if (!event.data || event.data.type !== 'CACHE_INVALIDATE' || event.data.scope !== 'public-content') return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const requests = await cache.keys();
    await Promise.all(requests.map(request => {
      const url = new URL(request.url);
      const keep = url.origin === self.location.origin && APP_SHELL.includes(url.pathname);
      const mutable = url.origin === self.location.origin && (
        url.pathname === '/' || url.pathname.startsWith('/day/') || url.pathname.startsWith('/article/') ||
        url.pathname.startsWith('/categories/') || url.pathname.startsWith('/tag/') ||
        url.pathname.startsWith('/search') || url.pathname.startsWith('/calendar') || url.pathname === '/feed.xml'
      );
      return mutable && !keep ? cache.delete(request) : Promise.resolve(false);
    }));
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(client => client.postMessage({ type: 'CACHE_INVALIDATED', scope: 'public-content', entryId: event.data.entryId, reason: event.data.reason }));
  })());
});
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
