'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
app.setPath('userData', path.join(process.env.LIBSEAT_TEST_DIR, 'ui'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1180, height: 1000, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const js = expr => win.webContents.executeJavaScript(expr, true);
  async function wait(expr) { for (let i = 0; i < 100; i++) { if (await js(expr)) return; await new Promise(r => setTimeout(r, 70)); } throw Error('Timeout: ' + expr); }
  try {
    await win.loadURL(process.env.LIBSEAT_TEST_URL);
    await wait("document.getElementById('bookingSummaryTitle').textContent==='预约成功'");
    await js("document.getElementById('btnBookingDetails').click()");
    await wait("!document.getElementById('bookingAction-cancel').hidden && !document.getElementById('bookingAction-cancel').disabled");
    if (process.env.LIBSEAT_UI_SCENARIO === 'cancel') {
      await js("window.confirm=()=>false; document.getElementById('bookingAction-cancel').click()");
      assert.equal(await js("document.getElementById('bookingSummaryTitle').textContent"), '预约成功');
      await js("window.confirm=()=>true; document.getElementById('bookingAction-cancel').click(); document.getElementById('bookingAction-cancel').click()");
      await wait("document.getElementById('bookingSummaryTitle').textContent==='已取消预约'");
      assert.equal(await js("document.getElementById('bookingDialog').open"), true);
      assert.equal(await js("document.getElementById('bookingAction-cancel').hidden"), true);
    } else {
      const file = path.join(process.env.LIBSEAT_TEST_DIR, 'management-row.json');
      const row = JSON.parse(fs.readFileSync(file, 'utf8')); row.status = '3'; row.status_name = '已签到'; row.oksign = 0;
      fs.writeFileSync(file, JSON.stringify(row));
      await js("document.getElementById('bookingRefresh').click()");
      await wait("document.getElementById('btnBookingDetails').textContent==='查看位置信息'");
      assert.equal(await js("document.getElementById('bookingTitle').textContent"), '位置信息');
      assert.equal(await js("document.getElementById('bookingAction-cancel').hidden"), true);
      assert.equal(await js("document.getElementById('bookingAction-leave').hidden"), false);
      assert.equal(await js("document.getElementById('bookingAction-checkout').hidden"), false);
      if (process.env.LIBSEAT_MANAGEMENT_CAPTURE) {
        win.webContents.invalidate(); await new Promise(r => setTimeout(r, 150));
        fs.writeFileSync(process.env.LIBSEAT_MANAGEMENT_CAPTURE, (await win.webContents.capturePage()).toPNG());
      }
      await js("window.confirm=()=>true; document.getElementById('bookingAction-leave').click()");
      await wait("document.getElementById('bookingSummaryTitle').textContent==='临时签离中'");
      assert.equal(await js("document.getElementById('bookingAction-leave').hidden"), true);
      await wait("!document.getElementById('bookingAction-checkout').disabled");
      await js("document.getElementById('bookingAction-checkout').click()");
      await wait("document.getElementById('bookingSummaryTitle').textContent==='已结束使用'");
      assert.equal(await js("document.getElementById('bookingAction-checkout').hidden"), true);
    }
    console.log('UI PASS: ' + process.env.LIBSEAT_UI_SCENARIO); app.exit(0);
  } catch (e) { console.error(e); app.exit(1); }
});
