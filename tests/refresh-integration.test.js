'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { bookingEnded } = require('../booking-store');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const booking = { id: 'old-booking', seat: 'XF5A001', seatId: '1', areaId: '59', area: '测试馆-五楼-A区',
  date: '2026-10-10', startTime: '16:17', endTime: '22:00', outcome: 'success' };
const row = { id: 'official-1', space: '1', beginTime: '2026-10-10 16:17:00', status: '9', oksign: 1 };
async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libseat-refresh-'));
  const listener = net.createServer().listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(r => listener.close(r));
  const write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  const clock = time => fs.writeFileSync(path.join(dir, 'now.txt'), time);
  clock(options.now || '2026-10-10T17:00:00+08:00');
  write('config.json', { token: 'old-test-token', autoRefresh: false, areaIds: ['59'], preferAreas: ['59'] });
  write('bookings.json', { version: 1, pending: options.pending ? { ...booking, id: 'uncertain' } : null,
    pendingAction: options.action ? { bookingId: booking.id, action: 'cancel', recordId: row.id } : null,
    history: [{ ...booking, ...options.booking }], claims: ['page:' + booking.id] });
  write('school.json', { free: false, records: [row] });
  const env = { ...process.env, TZ: 'Asia/Shanghai', PORT: String(port), LIBSEAT_TEST_DIR: dir,
    LIBSEAT_CONFIG_FILE: path.join(dir, 'config.json'), LIBSEAT_PROFILE_DIR: path.join(dir, 'profile'),
    LIBSEAT_LOG_FILE: path.join(dir, 'test.log'), LIBSEAT_MOCK: path.join(__dirname, 'mock-refresh-api.cjs') };
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'refresh-clock.cjs'), path.join(__dirname, '../server.js')],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume();
  t.after(async () => { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } fs.rmSync(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + port;
  const request = async (route, body) => (await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) })).json();
  for (let i = 0; i < 100; i++) { try { await request('/api/config'); break; } catch { await sleep(40); } }
  return { dir, base, env, request, clock, write };
}

test('reservation expiry uses Beijing end time, preserves future reservations and handles old missing end times', () => {
  assert.equal(bookingEnded(booking, Date.parse('2026-10-10T13:59:59Z')), false);
  assert.equal(bookingEnded(booking, Date.parse('2026-10-10T14:00:00Z')), true);
  assert.equal(bookingEnded({ ...booking, date: '2026-10-11' }, Date.parse('2026-10-10T23:00:00+08:00')), false);
  assert.equal(bookingEnded({ ...booking, endTime: '' }, Date.parse('2026-10-11T00:00:00+08:00')), true);
  assert.equal(bookingEnded({}), false);
});
test('next-day startup retires the old reservation without losing history or querying yesterday on the map', async t => {
  const f = await fixture(t, { now: '2026-10-11T08:00:00+08:00' });
  const s = await f.request('/api/status');
  assert.equal(s.success, false); assert.equal(s.booking.endedBy, 'time');
  assert.equal(s.bookingManagement.actions.length, 0);
  const history = (await f.request('/api/bookings')).history;
  assert.equal(history.length, 1); assert.equal(history[0].outcome, 'completed');
  assert.equal((await f.request('/api/seats', { areaId: '59', bookingId: booking.id })).date, '2026-10-11');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'bookings.json'))).history[0].outcome, 'completed');
});
test('crossing the end time retires an open session; a record query cannot resurrect the expired booking', async t => {
  const f = await fixture(t);
  await f.request('/api/booking-state', {});
  assert.equal((await f.request('/api/status')).success, true);
  f.clock('2026-10-10T22:00:00+08:00');
  assert.equal((await f.request('/api/status')).success, false);
  await f.request('/api/booking-state', {});
  assert.equal((await f.request('/api/status')).success, false);
});
for (const kind of ['pending', 'action']) test('next-day refresh preserves unresolved ' + kind + ' and prevents duplicate submissions', async t => {
  const f = await fixture(t, { now: '2026-10-11T08:00:00+08:00', [kind]: true });
  const s = await f.request('/api/status');
  assert.ok(kind === 'pending' ? s.pendingBooking : s.bookingManagement.pendingAction);
  assert.equal((await f.request('/api/start', {})).ok, false);
});
test('desktop UI: manual refresh, fast relogin during slow map, next-day return and cleared reservation', { timeout: 35000 }, async t => {
  const f = await fixture(t);
  const electron = path.join(__dirname, '../desktop/node_modules/electron/dist/electron.exe');
  if (!fs.existsSync(electron)) { t.skip('Electron not installed'); return; }
  const env = { ...f.env, LIBSEAT_TEST_URL: f.base }; delete env.ELECTRON_RUN_AS_NODE;
  const ui = spawn(electron, [path.join(__dirname, 'refresh-ui.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; ui.stdout.on('data', d => output += d); ui.stderr.on('data', d => output += d);
  const timer = setTimeout(() => ui.kill(), 28000); const [code] = await once(ui, 'exit'); clearTimeout(timer);
  assert.equal(code, 0, output);
  const calls = fs.readFileSync(path.join(f.dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.some(c => /\/(confirm|cancel|leave|checkout)$/.test(c.route)), false);
});
