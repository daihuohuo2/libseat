/* 极简离线壳：只缓存静态外壳，绝不缓存 /api/ 请求 */
const ASSET_VERSION = 'v0.2.1';
const CACHE = 'libseat-shell-' + ASSET_VERSION;
const SHELL = ['/', '/index.html', '/study-font.css', '/study-sans-0.ttf', '/study-sans-1.ttf', '/warm-study.css', '/warm-study.js', '/desktop-study.css', '/desktop-study.js', '/booking-notifications.js', '/app.png', '/app.ico', '/app-192.png', '/app-512.png', '/app-180.png', '/app-book-chair.ico', '/manifest.webmanifest'];

SHELL.push('/booking-celebration.css', '/booking-celebration.js');
SHELL.push('/booking-management.css', '/booking-management-ui.js');
SHELL.push('/compact-ui.css');
SHELL.push('/renewal.css', '/renewal-ui.js');
SHELL.push('/seat-map.css', '/seat-map.js');
SHELL.push('/area-seat-prefs.js', '/area-seat-prefs-ui.js', '/area-seat-prefs.css');
const VERSIONED_SHELL = SHELL.map(url => /\.(js|css)$/.test(url) ? url + '?v=' + ASSET_VERSION : url);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(VERSIONED_SHELL.map(url => new Request(url, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('libseat-shell-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;  // 动态数据永远走网络
  e.respondWith(
    // Network-first must bypass fresh HTTP caches too, including old server headers.
    fetch(e.request, { cache: 'no-cache' }).then(res => {
      if (res.ok) {
        const copy = res.clone();
        e.waitUntil(caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {}));
      }
      return res;
    }).catch(async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(e.request);
      if (cached) return cached;
      // An HTML fallback for missing JS/CSS breaks the entire page on reconnection.
      if (e.request.mode === 'navigate') return (await cache.match('/index.html')) || Response.error();
      return Response.error();
    })
  );
});


