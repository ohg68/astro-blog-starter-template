var CACHE_NAME = 'cotizador-euro-v1';
var ASSETS = ['cotizador-euro.html', 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'];
self.addEventListener('install', function(e) { e.waitUntil(caches.open(CACHE_NAME).then(function(c) { return c.addAll(ASSETS); })); self.skipWaiting(); });
self.addEventListener('activate', function(e) { e.waitUntil(caches.keys().then(function(k) { return Promise.all(k.filter(function(n) { return n !== CACHE_NAME; }).map(function(n) { return caches.delete(n); })); })); self.clients.claim(); });
self.addEventListener('fetch', function(e) { if (e.request.url.includes('exchangerate-api')) { e.respondWith(fetch(e.request).catch(function() { return caches.match(e.request); })); return; } e.respondWith(caches.match(e.request).then(function(r) { return r || fetch(e.request); })); });
