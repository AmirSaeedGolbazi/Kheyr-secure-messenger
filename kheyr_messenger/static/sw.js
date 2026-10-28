const CACHE_NAME = 'kheyr-static-v3';
const STATIC_ASSETS = [
    '/static/css/style.css',
    '/static/js/tweetnacl.min.js',
    '/static/js/crypto.js',
    '/static/js/keydb.js',
    '/static/js/auth.js',
    '/static/js/integrity.js',
    '/static/js/chat.js',
    '/static/js/livekit_e2ee.js',
];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(STATIC_ASSETS)));
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);
    if (e.request.method !== 'GET') return;
    if (url.pathname.startsWith('/api/') ||
        url.pathname.startsWith('/accounts/api/') ||
        url.pathname.startsWith('/ws/') ||
        url.pathname.startsWith('/admin/')) {
        return;
    }
    if (e.request.mode === 'navigate') {
        e.respondWith(fetch(e.request).catch(() =>
            new Response('offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
        ));
        return;
    }
    if (url.pathname.startsWith('/static/')) {
        e.respondWith(
            caches.match(e.request).then(r => r || fetch(e.request).then(resp => {
                const clone = resp.clone();
                caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
                return resp;
            }))
        );
    }
});