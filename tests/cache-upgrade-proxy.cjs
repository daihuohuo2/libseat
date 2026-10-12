'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');

// Emulate a still-running old server and an existing browser profile, without real accounts.
module.exports = async function cacheUpgradeProxy(backend, t) {
  let unversionedMapRequests = 0, revision = 1;
  const legacyWorker = `
    self.addEventListener('install', e => e.waitUntil(self.skipWaiting()));
    self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
    self.addEventListener('fetch', e => {
      if (e.request.method !== 'GET' || new URL(e.request.url).pathname.startsWith('/api/')) return;
      e.respondWith(fetch(e.request).then(res => {
        const copy = res.clone();
        e.waitUntil(caches.open('libseat-shell-compact-renewal-v12').then(c => c.put(e.request, copy)));
        return res;
      }).catch(() => caches.match(e.request).then(r => r || caches.match('/index.html'))));
    });`;
  const proxy = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, backend);
      res.setHeader('Cache-Control', 'no-cache');
      if (url.pathname === '/__cache-prime') {
        res.setHeader('Content-Type', 'text/html');
        return res.end(`<script src="/seat-map.js"></script><script>
          navigator.serviceWorker.register('/__legacy-sw.js', {scope:'/'});
        </script>`);
      }
      if (url.pathname === '/__legacy-sw.js') {
        res.setHeader('Content-Type', 'application/javascript'); return res.end(legacyWorker);
      }
      if (url.pathname === '/__cache-stats') {
        res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ unversionedMapRequests }));
      }
      if (url.pathname === '/__advance-assets') { revision++; return res.end('ok'); }
      if (url.pathname === '/seat-map.js') {
        res.setHeader('Content-Type', 'application/javascript');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        const source = fs.readFileSync(path.join(__dirname, '../public/seat-map.js'), 'utf8');
        const stale = !url.search && ++unversionedMapRequests === 1;
        return res.end(source + (stale ? '\ndelete globalThis.SeatMap.isMine;' : '') + '\nglobalThis.testAssetRevision=' + revision + ';');
      }
      const chunks = []; for await (const c of req) chunks.push(c);
      const response = await fetch(backend + (url.pathname === '/__legacy-page' ? '/' : req.url), {
        method: req.method, headers: { 'Content-Type': req.headers['content-type'] || 'application/json' },
        body: chunks.length ? Buffer.concat(chunks) : undefined
      });
      res.statusCode = response.status;
      res.setHeader('Content-Type', response.headers.get('content-type') || 'text/plain');
      if (/\.(js|css)$/.test(url.pathname)) res.setHeader('Cache-Control', 'public, max-age=3600');
      if (url.pathname === '/__legacy-page') {
        const html = (await response.text()).replace(/\?v=v0.2.1/g, '')
          .replace(/  window.addEventListener\('load', \(\) => navigator.serviceWorker.register[^\n]+/, '');
        return res.end(html);
      }
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  }).listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections(); }));
  return 'http://127.0.0.1:' + proxy.address().port;
};
