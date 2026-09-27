'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { BookingStore } = require('./booking-store');
const { validateBookingWindow } = require('./booking-window');
const { recordsEndpoint, matchesRecord } = require('./reservation-records');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const booking = { id: 'b1', seatId: 'seat1', seat: 'A001', area: '五楼A区', date: '2026-09-28', startTime: '09:00', endTime: '11:00' };
const record = { id: 'official1', seat_id: 'seat1', status: '1', status_name: '已预约', beginTime: '2026-09-28 09:00:00', endTime: '2026-09-28 11:00:00' };

test('stored pending, success, and notification claims survive restart', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'libseat-store-')), 'bookings.json');
  let store = new BookingStore(file);
  store.setPending(booking);
  store = new BookingStore(file);
  assert.deepEqual(store.data.pending, booking);
  store.finish(booking, 'success');
  assert.equal(store.claim(booking.id, 'desktop'), true);
  store = new BookingStore(file);
  assert.equal(store.data.pending, null);
  assert.equal(store.data.history[0].seat, 'A001');
  assert.equal(store.claim(booking.id, 'desktop'), false);
  assert.equal(store.claim(booking.id, 'page'), true);
  fs.writeFileSync(file, '{broken');
  store = new BookingStore(file);
  assert.match(store.error, /无法读取/);
  assert.throws(() => store.setPending(booking));
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('window validation covers past times, closing time, maximum duration, alignment, and midnight', () => {
  const cfg = { dateMode: 'today', timeMode: 'custom', axisStart: '08:00', axisEnd: '22:00', axisStep: 15, axisMaxMin: 240 };
  const now = new Date(2026, 8, 27, 10, 1);
  const check = (start, end) => validateBookingWindow(cfg, '2026-09-27', { start, end }, now);
  assert.equal(check('10:15', '14:15'), '');
  assert.match(check('10:00', '11:00'), /已经过去/);
  assert.match(check('22:00', '22:00'), /时长为零/);
  assert.match(check('20:00', '22:15'), /超出开放/);
  assert.match(check('10:15', '14:30'), /不能超过/);
  assert.match(check('10:16', '11:00'), /对齐/);
  assert.match(check('aa', '11:00'), /配置无效/);
  assert.match(validateBookingWindow(cfg, '2026-09-27', { start: '10:15', end: '11:00' }, new Date(2026, 8, 28, 0, 0)), /日期已变化/);
  assert.equal(validateBookingWindow({ ...cfg, dateMode: 'tomorrow' }, '2027-01-01', { start: '08:00', end: '12:00' }, new Date(2026, 11, 31, 23, 30)), '');
});

test('record matching requires exact seat and period, accepts only active/valid status, and parses without executing code', () => {
  assert.equal(matchesRecord(record, booking), true);
  for (const change of [{ seat_id: 'other' }, { status: '4' }, { status: '2', status_name: '已完成' }, { status_name: '' }, { beginTime: '2026-09-27 09:00:00' }, { endTime: '2026-09-28 12:00:00' }]) {
    assert.equal(matchesRecord({ ...record, ...change }, booking), false);
  }
  assert.equal(matchesRecord({ ...record, seat_id: undefined, name: 'A001', nameMerge: '五楼A区' }, booking), true);
  assert.equal(matchesRecord({ ...record, seat_id: undefined, name: 'A001', nameMerge: '二楼A区' }, booking), false);
  assert.equal(recordsEndpoint('function a(e){return t({url:"/v4/test/records",method:"POST",data:e})}export{a as g};throw Error("must never execute")'), '/v4/test/records');
  assert.throws(() => recordsEndpoint('<html>login</html>'));
});

async function fixture(t, scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libseat-recovery-'));
  const config = path.join(root, 'config.json'), control = path.join(root, 'control.json'), calls = path.join(root, 'calls.jsonl');
  const storeFile = path.join(root, 'bookings.json');
  fs.writeFileSync(config, JSON.stringify({ token: 'mock-only', autoRefresh: false, areaIds: ['59'],
    preferAreas: ['59'], seatPrefs: ['XF5A002'], areaNames: { '59': '五楼A区' },
    dateMode: 'tomorrow', timeMode: 'custom', startTime: '09:00', endTime: '11:00', interval: 1, maxAttempts: 1, verifyOnly: false }));
  fs.writeFileSync(control, JSON.stringify(scenario));
  const mock = path.join(root, 'mock.cjs');
  fs.writeFileSync(mock, `
const fs = require('fs');
const original = require(${JSON.stringify(path.join(__dirname, 'mock-api.js'))});
const controlFile = ${JSON.stringify(control)}, configFile = ${JSON.stringify(config)};
const attemptFile = ${JSON.stringify(path.join(root, 'school-attempt.json'))};
exports.recordAsset = 'function a(e){return t({url:"/v4/test/records",method:"POST",data:e})}export{a as g};';
exports.respond = async (url, body) => {
  const c = JSON.parse(fs.readFileSync(controlFile));
  if(url === '/v4/test/records') {
    if(c.unavailable) throw Error('record service offline');
    let record = fs.existsSync(attemptFile) ? JSON.parse(fs.readFileSync(attemptFile)) : null;
    if(c.mismatch && record) record.endTime = record.endTime.replace('11:00', '12:00');
    return {code:0,data:{data:c.hasRecord && record ? [record] : [],total:1}};
  }
  const response = original.respond(url, body);
  if(url === '/v4/Space/seat' && c.changeConfig) {
    const cfg = JSON.parse(fs.readFileSync(configFile));
    cfg.endTime = '15:00'; fs.writeFileSync(configFile, JSON.stringify(cfg));
  }
  if(url === '/v4/space/confirm') {
    fs.writeFileSync(attemptFile, JSON.stringify({seat_id:body.seat_id,status:'1',status_name:'已预约',beginTime:body.day+' '+body.start_time+':00',endTime:body.day+' '+body.end_time+':00'}));
    if(c.timeout) { const e=Error('network timeout');e.code='ETIMEDOUT';throw e; }
    if(c.malformed) return {message:'invalid response'};
  }
  return response;
};`);
  let child, base;
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exit = once(child, 'exit'); child.kill(); await exit; child = null;
  }
  t.after(stop);
  async function start() {
    const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    const port = probe.address().port; await new Promise(r => probe.close(r));
    base = 'http://127.0.0.1:' + port;
    child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { windowsHide: true, stdio: 'ignore',
      env: { ...process.env, PORT: String(port), LIBSEAT_CONFIG_FILE: config, LIBSEAT_BOOKINGS_FILE: storeFile,
        LIBSEAT_LOG_FILE: path.join(root, 'server.log'), LIBSEAT_MOCK: mock, LIBSEAT_MOCK_PASS: '0', LIBSEAT_MOCK_LOG: calls } });
    await wait(async () => { try { return await request('/api/status'); } catch(e) { return false; } });
  }
  async function request(url, body) {
    return (await fetch(base + url, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000) })).json();
  }
  async function wait(fn) {
    for (let i = 0; i < 160; i++) { const result = await fn(); if(result) return result; await sleep(40); }
    throw Error('Timed out: ' + root);
  }
  const settled = () => wait(async () => { const s = await request('/api/status'); return !s.running && !s.checkingBooking && s; });
  const submitCount = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(c => c.path === 'CONFIRM').length : 0;
  await start();
  return { request, settled, stop, start, submitCount, setScenario: c => fs.writeFileSync(control, JSON.stringify(c)), storeFile };
}

test('timeout after successful submission recovers from records, once only; success and claims survive server restart', async t => {
  const f = await fixture(t, { timeout: true, hasRecord: true });
  assert.equal((await f.request('/api/start', {})).ok, true);
  const s = await f.settled();
  assert.equal(s.success, true); assert.equal(s.pendingBooking, null); assert.equal(s.booking.confirmedBy, 'records');
  assert.equal(f.submitCount(), 1);
  assert.equal((await f.request('/api/notification-claim', { id: s.booking.id, channel: 'page' })).claimed, true);
  await f.stop(); await f.start();
  const recovered = await f.settled();
  assert.equal(recovered.booking.id, s.booking.id);
  assert.equal((await f.request('/api/bookings')).history.length, 1);
  assert.equal((await f.request('/api/notification-claim', { id: s.booking.id, channel: 'page' })).claimed, false);
  assert.equal(f.submitCount(), 1);
});

test('unmatched result stays pending across restart, blocks new tasks, then later records recover it', async t => {
  const f = await fixture(t, { timeout: true, hasRecord: true, mismatch: true });
  await f.request('/api/start', {});
  let s = await f.settled();
  assert.equal(s.success, false); assert.ok(s.pendingBooking);
  assert.equal((await f.request('/api/start', {})).ok, false);
  const pendingId = s.pendingBooking.id;
  await f.stop(); await f.start();
  s = await f.settled();
  assert.equal(s.pendingBooking.id, pendingId); assert.equal(f.submitCount(), 1);
  f.setScenario({ hasRecord: true });
  await f.request('/api/booking-check', {});
  s = await f.settled();
  assert.equal(s.success, true); assert.equal(s.booking.id, pendingId); assert.equal(f.submitCount(), 1);
});

test('malformed response and unavailable verification remain pending; explicit manual resolution permits a later task', async t => {
  const f = await fixture(t, { malformed: true, unavailable: true });
  await f.request('/api/start', {});
  const s = await f.settled();
  assert.equal(s.success, false); assert.ok(s.pendingBooking); assert.match(s.bookingMessage, /未完成/);
  assert.equal(f.submitCount(), 1);
  assert.equal((await f.request('/api/booking-resolve', { id: 'wrong', outcome: 'not-booked', confirmed: true })).ok, false);
  assert.equal((await f.request('/api/booking-resolve', { id: s.pendingBooking.id, outcome: 'not-booked', confirmed: true })).ok, true);
  f.setScenario({});
  assert.equal((await f.request('/api/start', {})).ok, true);
  assert.equal((await f.settled()).success, true); assert.equal(f.submitCount(), 2);
});

test('config changing during lookup prevents submission with stale settings', async t => {
  const f = await fixture(t, { changeConfig: true });
  await f.request('/api/start', {});
  const s = await f.settled();
  assert.equal(s.success, false); assert.equal(f.submitCount(), 0);
  assert.equal((await f.request('/api/start', {})).ok, false); // New duration exceeds the limit.
});

test('corrupt records fail closed without overwriting the original file', async t => {
  const f = await fixture(t, {});
  await f.stop(); fs.writeFileSync(f.storeFile, '{broken'); await f.start();
  const s = await f.settled();
  assert.match(s.storageError, /无法读取/);
  assert.equal((await f.request('/api/start', {})).ok, false);
  assert.equal(f.submitCount(), 0); assert.equal(fs.readFileSync(f.storeFile, 'utf8'), '{broken');
});
