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
async function fixture(t, scenario = 'normal') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libseat-actions-'));
  const listener = net.createServer().listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(r => listener.close(r));
  const booking = { id: 'local-booking', seat: 'XF5A048', seatId: '9213', area: '潇湘校区馆-五楼-A区',
    date: '2026-10-10', startTime: '16:17', endTime: '22:00', outcome: 'success' };
  const row = { id: 'official-record', space: '9213', name: booking.seat, nameMerge: booking.area,
    beginTime: '2026-10-10 16:17:38', endTime: '2026-10-10 22:00:00', status: '9', status_name: '预约成功', oksign: 1 };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ token: 'mock', autoRefresh: false, verifyOnly: false }));
  fs.writeFileSync(path.join(dir, 'bookings.json'), JSON.stringify({ version: 1, pending: null, history: [booking], claims: ['page:local-booking'] }));
  fs.writeFileSync(path.join(dir, 'management-row.json'), JSON.stringify(row));
  const env = { ...process.env, PORT: String(port), LIBSEAT_TEST_DIR: dir, LIBSEAT_CONFIG_FILE: path.join(dir, 'config.json'),
    LIBSEAT_LOG_FILE: path.join(dir, 'test.log'), LIBSEAT_BOOKINGS_FILE: path.join(dir, 'bookings.json'),
    LIBSEAT_RENEWAL_FILE: path.join(dir, 'renewal.json'), LIBSEAT_TEST_NOW: '2026-10-10T17:00:00+08:00',
    LIBSEAT_MANAGEMENT_SCENARIO: scenario, LIBSEAT_MOCK: path.join(__dirname, 'mock-management-api.cjs') };
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'fixed-clock.cjs'), path.join(__dirname, '../server.js')],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); let output = ''; child.stderr.on('data', d => output += d);
  t.after(async () => { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } fs.rmSync(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + port;
  const request = async (route, body) => (await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) })).json();
  for (let i = 0; i < 100; i++) { try { await request('/api/status'); break; } catch { await sleep(40); } }
  const r = await request('/api/booking-state', {}); assert.equal(r.ok, true, output);
  const sign = () => fs.writeFileSync(path.join(dir, 'management-row.json'), JSON.stringify({ ...row, status: '3', status_name: '已签到', oksign: 0 }));
  const calls = () => fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return { env, dir, base, request, calls, sign };
}
test('HTTP actions: cancels record ID, persists terminal state and prevents repeated cancellation', async t => {
  const f = await fixture(t);
  const result = await f.request('/api/booking-action', { id: 'local-booking', action: 'cancel' }); assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.bookingManagement.state, 'cancelled'); assert.equal(result.bookingManagement.busy, false);
  const status = await f.request('/api/status'); assert.equal(status.success, false); assert.equal(status.booking.outcome, 'cancelled');
  assert.equal((await f.request('/api/booking-action', { id: 'local-booking', action: 'cancel' })).ok, false);
  assert.deepEqual(f.calls().filter(c => c.route === '/v4/space/cancel').map(c => c.body), [{ id: 'official-record' }]);
});
test('HTTP: refresh detects check-in, temporary leave keeps seat, full checkout releases it', async t => {
  const f = await fixture(t); f.sign();
  assert.equal((await f.request('/api/booking-state', {})).bookingManagement.state, 'signed');
  for (const action of ['leave', 'checkout']) {
    const r = await f.request('/api/booking-action', { id: 'local-booking', action }); assert.equal(r.ok, true, JSON.stringify(r));
  }
  assert.equal((await f.request('/api/status')).success, false);
  assert.equal((await f.request('/api/bookings')).history[0].outcome, 'completed');
  assert.deepEqual(f.calls().filter(c => /\/(leave|checkout)$/.test(c.route)).map(c => c.body), [{ id: 'official-record', points: {} }, { id: 'official-record', points: {} }]);
});
test('HTTP: unknown mutation blocks grabbing and retry; rejection preserves active booking', async t => {
  const f = await fixture(t, 'timeout');
  assert.equal((await f.request('/api/booking-action', { id: 'local-booking', action: 'cancel' })).ok, false);
  assert.match((await f.request('/api/start', {})).message, /结果待核实/);
  assert.equal((await f.request('/api/booking-action', { id: 'local-booking', action: 'cancel' })).ok, false);
  assert.equal(f.calls().filter(c => c.route === '/v4/space/cancel').length, 1);
  const g = await fixture(t, 'rejected'); g.sign();
  const response = await g.request('/api/booking-action', { id: 'local-booking', action: 'checkout' });
  assert.equal(response.ok, false); assert.match(response.message, /不在允许签离范围/);
  assert.equal((await g.request('/api/status')).success, true);
});
for (const scenario of ['cancel', 'signed']) test('real browser buttons and labels: ' + scenario, { timeout: 25000 }, async t => {
  const f = await fixture(t); const electron = path.join(__dirname, '../desktop/node_modules/electron/dist/electron.exe');
  if (!fs.existsSync(electron)) { t.skip('Electron not installed'); return; }
  const env = { ...f.env, LIBSEAT_TEST_URL: f.base, LIBSEAT_UI_SCENARIO: scenario }; delete env.ELECTRON_RUN_AS_NODE;
  const ui = spawn(electron, [path.join(__dirname, 'booking-management-ui.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; ui.stdout.on('data', d => output += d); ui.stderr.on('data', d => output += d);
  const timer = setTimeout(() => ui.kill(), 20000); const [code] = await once(ui, 'exit'); clearTimeout(timer);
  assert.equal(code, 0, output);
  assert.deepEqual(f.calls().filter(c => /\/(cancel|leave|checkout)$/.test(c.route)).map(c => c.route), scenario === 'cancel'
    ? ['/v4/space/cancel'] : ['/v4/space/leave', '/v4/space/checkout']);
});
