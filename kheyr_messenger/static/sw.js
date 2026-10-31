/* Kheyr messenger service worker.
   Pinned code is verified on every boot, so JS/CSS are served network-first:
   a cache-first policy would hand an old chat.js to checkCodeIntegrity() and
   trigger a key wipe. Fonts and icons are immutable and may be served stale. */

const VERSION = 'kheyr-v5';
const ASSET_CACHE = `${VERSION}-assets`;
const PAGE_CACHE = `${VERSION}-pages`;

const IMMUTABLE = [
    '/static/fonts/Vazirmatn-latin.woff2',
    '/static/fonts/Vazirmatn-latin-ext.woff2',
    '/static/fonts/Vazirmatn-arabic.woff2',
    '/static/icons/icon-192.png',
    '/static/icons/icon-512.png',
    '/offline/',
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(ASSET_CACHE)
            .then((c) => Promise.all(IMMUTABLE.map((p) => c.add(p).catch(() => null))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(
            keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))
        );
        await self.clients.claim();
    })());
});

function bypass(req, url) {
    if (req.method !== 'GET') return true;
    if (url.origin !== self.location.origin) return true;
    if (url.pathname === '/serviceworker.js') return true;
    if (url.pathname.startsWith('/api/')) return true;
    if (url.pathname.startsWith('/accounts/api/')) return true;
    if (url.pathname.startsWith('/media/')) return true;
    if (url.pathname.startsWith('/admin/')) return true;
    if (url.pathname.startsWith('/ws/')) return true;
    return false;
}

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);
    if (bypass(e.request, url)) return;

    if (url.pathname.startsWith('/static/')) {
        const immutable = url.pathname.startsWith('/static/fonts/') ||
            url.pathname.startsWith('/static/icons/');
        e.respondWith(immutable ? cacheFirst(e.request) : networkFirst(e.request, ASSET_CACHE));
        return;
    }

    if (e.request.mode === 'navigate') {
        e.respondWith(networkFirst(e.request, PAGE_CACHE, () => offlineFallback()));
    }
});

function cacheFirst(req) {
    return caches.match(req).then((hit) => hit || fetch(req).then((resp) => {
        const copy = resp.clone();
        caches.open(ASSET_CACHE).then((c) => c.put(req, copy));
        return resp;
    }));
}

function networkFirst(req, cacheName, onFailure) {
    // cache:'reload' — pinned code must never come from the HTTP cache; a stale
    // chat.js against fresh hashes would trip checkCodeIntegrity and wipe keys.
    return fetch(new Request(req, { cache: 'reload' })).then((resp) => {
        if (resp.ok) {
            const copy = resp.clone();
            caches.open(cacheName).then((c) => c.put(req, copy));
        }
        return resp;
    }).catch(() => caches.match(req).then((hit) => hit || (onFailure ? onFailure() : Response.error())));
}

function offlineFallback() {
    return caches.match('/offline/').then((hit) => hit || fetch('/offline/'));
}

self.addEventListener('push', (e) => {
    let data = {};
    try { data = e.data ? e.data.json() : {}; } catch (err) { data = {}; }

    const room = data.room_id || null;
    const tag = room ? `kheyr-room-${room}` : 'kheyr';
    const body = {
        tag,
        renotify: true,
        title: data.title || 'پیام‌رسان خیر',
        body: data.body || 'پیام جدید دارید.',
        icon: '/static/icons/icon-192.png',
        badge: '/static/icons/icon-192.png',
        dir: 'rtl',
        lang: 'fa',
        data: { room_id: room },
        vibrate: [80, 40, 80],
    };
    if (room) body.actions = [{ action: 'reply', title: 'باز کردن' }];
    e.waitUntil(self.registration.showNotification('پیام‌رسان خیر', body));
});

self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    const room = e.notification.data && e.notification.data.room_id;
    const target = room ? `/rooms/${room}/` : '/rooms/';
    e.waitUntil((async () => {
        const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of all) {
            if ('focus' in client) {
                if (client.url.includes(target)) return client.focus();
                return client.navigate(target).then(() => client.focus());
            }
        }
        return self.clients.openWindow(target);
    })());
});
