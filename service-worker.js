const CACHE_NAME = 'finanzas-v1';
const ARCHIVOS = ['/', '/index.html'];

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(ARCHIVOS))
    );
});

self.addEventListener('fetch', e => {
    e.respondWith(
        caches.match(e.request).then(respuesta => respuesta || fetch(e.request))
    );
});