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

async function fixture(t, scenario, extra = {}, duringRun) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libseat-grab-'));
  const listener = net.createServer().listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(r => listener.close(r));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ token: 'mock', autoRefresh: false, verifyOnly: false,
    areaIds: ['59', '57'], preferAreas: ['59', '57', '51'], premisesIds: ['1'], storeyIds: ['5'], interval: 1, maxAttempts: 1, ...extra }));
  const env = { ...process.env, TZ: 'Asia/Shanghai', PORT: String(port), LIBSEAT_CONFIG_FILE: path.join(dir, 'config.json'),
    LIBSEAT_BOOKINGS_FILE: path.join(dir, 'bookings.json'), LIBSEAT_RENEWAL_FILE: path.join(dir, 'renewal.json'),
    LIBSEAT_LOG_FILE: path.join(dir, 'test.log'), LIBSEAT_TEST_DIR: dir, LIBSEAT_TEST_NOW: '2026-10-10T16:02:00+08:00',
    LIBSEAT_MOCK: path.join(__dirname, 'mock-grab-api.cjs'), LIBSEAT_GRAB_SCENARIO: scenario };
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'fixed-clock.cjs'), path.join(__dirname, '../server.js')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stderr.on('data', d => output += d); child.stdout.resume();
  t.after(async () => { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } fs.rmSync(dir, { recursive: true, force: true }); });
  const request = async (route, body) => (await fetch('http://127.0.0.1:' + port + route, { method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(3000) })).json();
  for (let i = 0; i < 100; i++) { try { await request('/api/status'); break; } catch { await sleep(30); } }
  const started = await request('/api/start', {}); assert.equal(started.ok, true, JSON.stringify(started) + output);
  if (duringRun) await duringRun(request, dir);
  let status;
  for (let i = 0; i < 100; i++) { status = await request('/api/status'); if (!status.running) break; await sleep(30); }
  assert.equal(status.running, false, output);
  const calls = fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return { status, calls, request, env, base: 'http://127.0.0.1:' + port };
}

test('cross-floor last entry books immediately even when earlier entries are full and areaIds is stale', async t => {
  const { status, calls } = await fixture(t, 'cross-floor', { seatPrefs: ['OLD-HIDDEN-SEAT'], seatPrefMode: 'only' });
  assert.equal(status.success, true); assert.equal(status.booking.areaId, '51');
  assert.equal(status.booking.startTime, '16:02'); assert.equal(status.booking.endTime, '22:00');
  assert.equal(status.pendingBooking, null);
  assert.deepEqual(calls.filter(c => c.route === '/v4/space/confirm').map(c => c.body), [
    { seat_id: 'seat-51', day: '2026-10-10', segment: 'segment-51', start_time: '', end_time: '' }
  ]);
  const seatQuery = calls.find(c => c.route === '/v4/Space/seat');
  assert.equal(seatQuery.body.start_time, '16:02'); assert.equal(seatQuery.body.end_time, '22:00');
  assert.equal(calls.some(c => c.body.id === '55'), false);
});
test('list order does not set priority, and an explicit rejection continues to another selected area', async t => {
  const { status, calls } = await fixture(t, 'fallback');
  assert.equal(status.success, true); assert.equal(status.booking.areaId, '59');
  assert.deepEqual(calls.filter(c => c.route === '/v4/space/confirm').map(c => c.body.seat_id), ['seat-51', 'seat-59']);
});
test('one area rule query fails without blocking another selected area', async t => {
  const { status } = await fixture(t, 'bad-area');
  assert.equal(status.success, true); assert.equal(status.booking.areaId, '59');
});
test('invalid-time rejection stops and exposes the cause instead of looping forever', async t => {
  const { status, calls } = await fixture(t, 'time-error', { maxAttempts: 0 });
  assert.equal(status.success, false); assert.match(status.stopReason, /申请时间错误/);
  assert.match(status.lastFailure, /申请时间错误/);
  assert.equal(calls.filter(c => c.route === '/v4/space/confirm').length, 1);
});
test('uncertain response stays pending and never books a second seat', async t => {
  const { status, calls } = await fixture(t, 'timeout');
  assert.equal(status.success, false); assert.ok(status.pendingBooking);
  assert.equal(calls.filter(c => c.route === '/v4/space/confirm').length, 1);
});
test('observation mode never sends a booking', async t => {
  const { status, calls } = await fixture(t, 'cross-floor', { verifyOnly: true });
  assert.equal(status.success, false);
  assert.equal(calls.filter(c => c.route === '/v4/space/confirm').length, 0);
});

test('actual booking attempts a selected individual seat before the first free seat', async t => {
  const { status } = await fixture(t, 'preferences', { areaSeatPrefs: { '51': { mode: 'prefer', seats: ['AREA51004'] } } });
  assert.equal(status.booking.seat, 'AREA51004');
});
test('occupied preferred seats fall back within the same area', async t => {
  const { status } = await fixture(t, 'preferences-occupied', { areaSeatPrefs: { '51': { mode: 'prefer', seats: ['AREA51001', 'AREA51002'] } } });
  assert.equal(status.booking.seat, 'AREA51005'); assert.equal(status.booking.areaId, '51');
});
test('four preferred seats lost at submission do not consume the same-area fallback budget', async t => {
  const { status, calls } = await fixture(t, 'preferences-race', { areaSeatPrefs: { '51': { mode: 'prefer', seats: ['AREA51001', 'AREA51002', 'AREA51003', 'AREA51004'] } } });
  assert.equal(status.booking.seat, 'AREA51005'); assert.equal(status.booking.areaId, '51');
  assert.equal(calls.filter(c => c.route === '/v4/space/confirm').length, 5);
});
test('preference API persists per area and saved plans replace preferences including old plans', async t => {
  const { request } = await fixture(t, 'cross-floor', { verifyOnly: true });
  const preference = { mode: 'prefer', seats: ['AREA51003', 'AREA51004'] };
  assert.equal((await request('/api/area-seat-preferences', { areaId: '51', preference })).ok, true);
  assert.equal((await request('/api/area-seat-preferences', { areaId: '59', preference: { mode: 'any' } })).ok, true);
  let cfg = (await request('/api/config')).config;
  assert.deepEqual(cfg.areaSeatPrefs['51'], preference);
  assert.equal(cfg.areaSeatPrefs['59'].mode, 'any');
  const bad = await request('/api/area-seat-preferences', { areaId: '51', preference: { mode: 'prefer', seats: [] } });
  assert.equal(bad.ok, false);
  const seatPlans = [{ id: 'preferred', areas: ['51'], areaSeatPrefs: cfg.areaSeatPrefs }, { id: 'legacy', areas: ['59'] }];
  assert.equal((await request('/api/config', { seatPlans })).ok, true);
  const configured = (await request('/api/config')).config.seatPlans;
  assert.deepEqual(configured[0].areaSeatPrefs, { '51': preference });
  await request('/api/plan-activate', { id: 'legacy' });
  assert.deepEqual((await request('/api/config')).config.areaSeatPrefs, {});
  await request('/api/plan-activate', { id: 'preferred' });
  assert.deepEqual((await request('/api/config')).config.areaSeatPrefs, { '51': preference });
});

test('editing preferences while seats load prevents a stale submission; next run uses the new seats', async t => {
  const { status, calls, request } = await fixture(t, 'preferences-change', {}, async (request, dir) => {
    for (let i = 0; i < 100; i++) {
      if (fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').includes('/v4/Space/seat')) break;
      await sleep(10);
    }
    assert.equal((await request('/api/area-seat-preferences', { areaId: '51', preference: { mode: 'prefer', seats: ['AREA51004'] } })).ok, true);
  });
  assert.equal(status.success, false);
  assert.equal(calls.filter(c => c.route === '/v4/space/confirm').length, 0);
  await request('/api/start', {});
  let next;
  for (let i = 0; i < 100; i++) { next = await request('/api/status'); if (!next.running) break; await sleep(20); }
  assert.equal(next.booking.seat, 'AREA51004');
});

test('seat preference UI: click, inclusive range, invalid input, save/reopen, any mode and plans', { timeout: 30000 }, async t => {
  const f = await fixture(t, 'preferences', { verifyOnly: true });
  const electron = path.join(__dirname, '../desktop/node_modules/electron/dist/electron.exe');
  if (!fs.existsSync(electron)) { t.skip('Electron is not installed'); return; }
  const env = { ...f.env, LIBSEAT_TEST_URL: f.base }; delete env.ELECTRON_RUN_AS_NODE;
  const ui = spawn(electron, [path.join(__dirname, 'seat-preferences-ui.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; ui.stdout.on('data', d => output += d); ui.stderr.on('data', d => output += d);
  const timer = setTimeout(() => ui.kill(), 20000);
  const [code] = await once(ui, 'exit'); clearTimeout(timer);
  assert.equal(code, 0, output); console.log(output);
});
