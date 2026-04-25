const CACHE_VERSION = 'v10';
const CACHE_NAME = 'tlo-roulette-' + CACHE_VERSION;
const urlsToCache = [
  '/roulette/',
  '/roulette/index.html'
];

// 安裝 Service Worker
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

// 取得快取內容 - index.html 和 /roulette/ 路徑都不快取，永遠拿新版本
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // index.html 和 /roulette/ 永遠從網路拿，不 cache
  if (url.pathname.endsWith('index.html') || url.pathname === '/roulette/' || url.pathname.endsWith('/roulette')) {
    event.respondWith(fetch(event.request));
    return;
  }
  if (event.request.method !== 'GET') { event.respondWith(fetch(event.request)); return; }
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const responseToCache = response.clone();
        caches.open(CACHE_NAME)
          .then(cache => {
            cache.put(event.request, responseToCache);
          });
        return response;
      })
      .catch(() => {
        return caches.match(event.request);
      })
  );
});

// 更新快取
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName.startsWith('tlo-roulette-') && cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});
