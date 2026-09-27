/* 极简离线壳：只缓存静态外壳，绝不缓存 /api/ 请求 */
const CACHE = 'libseat-shell-celebration-v5';
const SHELL = ['/', '/index.html', '/study-font.css', '/study-sans-0.ttf', '/study-sans-1.ttf', '/warm-study.css', '/warm-study.js', '/desktop-study.css', '/desktop-study.js', '/booking-notifications.js', '/app.png', '/app.ico', '/app-192.png', '/app-512.png', '/app-180.png', '/app-book-chair.ico', '/manifest.webmanifest'];

SHELL.push('/booking-celebration.css', '/booking-celebration.js');

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;  // 动态数据永远走网络
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('/index.html')))
  );
});


