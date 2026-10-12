'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const dir = process.env.LIBSEAT_TEST_DIR, base = process.env.LIBSEAT_TEST_URL;
app.setPath('userData', path.join(dir, 'ui')); app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1180, height: 900,
    webPreferences: { offscreen: true, backgroundThrottling: false, preload: path.join(__dirname, 'compact-preload.cjs') } });
  const js = expr => win.webContents.executeJavaScript(expr, true);
  async function wait(expr) { for (let i = 0; i < 220; i++) { if (await js(expr)) return; await new Promise(r => setTimeout(r, 50)); } throw Error('Timeout: ' + expr); }
  const school = free => { const file = path.join(dir, 'school.json'); const data = JSON.parse(fs.readFileSync(file)); data.free = free; fs.writeFileSync(file, JSON.stringify(data)); };
  const login = () => fetch(base + '/api/auto-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"headlessFirst":false}' });
  try {
    await win.loadURL(base);
    await wait("mapReady && !mapLoading && !mapInitPending && !livePending && !locatingBooking && document.querySelectorAll('.seat-mine').length===2");
    school(true);
    await js("document.getElementById('btnMapRefresh').click();true");
    await wait("!fullRefreshPromise && lastMapData?.area.free===2 && document.querySelector('#areas .num')?.textContent.includes('2')");
    assert.match(await js("document.getElementById('selArea').selectedOptions[0].textContent"), /2 空位/);
    assert.equal(await js("document.querySelectorAll('#mapSeats .seat-available').length"), 1);
    school(false); await login();
    await wait("lastLoginGeneration===1 && !fullRefreshPromise && lastMapData?.area.free===0");
    // Capture an old response, then complete a second login between status polls.
    await js(`window.originalFetch=window.fetch; window.holdMap=true;
      window.fetch=async (...args)=>{ const response=await originalFetch(...args);
        if(args[0]==='/api/seats' && holdMap){holdMap=false;await new Promise(r=>window.releaseOldMap=r);}
        if(args[0]==='/api/tree' && window.failTree){window.failTree=false;return new Response(JSON.stringify({ok:false,code:10001,message:'测试登录失效'}));}
        return response;};loadSeatMap(curArea);true`);
    await wait("typeof releaseOldMap==='function'");
    school(true); await login();
    await wait("lastLoginGeneration===2 && !!fullRefreshPromise");
    assert.equal(await js("document.querySelectorAll('#mapSeats .seat').length"), 0, 'old seats cleared while fresh request waits');
    await js('releaseOldMap();true');
    await wait("!fullRefreshPromise && lastMapData?.area.free===2 && document.querySelector('#areas .num')?.textContent.includes('2')");
    assert.equal(await js("document.getElementById('mapLoadHelp').hidden"), true);
    // An explicit failed refresh must not leave old seats looking current, and can be retried.
    await js("window.failTree=true; document.getElementById('btnMapRefresh').click();true");
    await wait("!fullRefreshPromise && !document.getElementById('mapLoadHelp').hidden");
    assert.equal(await js("document.querySelectorAll('#mapSeats .seat').length"), 0);
    await js("document.getElementById('btnMapRetry').click();true");
    await wait("!fullRefreshPromise && mapReady && document.getElementById('mapLoadHelp').hidden");
    // Resume the same open page the next morning, including the old My Seat date override.
    fs.writeFileSync(path.join(dir, 'now.txt'), '2026-10-11T08:00:00+08:00');
    await js("lastResumeRefresh=0; window.dispatchEvent(new Event('focus'));true");
    await wait("!fullRefreshPromise && document.getElementById('bookingSummary').hidden && lastMapData?.date==='2026-10-11'");
    assert.equal(await js("getComputedStyle(document.getElementById('bookingSummary')).display"), 'none');
    assert.equal(await js("document.getElementById('btnMySeat').hidden"), true);
    assert.equal(await js("document.querySelectorAll('#mapSeats .seat-mine').length"), 0);
    await js("document.getElementById('bookingHistory').open=true;loadBookingHistory()");
    assert.match(await js("document.getElementById('historyList').textContent"), /已结束使用[\s\S]*XF5A001/);
    await win.loadURL(base);
    await wait("mapReady && !fullRefreshPromise && document.getElementById('bookingSummary').hidden");
    assert.equal(await js("document.getElementById('bookingDialog').open"), false);
    console.log('PASS: complete refresh, fast relogin, stale-response race, retry, next-day resume and history'); app.exit(0);
  } catch (e) { console.error(e); app.exit(1); }
});
