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
test('isolated HTTP and UI: current booking -> cancel -> same seat -> stop; next-booking plan gates observation', { timeout: 35000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libseat-renewal-ui-'));
  const portServer = net.createServer().listen(0, '127.0.0.1'); await once(portServer, 'listening');
  const port = portServer.address().port; await new Promise(r => portServer.close(r));
  const booking = { id: 'existing', seat: 'XF5A149', seatId: '149', area: '五楼A区', date: '2026-10-10', startTime: '08:00', endTime: '12:00', bookedAt: '2026-10-10T00:00:00.000Z', outcome: 'success' };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ token: 'mock-token', autoRefresh: false, verifyOnly: false }));
  fs.writeFileSync(path.join(dir, 'bookings.json'), JSON.stringify({ version: 1, pending: null, history: [booking], claims: ['page:existing', 'desktop:existing'] }));
  fs.writeFileSync(path.join(dir, 'rows.json'), JSON.stringify([{ id: 'official-1', seat_id: '149', name: 'XF5A149', status: '2', status_name: '待签到', oksign: 1, beginTime: '2026-10-10 08:00:00', endTime: '2026-10-10 12:00:00' }]));
  const env = { ...process.env, PORT: String(port), LIBSEAT_CONFIG_FILE: path.join(dir, 'config.json'), LIBSEAT_LOG_FILE: path.join(dir, 'test.log'),
    LIBSEAT_TEST_DIR: dir, LIBSEAT_TEST_NOW: '2026-10-10T08:50:00+08:00', LIBSEAT_MOCK: path.join(__dirname, 'mock-renewal-api.cjs') };
  const backend = spawn(process.execPath, ['--require', path.join(__dirname, 'fixed-clock.cjs'), path.join(__dirname, '../server.js')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; backend.stderr.on('data', data => output += data); backend.stdout.resume();
  t.after(async () => { backend.kill(); await once(backend, 'exit').catch(() => {}); });
  const base = 'http://127.0.0.1:' + port;
  const request = async (route, body) => (await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
  for (let n = 0; n < 100; n++) { try { await request('/api/status'); break; } catch (_) { await sleep(50); } }
  let r = await request('/api/renewal/start', { mode: 'current', arrivalAt: '2026-10-10T14:00:00+08:00' });
  assert.equal(r.ok, true, JSON.stringify(r) + output);
  assert.equal((await request('/api/start', { verifyOnly: false })).ok, false);
  let status;
  for (let i = 0; i < 80; i++) { status = await request('/api/status'); if (status.renewal.cycles === 1) break; await sleep(100); }
  assert.equal(status.renewal.cycles, 1, JSON.stringify(status));
  assert.equal(status.booking.seat, 'XF5A149'); assert.equal(status.booking.startTime, '09:00');
  assert.equal(status.pendingBooking, null); assert.equal(status.success, true);
  const calls = fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.filter(c => c.route === '/v4/space/cancel').map(c => c.body), [{ id: 'official-1' }]);
  assert.equal(calls.filter(c => c.route === '/v4/space/confirm').length, 1);
  assert.equal((await request('/api/bookings')).history.find(b => b.id === 'existing').outcome, 'cancelled');
  await request('/api/stop', {}); status = await request('/api/status');
  assert.equal(status.renewal.active, false); assert.equal(status.success, true);
  await request('/api/renewal/start', { mode: 'next', arrivalAt: '2026-10-10T14:00:00+08:00' });
  assert.match((await request('/api/start', { verifyOnly: true })).message, /关闭观察模式/);
  await request('/api/renewal/stop', {});
  const electron = path.join(__dirname, '../desktop/node_modules/electron/dist/electron.exe');
  if (fs.existsSync(electron)) {
    const uiEnv = { ...env, LIBSEAT_TEST_URL: base }; delete uiEnv.ELECTRON_RUN_AS_NODE;
    const ui = spawn(electron, [path.join(__dirname, 'renewal-ui.cjs')], { env: uiEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let uiOutput = ''; ui.stdout.on('data', d => uiOutput += d); ui.stderr.on('data', d => uiOutput += d);
    const timeout = setTimeout(() => ui.kill(), 20000);
    const [code] = await once(ui, 'exit'); clearTimeout(timeout);
    assert.equal(code, 0, uiOutput); console.log(uiOutput);
  }
  console.log('Isolated artifacts: ' + dir);
});
