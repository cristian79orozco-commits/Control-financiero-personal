const CACHE_NAME = 'finanzas-v3';
const BASE = '/Control-financiero-personal/';

const ARCHIVOS = [
    BASE,
    BASE + 'index.html',
    BASE + 'manifest.json',
    BASE + 'icon-192.png',
    BASE + 'icon-512.png'
];

// INSTALAR
self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(ARCHIVOS))
    );
});

// ACTIVAR
self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            )
        )
    );
});

// FETCH
self.addEventListener('fetch', e => {
    e.respondWith(
        caches.match(e.request).then(res => {
            return res || fetch(e.request).catch(() => caches.match(BASE + 'index.html'));
        })
    );
});
