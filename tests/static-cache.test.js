'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const origin = 'http://127.0.0.1:8848';

function worker() {
  const handlers = {}, stored = new Map(), network = [], writes = [], added = [], deleted = [];
  const key = value => new URL(typeof value === 'string' ? value : value.url, origin).href;
  let fetchResult = async () => new Response('current');
  const cache = {
    match: async request => stored.get(key(request)),
    put: async (request, response) => { writes.push(key(request)); stored.set(key(request), response); },
    addAll: async requests => added.push(...requests)
  };
  const context = {
    URL, Response,
    Request: class extends Request { constructor(url, init) { super(new URL(url, origin), init); } },
    self: { location: { origin }, addEventListener: (name, handler) => handlers[name] = handler,
      skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches: { open: async () => cache,
      keys: async () => ['unrelated-app-cache', 'libseat-shell-old', 'libseat-shell-v0.2.0'],
      delete: async name => deleted.push(name) },
    fetch: async (request, options) => { network.push({ request, options }); return fetchResult(); }
  };
  vm.runInNewContext(source, context);
  async function event(name, request) {
    let response; const pending = [];
    handlers[name]({ request, respondWith: value => response = value, waitUntil: value => pending.push(value) });
    const result = await response; await Promise.all(pending); return result;
  }
  return { event, stored, network, writes, added, deleted,
    setFetch: value => fetchResult = value,
    request: (url, extras = {}) => ({ url: new URL(url, origin).href, method: 'GET', mode: 'cors', ...extras }) };
}

test('worker precaches every referenced script/style at the same version and bypasses old HTTP caches', async () => {
  const w = worker(); await w.event('install');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const assets = [...html.matchAll(/(?:src|href)="(\/[^"<>]+\.(?:js|css)(?:\?[^"<>]*)?)"/g)].map(m => m[1]);
  assert.ok(assets.length > 10);
  for (const asset of assets) {
    assert.ok(new URL(asset, origin).searchParams.get('v'), asset + ' must bypass pre-upgrade cache');
    assert.ok(w.added.some(r => r.url === origin + asset), asset + ' must be available offline');
  }
  assert.ok(w.added.every(r => r.cache === 'reload'));
  await w.event('activate'); assert.deepEqual(w.deleted, ['libseat-shell-old']);
});

test('worker revalidates fresh HTTP entries, caches successes and excludes APIs/other origins', async () => {
  const w = worker();
  assert.equal(await (await w.event('fetch', w.request('/seat-map.js?v=v0.2.0'))).text(), 'current');
  assert.equal(w.network[0].options.cache, 'no-cache'); assert.equal(w.writes.length, 1);
  await w.event('fetch', w.request('/api/status'));
  await w.event('fetch', w.request('/api/seats', { method: 'POST' }));
  await w.event('fetch', w.request('https://example.com/asset.js'));
  assert.equal(w.network.length, 1);
});

test('failed resource responses never overwrite a working cached script', async () => {
  const w = worker(), url = origin + '/seat-map.js?v=v0.2.0';
  w.stored.set(url, new Response('working script'));
  w.setFetch(async () => new Response('error', { status: 500 }));
  assert.equal((await w.event('fetch', w.request(url))).status, 500);
  assert.equal(w.writes.length, 0); assert.equal(await w.stored.get(url).text(), 'working script');
});

test('offline fallback preserves cached assets and serves HTML only for navigation', async () => {
  const w = worker(), asset = '/seat-map.js?v=v0.2.0';
  w.setFetch(async () => { throw Error('offline'); });
  w.stored.set(origin + asset, new Response('cached script'));
  w.stored.set(origin + '/index.html', new Response('<html>offline shell</html>'));
  assert.equal(await (await w.event('fetch', w.request(asset))).text(), 'cached script');
  assert.equal(await (await w.event('fetch', w.request('/', { mode: 'navigate' }))).text(), '<html>offline shell</html>');
  assert.equal((await w.event('fetch', w.request('/missing.js'))).type, 'error');
  assert.equal((await w.event('fetch', w.request('/missing.css'))).type, 'error');
});
