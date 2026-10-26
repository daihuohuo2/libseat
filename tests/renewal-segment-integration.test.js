'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fixture(t, unavailable = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libseat-segment-'));
  const listener = net.createServer().listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(r => listener.close(r));
  const booking = { id: 'old-segment', seatId: '149', seat: 'XF5A149', area: '测试馆-五楼A区', areaId: '59', date: '2026-10-10',
    startTime: '16:00', endTime: '22:00', reserveType: '1', segment: 'whole-day', bookedAt: '2026-10-10T08:00:00.000Z', outcome: 'success', officialId: 'official-1' };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ token: 'mock', autoRefresh: false, verifyOnly: false, areaIds: ['59'], preferAreas: ['59'] }));
  fs.writeFileSync(path.join(dir, 'bookings.json'), JSON.stringify({ version: 1, pending: null, history: [booking], claims: ['page:old-segment'] }));
  fs.writeFileSync(path.join(dir, 'rows.json'), JSON.stringify([{ id: 'official-1', seat_id: '149', name: 'XF5A149', status: '9', status_name: '预约成功', oksign: 1,
    beginTime: '2026-10-10 16:00:00', endTime: '2026-10-10 22:00:00' }]));
  const env = { ...process.env, PORT: String(port), LIBSEAT_TEST_DIR: dir, LIBSEAT_TEST_NOW: '2026-10-10T16:50:00+08:00',
    LIBSEAT_CONFIG_FILE: path.join(dir, 'config.json'), LIBSEAT_LOG_FILE: path.join(dir, 'test.log'),
    LIBSEAT_BOOKINGS_FILE: path.join(dir, 'bookings.json'), LIBSEAT_RENEWAL_FILE: path.join(dir, 'renewal.json'),
    LIBSEAT_MOCK: path.join(__dirname, 'mock-renewal-api.cjs'), LIBSEAT_RENEWAL_TYPE: '1', LIBSEAT_SEGMENT_UNAVAILABLE: unavailable ? '1' : '' };
  const backend = spawn(process.execPath, ['--require', path.join(__dirname, 'fixed-clock.cjs'), path.join(__dirname, '../server.js')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  backend.stdout.resume(); let output = ''; backend.stderr.on('data', d => output += d);
  t.after(async () => { if (backend.exitCode === null) { const exited = once(backend, 'exit'); backend.kill(); await exited; } fs.rmSync(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + port;
  const request = async (route, body) => (await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
  for (let i = 0; i < 100; i++) { try { await request('/api/status'); break; } catch { await sleep(40); } }
  await request('/api/booking-state', {});
  return { request, env, base, dir, output, calls: () => fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) };
}
test('segment HTTP renewal: preflight, cancel, correct encrypted-order payload, new identity and map date', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const start = await f.request('/api/renewal/start', { mode: 'current', arrivalAt: '2026-10-10T19:00:00+08:00' });
  assert.equal(start.ok, true, JSON.stringify(start) + f.output);
  let s;
  for (let i = 0; i < 100; i++) { s = await f.request('/api/status'); if (s.renewal.cycles === 1) break; await sleep(70); }
  assert.equal(s.renewal.cycles, 1, JSON.stringify(s.renewal)); assert.equal(s.success, true);
  assert.equal(s.booking.startTime, '16:50'); assert.equal(s.booking.endTime, '22:00'); assert.equal(s.booking.reserveType, '1');
  assert.equal(s.booking.officialId, undefined); assert.equal(s.renewal.active, true);
  const calls = f.calls(), cancel = calls.findIndex(c => c.route === '/v4/space/cancel');
  assert.ok(calls.slice(0, cancel).some(c => c.route === '/v4/Space/map'));
  assert.deepEqual(calls.filter(c => c.route === '/v4/space/confirm').map(c => c.body), [
    { seat_id: '149', day: '2026-10-10', segment: 'whole-day', start_time: '', end_time: '' }
  ]);
  const b = s.booking;
  await f.request('/api/booking-state', {}); s = await f.request('/api/status'); assert.equal(s.success, true);
  assert.equal(s.booking.officialId, 'renewed-1');
  await f.request('/api/config', { dateMode: 'tomorrow' });
  const map = await f.request('/api/seats', { areaId: '59', bookingId: b.id }); assert.equal(map.date, b.date);
  assert.equal((await f.request('/api/config')).config.dateMode, 'tomorrow');
});
test('segment unavailable blocks activation without releasing the existing seat', async t => {
  const f = await fixture(t, true);
  const r = await f.request('/api/renewal/start', { mode: 'current', arrivalAt: '2026-10-10T19:00:00+08:00' });
  assert.equal(r.ok, false); assert.match(r.message, /时段不可用/);
  assert.equal((await f.request('/api/status')).success, true);
  assert.equal(f.calls().filter(c => /\/(cancel|confirm)$/.test(c.route)).length, 0);
});
test('static code revalidates and versioned asset URLs serve the current map library', async t => {
  const f = await fixture(t);
  for (const url of ['/', '/sw.js', '/seat-map.js?v=v0.3.1', '/seat-map.css', '/manifest.webmanifest']) {
    const r = await fetch(f.base + url);
    assert.equal(r.status, 200, url); assert.equal(r.headers.get('cache-control'), 'no-cache', url);
    if (url.startsWith('/seat-map.js')) assert.match(await r.text(), /isMine/);
    else await r.arrayBuffer();
  }
});

test('cached upgrade restores map and red own seat; compact desktop and mobile UI stay usable', { timeout: 35000 }, async t => {
  const f = await fixture(t); const electron = path.join(__dirname, '../desktop/node_modules/electron/dist/electron.exe');
  if (!fs.existsSync(electron)) { t.skip('Electron not installed'); return; }
  const base = await require('./cache-upgrade-proxy.cjs')(f.base, t);
  const env = { ...f.env, LIBSEAT_TEST_URL: base, LIBSEAT_TEST_CACHE_UPGRADE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const ui = spawn(electron, [path.join(__dirname, 'compact-ui.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; ui.stdout.on('data', d => output += d); ui.stderr.on('data', d => output += d);
  const timer = setTimeout(() => ui.kill(), 30000); const [code] = await once(ui, 'exit'); clearTimeout(timer); assert.equal(code, 0, output);
});
