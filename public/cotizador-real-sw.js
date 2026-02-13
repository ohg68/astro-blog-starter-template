var CACHE_NAME = 'cotizador-real-v1';
var ASSETS = [
    'cotizador-real.html',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'
];

self.addEventListener('install', function(e) {
    e.waitUntil(
        caches.open(CACHE_NAME).then(function(cache) { return cache.addAll(ASSETS); })
    );
    self.skipWaiting();
});

self.addEventListener('activate', function(e) {
    e.waitUntil(
        caches.keys().then(function(keys) {
            return Promise.all(keys.filter(function(k) { return k !== CACHE_NAME; }).map(function(k) { return caches.delete(k); }));
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', function(e) {
    if (e.request.url.includes('exchangerate-api')) {
        e.respondWith(fetch(e.request).catch(function() { return caches.match(e.request); }));
        return;
    }
    e.respondWith(
        caches.match(e.request).then(function(cached) { return cached || fetch(e.request); })
    );
});
