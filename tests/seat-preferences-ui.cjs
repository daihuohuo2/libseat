'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
app.setPath('userData', path.join(process.env.LIBSEAT_TEST_DIR, 'preferences-ui'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1180, height: 1000, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const js = expression => win.webContents.executeJavaScript(expression, true);
  async function wait(expression) {
    for (let i = 0; i < 100; i++) { if (await js(expression)) return; await new Promise(r => setTimeout(r, 60)); }
    throw Error('Timed out: ' + expression);
  }
  try {
    await win.loadURL(process.env.LIBSEAT_TEST_URL);
    await wait("!!document.querySelector('.seat-preference-edit[data-id=\"51\"]')");
    const open = async () => {
      await js("document.querySelectorAll('dialog[open]').forEach(d=>d.close()); document.querySelector('.seat-preference-edit[data-id=\"51\"]').click()");
      await wait("document.querySelectorAll('#seatPrefGrid button').length===6 && !document.getElementById('seatPrefSave').disabled");
    };
    await open();
    assert.equal(await js("document.getElementById('seatPrefMode').value"), 'any');
    await js("document.getElementById('seatPrefMode').value='prefer';document.getElementById('seatPrefMode').dispatchEvent(new Event('change'));document.querySelector('#seatPrefGrid [data-no=\"AREA51002\"]').click();document.getElementById('seatPrefNumbers').value='51004-51006';document.getElementById('seatPrefAdd').click();");
    assert.equal(await js("document.querySelectorAll('#seatPrefGrid [aria-pressed=\"true\"]').length"), 4);
    await js("document.getElementById('seatPrefNumbers').value='999';document.getElementById('seatPrefAdd').click()");
    assert.match(await js("document.getElementById('seatPrefMessage').textContent"), /本区域没有/);
    await js("document.getElementById('seatPrefNumbers').value='';document.getElementById('seatPrefSave').click()");
    await wait("!document.getElementById('seatPrefsDialog').open");
    assert.deepEqual(await js("cfgCache.areaSeatPrefs['51'].seats"), ['AREA51002', 'AREA51004', 'AREA51005', 'AREA51006']);
    assert.match(await js("document.querySelector('.seat-preference-edit[data-id=\"51\"]').textContent"), /优先 4 个/);
    await open();
    assert.equal(await js("document.querySelectorAll('#seatPrefGrid [aria-pressed=\"true\"]').length"), 4);
    if (process.env.LIBSEAT_CAPTURE_UI === '1' || process.env.LIBSEAT_UI_CAPTURE_PATH) {
      win.webContents.invalidate(); await new Promise(r => setTimeout(r, 200));
      fs.writeFileSync(process.env.LIBSEAT_UI_CAPTURE_PATH || path.join(process.env.LIBSEAT_TEST_DIR, 'preferences.png'), (await win.webContents.capturePage()).toPNG());
    }
    await js("document.getElementById('seatPrefClose').click();document.getElementById('btnPlanSave').click();document.getElementById('planNameInput').value='测试座位偏好';document.getElementById('btnPlanOk').click()");
    await wait("document.getElementById('planHint').textContent.includes('已保存，下次')");
    const exported = await js('JSON.parse(planExportPayload()).plans');
    assert.deepEqual(exported[0].areaSeatPrefs['51'].seats, ['AREA51002', 'AREA51004', 'AREA51005', 'AREA51006']);
    await js('importPlansFromText(planExportPayload());');
    await wait("document.getElementById('planHint').textContent.includes('已导入')");
    assert.equal(await js("plans[1].areaSeatPrefs['51'].seats.length"), 4);
    await open();
    await js("document.getElementById('seatPrefMode').value='any';document.getElementById('seatPrefMode').dispatchEvent(new Event('change'));document.getElementById('seatPrefSave').click()");
    await wait("!document.getElementById('seatPrefsDialog').open");
    assert.deepEqual(await js("cfgCache.areaSeatPrefs['51']"), { mode: 'any', seats: [] });
    await js("applyPlan(plans[0].id)");
    await wait("cfgCache.areaSeatPrefs['51']?.seats.length===4");
    console.log('UI PASS: individual selection, inclusive ranges, validation, per-area save/reopen, unlimited, plan save/export/import/activation');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
