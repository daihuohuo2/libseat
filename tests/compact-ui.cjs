'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
app.setPath('userData', path.join(process.env.LIBSEAT_TEST_DIR, 'compact-ui'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1120, height: 860, webPreferences: { offscreen: true, backgroundThrottling: false, preload: path.join(__dirname, 'compact-preload.cjs') } });
  const js = expr => win.webContents.executeJavaScript(expr, true);
  async function wait(expr) { for (let i = 0; i < 100; i++) { if (await js(expr)) return; await new Promise(r => setTimeout(r, 70)); } throw Error('Timeout: ' + expr); }
  try {
    if (process.env.LIBSEAT_TEST_CACHE_UPGRADE) {
      await win.loadURL(process.env.LIBSEAT_TEST_URL + '/__cache-prime');
      await wait("navigator.serviceWorker.controller?.scriptURL.endsWith('/__legacy-sw.js')");
      assert.equal(await js('typeof SeatMap.isMine'), 'undefined');
      await win.loadURL(process.env.LIBSEAT_TEST_URL + '/__legacy-page');
      await wait("document.getElementById('mapLoadError').textContent.includes('SeatMap.isMine is not a function')");
      assert.equal(await js("fetch('/__cache-stats').then(r=>r.json()).then(r=>r.unversionedMapRequests)"), 1, 'old script really came from the browser cache');
    }
    await win.loadURL(process.env.LIBSEAT_TEST_URL);
    await wait("document.querySelector('#mapSeats .seat-mine') && document.getElementById('btnRenewalStart').disabled===false");
    assert.equal(await js("document.getElementById('mapLoadHelp').hidden"), true);
    if (process.env.LIBSEAT_TEST_CACHE_UPGRADE) {
      await wait("navigator.serviceWorker.controller?.scriptURL.endsWith('/sw.js')");
      assert.equal(await js('testAssetRevision'), 1);
      await js("fetch('/__advance-assets')");
      await win.loadURL(process.env.LIBSEAT_TEST_URL);
      await wait("document.querySelector('#mapSeats .seat-mine') && document.getElementById('btnRenewalStart').disabled===false");
      assert.equal(await js('testAssetRevision'), 2, 'updated worker bypasses the old one-hour HTTP cache on ordinary reload');
    }
    assert.equal(await js("getComputedStyle(document.querySelector('#mapSeats .seat-mine')).backgroundColor"), 'rgb(199, 70, 60)');
    assert.equal(await js("document.querySelector('#mapSeats .seat-mine').title"), 'XF5A149 · 我的预约 · 点选盯座');
    assert.equal(await js("document.querySelector('#mapLegend .seat-mine').textContent.trim()"), '我的预约 1');
    assert.equal(await js("document.querySelector('.hero')"), null);
    assert.equal(await js("document.querySelector('.desktop-sidebar')"), null);
    assert.equal(await js("document.querySelector('.map-panel').firstElementChild.className"), 'renewal-panel');
    assert.ok(await js("document.getElementById('btnRenewalStart').getBoundingClientRect().bottom < innerHeight"));
    await js("document.getElementById('btnHelp').click()");
    assert.equal(await js("document.getElementById('helpDialog').open"), true);
    assert.match(await js("document.getElementById('helpDialog').textContent"), /整段预约使用官网时段编号/);
    await js("document.getElementById('btnCloseHelp').click(); clearInterval(polling); updateMapBooking({success:false,booking:mapBookingStatus.booking})");
    assert.equal(await js("document.querySelectorAll('#mapSeats .seat-mine').length"), 0);
    await js("window.compactBooking={id:'old-segment',seatId:'149',seat:'XF5A149',area:'测试馆-五楼A区',areaId:'59',date:'2026-10-10'}; updateMapBooking({success:true,booking:compactBooking})");
    await wait("document.querySelectorAll('#mapSeats .seat-mine').length===1");
    if (process.env.LIBSEAT_COMPACT_CAPTURE) {
      win.webContents.invalidate(); await new Promise(r => setTimeout(r, 150));
      fs.writeFileSync(process.env.LIBSEAT_COMPACT_CAPTURE, (await win.webContents.capturePage()).toPNG());
    }
    await win.setSize(390, 844);
    await new Promise(r => setTimeout(r, 200));
    assert.ok(await js("document.documentElement.scrollWidth <= innerWidth + 1"));
    await js("document.getElementById('btnHelp').click()");
    assert.ok(await js("document.getElementById('helpDialog').getBoundingClientRect().width <= innerWidth"));
    await js("document.getElementById('btnCloseHelp').click()");
    console.log('UI PASS: stale-cache reproduction, ordinary-reload recovery, later asset updates, red own seat, lifecycle redraw, compact desktop, help and narrow-screen layout'); app.exit(0);
  } catch (e) { console.error(e); app.exit(1); }
});
