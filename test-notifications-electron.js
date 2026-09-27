'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const assert = require('node:assert/strict');
app.setPath('userData', path.join(process.env.LIBSEAT_TEST_DIR, 'electron-profile'));
app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  const js = expression => win.webContents.executeJavaScript(expression, true);
  async function waitFor(expression) {
    for(let n = 0; n < 80; n++) { if(await js(expression)) return; await sleep(100); }
    throw Error('UI condition timed out: ' + expression);
  }
  try {
    await win.loadURL(process.env.LIBSEAT_TEST_URL);
    // Exercise the animation regardless of the host's Windows accessibility setting.
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }]
    });
    await waitFor("document.getElementById('dateMode').value === 'tomorrow'");
    await js(`window.testNotifications = []; window.Notification = class {
      static permission = 'granted';
      constructor(title, options){ window.testNotifications.push({title, options}); }
    }; document.getElementById('verifyOnly').checked = false; start();`);
    await waitFor("document.getElementById('bookingDialog').open");
    const details = await js("document.getElementById('bookingDialogDetails').textContent");
    assert.match(details, /XF5A001/); // UI clears old seat-number preferences intentionally.
    assert.match(details, /测试楼-五楼A区/);
    assert.match(details, /09:00–11:00/);
    assert.equal(await js('window.testNotifications.length'), 1);
    assert.equal(await js("document.getElementById('bookingSeat').textContent"), 'XF5A001');
    assert.equal(await js("document.querySelectorAll('.booking-particle').length"), 64);
    await sleep(350);
    fs.writeFileSync(path.join(process.env.LIBSEAT_TEST_DIR, 'success-burst.png'), (await win.webContents.capturePage()).toPNG());
    await waitFor("!document.getElementById('bookingDialog').classList.contains('booking-celebrating')");
    assert.equal(await js("document.querySelector('.booking-burst').childElementCount"), 0);
    assert.equal(await js("document.getElementById('bookingDialog').open"), true);
    await js("document.getElementById('bookingDialog').close(); tick(); tick();");
    await sleep(1200);
    assert.equal(await js("document.getElementById('bookingDialog').open"), false);
    assert.equal(await js('window.testNotifications.length'), 1);
    await win.webContents.reload();
    await sleep(1000);
    await waitFor("!document.getElementById('bookingSummary').hidden");
    assert.equal(await js("document.getElementById('bookingDialog').open"), false);
    await js(`window.Notification = class { static permission = 'denied'; constructor(){ throw Error('must not notify'); } }; start();`);
    await waitFor("document.getElementById('bookingDialog').open");
    await js("document.getElementById('bookingDialog').close(); document.getElementById('btnBookingDetails').click();");
    assert.equal(await js("document.getElementById('bookingDialog').open"), true);
    await waitFor("document.querySelector('.booking-burst').childElementCount === 0");
    assert.equal(await js("document.getElementById('bookingDialog').classList.contains('booking-celebrating')"), false);
    await js(`const originalMatchMedia = window.matchMedia;
      window.matchMedia = () => ({matches:true});
      BookingCelebration.play(document.getElementById('bookingDialog'));
      window.matchMedia = originalMatchMedia; true;`);
    assert.equal(await js("document.querySelector('.booking-burst').childElementCount"), 0);
    const screenshot = await win.webContents.capturePage();
    fs.writeFileSync(path.join(process.env.LIBSEAT_TEST_DIR, 'success-dialog.png'), screenshot.toPNG());
    await js("document.getElementById('bookingDialog').close()");
    fs.writeFileSync(path.join(process.env.LIBSEAT_TEST_DIR, 'scenario.json'), JSON.stringify({ uncertain: true }));
    await js('start()');
    await waitFor("!document.getElementById('pendingBooking').hidden && document.getElementById('btnStart').disabled");
    assert.equal(await js("document.getElementById('bookingDialog').open"), false);
    assert.match(await js("document.getElementById('pendingDetails').textContent"), /XF5A001/);
    await js('loadBookingHistory()');
    assert.match(await js("document.getElementById('historyList').textContent"), /XF5A001/);
    await waitFor("!document.getElementById('btnResolveAbsent').disabled");
    await js("window.confirm = () => true; resolveBooking('not-booked')");
    await waitFor("document.getElementById('pendingBooking').hidden && !document.getElementById('btnStart').disabled");
    // Expired credentials must become a visible login prompt, not endless placeholders.
    const expired = 'mock.' + Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url') + '.signature';
    await js(`api('/api/config', { token: ${JSON.stringify(expired)} })`);
    win.reload();
    await waitFor("document.getElementById('mapLoadError').textContent.includes('登录已过期')");
    assert.match(await js("document.getElementById('tokenState').textContent"), /过期|失效/);
    assert.equal(await js("['selPremise','selStorey','selArea'].every(id => document.getElementById(id).disabled && !document.getElementById(id).textContent.includes('加载'))"), true);
    assert.match(await js("document.getElementById('mapEmpty').textContent"), /登录/);
    const logs = () => fs.readFileSync(path.join(process.env.LIBSEAT_TEST_DIR, 'requests.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    const initialTrees = logs().filter(r => r.path === '/v4/space/index').length;
    await js("api('/api/tree', {})");
    assert.equal(logs().filter(r => r.path === '/v4/space/index').length, initialTrees);
    // Restore a mock session and verify repeated clicks share one initialization.
    fs.writeFileSync(path.join(process.env.LIBSEAT_TEST_DIR, 'scenario.json'), JSON.stringify({ treeHealthy:true, treeDelay:150 }));
    await js("api('/api/config', {token:'mock-refreshed'}).then(() => loadConfig())");
    await js("Promise.all([initMapBrowser(true), initMapBrowser(true), initMapBrowser(true)])");
    assert.equal(logs().filter(r => r.path === '/v4/space/index').length - initialTrees, 1);
    await waitFor("document.getElementById('mapLoadHelp').hidden && document.getElementById('mapEmpty').hidden");
    assert.equal(await js("document.getElementById('selPremise').selectedOptions[0].textContent"), '测试馆');
    fs.writeFileSync(path.join(process.env.LIBSEAT_TEST_DIR, 'scenario.json'), JSON.stringify({ treeFail:true }));
    await js('initMapBrowser(true)');
    assert.equal(await js("document.getElementById('mapLoadHelp').hidden"), false);
    assert.match(await js("document.getElementById('mapLoadError').textContent"), /无法连接/);
    console.log('UI PASS: exact details, one notification, reload deduplication, denied permission fallback, reopen result');
    console.log('UI PASS: success burst, large seat number, bounded animation, close cleanup, quiet reopen, reduced motion');
    console.log('UI burst screenshot: ' + path.join(process.env.LIBSEAT_TEST_DIR, 'success-burst.png'));
    console.log('UI PASS: uncertain reservation blocks starting, keeps history, and allows explicit manual resolution');
    console.log('UI PASS: expired login exits loading, retry restores map, initialization is deduplicated, network errors are visible');
    console.log('UI screenshot: ' + path.join(process.env.LIBSEAT_TEST_DIR, 'success-dialog.png'));
    app.exit(0);
  } catch(e) { console.error(e); app.exit(1); }
});
