const CACHE_PREFIX = 'timeline-shell-';
const CACHE = 'timeline-shell-v7';
const APP_SHELL = ['/','/manifest.webmanifest','/robots.txt'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});
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

function isCacheable(response) {
  return response.ok && !/(?:^|,)\s*(?:no-store|private)\b/i.test(response.headers.get('Cache-Control') || '');
}

function isImmutable(response) {
  return response && isCacheable(response) && /(?:^|,)\s*immutable\b/i.test(response.headers.get('Cache-Control') || '');
}

function storeResponse(event, cache, response) {
  const url = new URL(event.request.url);
  if (response.ok && url.origin === self.location.origin && isCacheable(response)) {
    event.waitUntil(cache.put(event.request, response.clone()));
  }
  return response;
}

async function immutableAsset(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(event.request);
  if (isImmutable(cached)) return cached;
  const response = await fetch(event.request);
  if (isImmutable(response)) storeResponse(event, cache, response);
  return response;
}

async function networkFirst(event, navigation = false) {
  const cache = await caches.open(CACHE);
  try {
    return storeResponse(event, cache, await fetch(event.request));
  } catch (error) {
    const cached = await cache.match(event.request) || (navigation ? await cache.match('/') : undefined);
    if (cached) return cached;
    throw error;
  }
}

async function cachedImage(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(event.request);
  const network = fetch(event.request).then(response => storeResponse(event, cache, response));
  if (!cached) return network;
  event.waitUntil(network.catch(() => cached));
  return cached;
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  const headers = event.request.headers;
  if (url.origin !== self.location.origin || event.request.cache === 'no-store') return;
  if (url.searchParams.has('_rsc') || headers.get('RSC') === '1' || headers.has('Next-Router-Prefetch') || headers.get('Accept')?.includes('text/x-component')) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin') || url.pathname.startsWith('/login') || url.pathname.startsWith('/recovery') || url.pathname.startsWith('/private-media/') || url.pathname.startsWith('/preview/')) return;
  if (url.pathname.startsWith('/search')) {
    event.respondWith(fetch(event.request));
    return;
  }
  if (url.pathname.startsWith('/_next/')) {
    if (url.pathname.startsWith('/_next/static/')) event.respondWith(immutableAsset(event));
    return;
  }
  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirst(event, true));
    return;
  }
  if (event.request.destination === 'image') {
    event.respondWith(cachedImage(event));
    return;
  }
  event.respondWith(networkFirst(event));
});
