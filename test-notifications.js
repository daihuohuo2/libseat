/** Isolated regression tests: node --test test-notifications.js */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const vm = require('node:vm');
const { createTracker, message } = require('./public/booking-notifications');
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('desktop close hides to tray; tray displays status and exit stops the backend', async () => {
  let window, tray, hidden = 0, prevented = 0, quitCalls = 0;
  const requests = [];
  class Window {
    constructor(){ window = this; this.events = {}; this.webContents = { setWindowOpenHandler(){} }; }
    on(name, callback){ this.events[name] = callback; }
    setMenuBarVisibility(){} loadURL(){} hide(){ hidden++; }
  }
  class Tray {
    constructor(){ tray = this; } setToolTip(value){ this.tip = value; }
    setContextMenu(value){ this.menu = value; } on(){}
  }
  const electron = { BrowserWindow: Window, Tray, Menu: { buildFromTemplate: value => value },
    nativeImage: { createFromPath(){ return { resize(){ return {}; } }; } },
    app: { commandLine: { appendSwitch(){} }, setAppUserModelId(){}, requestSingleInstanceLock(){ return false; }, quit(){ quitCalls++; } } };
  const context = vm.createContext({
    require: name => name === 'electron' ? electron : name === '../public/booking-notifications.js' ? require('./public/booking-notifications') : require(name),
    __dirname: path.join(__dirname, 'desktop'), process: { env: {} }, console, setTimeout, setInterval, clearInterval, AbortSignal,
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ running: false }) }; }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'desktop/main.js'), 'utf8'), context);
  vm.runInContext('createTray(); createWindow(); updateTray({running:true})', context);
  window.events.close({ preventDefault(){ prevented++; } });
  assert.equal(hidden, 1); assert.equal(prevented, 1);
  assert.match(tray.tip, /正在抢座/);
  vm.runInContext('updateTray({pendingBooking:{id:"pending"}})', context);
  assert.match(tray.tip, /结果待确认/);
  const quitBefore = quitCalls;
  await tray.menu.at(-1).click();
  assert.equal(quitCalls, quitBefore + 1);
  assert.ok(requests.some(r => r.url.endsWith('/api/stop') && r.options.method === 'POST'));
  window.events.close({ preventDefault(){ prevented++; } });
  assert.equal(prevented, 1);
});

test('desktop main process notifies once and restores the minimized window on click', async () => {
  const notifications = [];
  let restored = 0, focused = 0, dialogs = 0;
  class Notification {
    static isSupported(){ return true; }
    constructor(options){ this.options = options; this.events = {}; notifications.push(this); }
    on(name, callback){ this.events[name] = callback; }
    show(){ this.shown = true; }
  }
  const electron = { Notification, app: { commandLine: { appendSwitch(){} }, setAppUserModelId(){}, requestSingleInstanceLock(){ return false; }, quit(){} },
    dialog: { async showMessageBox(){ dialogs++; } } };
  const booking = { id: 'native', seat: 'XF5A002', area: '五楼A区', date: '2026-09-28', startTime: '09:00', endTime: '11:00' };
  const context = vm.createContext({
    require: name => name === 'electron' ? electron : name === '../public/booking-notifications.js' ? require('./public/booking-notifications') : require(name),
    __dirname: path.join(__dirname, 'desktop'), process: { env: {} }, console, setTimeout, setInterval, clearInterval, AbortSignal,
    fetch: async url => ({ ok: true, json: async () => url.endsWith('notification-claim') ? { ok: true, claimed: true } : { success: true, booking } }),
    testWindow: { isMinimized(){ return true; }, restore(){ restored++; }, show(){}, focus(){ focused++; }, flashFrame(){} }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'desktop/main.js'), 'utf8'), context);
  vm.runInContext('win = testWindow', context);
  await vm.runInContext('pollBooking()', context);
  await vm.runInContext('pollBooking()', context);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].shown, true);
  assert.match(notifications[0].options.body, /XF5A002/);
  notifications[0].events.click();
  assert.equal(restored, 1); assert.equal(focused, 1);
  notifications[0].events.failed();
  assert.equal(dialogs, 1);
});

test('success notifications: exact details, deduplication, reload, and unavailable storage', () => {
  const booking = { id: 'one', seat: 'XF5A002', area: '五楼A区', date: '2026-09-28', startTime: '08:00', endTime: '12:00' };
  const values = new Map();
  const storage = { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v) };
  const shown = [];
  const track = createTracker(b => shown.push(b), storage);
  assert.equal(track({ success: false, booking }), false);
  assert.equal(track({ success: true }), false);
  assert.equal(track({ success: true, booking }), true);
  assert.equal(track({ success: true, booking }), false);
  assert.equal(createTracker(b => shown.push(b), storage)({ success: true, booking }), false);
  assert.equal(shown.length, 1);
  assert.match(message(booking), /XF5A002\n区域：五楼A区\n时间：2026-09-28 08:00–12:00/);
  assert.equal(track({ success: true, booking: { ...booking, id: 'two' } }), true);
  const brokenStorage = { getItem(){ throw Error('blocked'); }, setItem(){ throw Error('blocked'); } };
  const withoutStorage = createTracker(() => {}, brokenStorage);
  assert.equal(withoutStorage({ success: true, booking }), true);
  assert.equal(withoutStorage({ success: true, booking }), false);
});

test('engine and real UI use isolated mock reservations', { timeout: 60000 }, async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'libseat-notifications-'));
  // Keep fixtures for diagnostics; never read or replace the user's config/cookies.
  const configFile = path.join(tmp, 'config.json');
  const controlFile = path.join(tmp, 'scenario.json');
  const requestLog = path.join(tmp, 'requests.jsonl');
  const marker = path.join(tmp, 'query-started');
  fs.writeFileSync(configFile, JSON.stringify({ token: 'mock-only', autoRefresh: false,
    areaIds: ['59'], areaNames: { '59': '五楼A区' }, preferAreas: ['59'],
    seatPrefs: ['XF5A002'], seatPrefMode: 'only', maxAttempts: 1,
    dateMode: 'tomorrow', timeMode: 'custom', startTime: '08:00', endTime: '12:00', verifyOnly: true }));
  fs.writeFileSync(controlFile, '{}');
  const fixture = path.join(tmp, 'mock.cjs');
  fs.writeFileSync(fixture, `
const fs = require('fs');
const original = require(${JSON.stringify(path.join(__dirname, 'mock-api.js'))});
exports.respond = async (url, body) => {
  const control = JSON.parse(fs.readFileSync(${JSON.stringify(controlFile)}, 'utf8'));
  if(url === '/v4/Space/seat' && control.delay) {
    fs.writeFileSync(${JSON.stringify(marker)}, 'ready');
    await new Promise(r => setTimeout(r, 350));
  }
  const response = original.respond(url, body);
  if(url === '/v4/space/index') {
    if(control.treeDelay) await new Promise(r => setTimeout(r, control.treeDelay));
    if(control.treeFail) throw Error('fetch failed');
    if(control.treeHealthy) return { code:0, data:{ premises:[{id:'1',name:'测试馆'}], storey:[{name:'五楼',list:[{id:'5',parentId:'1'}]}] } };
  }
  if(url === '/v4/space/confirm' && control.fail) return { code: 1, message: '模拟座位已被占用' };
  if(url === '/v4/space/confirm' && control.uncertain) throw Error('simulated timeout');
  return response;
};`);
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, PORT: String(port), LIBSEAT_CONFIG_FILE: configFile,
      LIBSEAT_LOG_FILE: path.join(tmp, 'server.log'), LIBSEAT_MOCK: fixture,
      LIBSEAT_MOCK_LOG: requestLog, LIBSEAT_MOCK_PASS: '0' }
  });
  t.after(async () => { const exited = once(child, 'exit'); child.kill(); await exited; });
  const request = async (url, body) => (await fetch(base + url, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000)
  })).json();
  async function waitFor(fn) {
    for(let n = 0; n < 150; n++) { const result = await fn(); if(result) return result; await sleep(50); }
    throw Error('Timed out waiting for test state');
  }
  await waitFor(async () => { try { return await request('/api/status'); } catch(e) { return false; } });
  const finished = () => waitFor(async () => { const s = await request('/api/status'); return !s.running && s; });
  const confirms = () => fs.readFileSync(requestLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(x => x.path === 'CONFIRM');
  let booking;
  await t.test('start uses submitted settings and returns the exact successful reservation', async () => {
    assert.equal((await request('/api/start', { verifyOnly: false, interval: 2, startTime: '09:00', endTime: '11:00' })).ok, true);
    const s = await finished();
    assert.equal(s.success, true);
    booking = s.booking;
    assert.equal(booking.seat, 'XF5A002');
    assert.equal(booking.area, '测试楼-五楼A区');
    assert.equal(booking.startTime, '09:00');
    assert.equal(booking.endTime, '11:00');
    assert.equal(confirms().at(-1).raw.start_time, booking.startTime);
    assert.equal(confirms().at(-1).raw.day, booking.date);
    assert.equal((await request('/api/status')).booking.id, booking.id);
    assert.equal(JSON.parse(fs.readFileSync(configFile)).interval, 2);
  });
  await t.test('a new reservation of the same seat has a new notification ID', async () => {
    await request('/api/start', {});
    assert.notEqual((await finished()).booking.id, booking.id);
  });
  await t.test('observation mode has no successful result and sends no booking', async () => {
    const count = confirms().length;
    await request('/api/start', { verifyOnly: true });
    const s = await finished();
    assert.equal(s.success, false); assert.equal(s.booking, null);
    assert.equal(confirms().length, count);
  });
  await t.test('failed reservation never produces a success notification', async () => {
    fs.writeFileSync(controlFile, JSON.stringify({ fail: true }));
    await request('/api/start', { verifyOnly: false });
    const s = await finished();
    assert.equal(s.success, false); assert.equal(s.booking, null);
  });
  await t.test('stopping during seat lookup prevents submission', async () => {
    fs.writeFileSync(controlFile, JSON.stringify({ delay: true }));
    const count = confirms().length;
    await request('/api/start', {});
    await waitFor(() => fs.existsSync(marker));
    await request('/api/stop', {});
    const s = await finished();
    assert.equal(s.success, false); assert.equal(confirms().length, count);
  });
  await t.test('invalid time window is rejected before launch', async () => {
    const result = await request('/api/start', { startTime: '12:00', endTime: '09:00' });
    assert.equal(result.ok, false);
    assert.equal((await request('/api/status')).running, false);
  });
  fs.writeFileSync(controlFile, '{}');
  const electron = path.join(__dirname, 'desktop/node_modules/electron/dist/electron.exe');
  await t.test('rendered browser UI: success dialog, notification, reload, denied permission', { skip: !fs.existsSync(electron) }, async () => {
    const env = { ...process.env, LIBSEAT_TEST_URL: base, LIBSEAT_TEST_DIR: tmp };
    delete env.ELECTRON_RUN_AS_NODE;
    const ui = spawn(electron, [path.join(__dirname, 'test-notifications-electron.js')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    ui.stdout.on('data', data => { output += data; });
    ui.stderr.on('data', data => { output += data; });
    const timeout = setTimeout(() => ui.kill(), 25000);
    const [code] = await once(ui, 'exit');
    clearTimeout(timeout);
    assert.equal(code, 0, output);
    console.log(output.split('\n').filter(line => line.startsWith('UI ')).join('\n'));
  });
});
