const CACHE_NAME = 'chetnasync-v3';
const urlsToCache = [
  '/',
  '/index.html',
  '/home.html',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.map(key => {
        if (key !== CACHE_NAME) return caches.delete(key);
      })
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  
  if (url.pathname.endsWith('.html') || url.pathname === '/' || event.request.url.includes('cartocdn.com') || event.request.url.includes('unpkg.com')) {
    event.respondWith(
      fetch(event.request).then(fetchRes => {
        if (event.request.url.includes('cartocdn.com') || event.request.url.includes('unpkg.com')) {
          // Note: In production, tile cache entries should be bounded (e.g., by a max-age or LRU policy).
          const resClone = fetchRes.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, resClone));
        }
        return fetchRes;
      }).catch(() => {
        return caches.match(event.request);
      })
    );
    return;
  }
  
  if (event.request.method === 'GET' && (url.pathname === '/api/hazard' || url.pathname === '/api/verified-shelters')) {
    event.respondWith(
      fetch(event.request).then(res => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, resClone));
        return res;
      }).catch(() => caches.match(event.request))
    );
    return;
  }
  
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(error => {
        return new Response(JSON.stringify({ error: 'Network failure' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
