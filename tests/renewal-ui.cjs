'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
app.setPath('userData', path.join(process.env.LIBSEAT_TEST_DIR, 'electron'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1180, height: 1000, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const js = expr => win.webContents.executeJavaScript(expr, true);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function waitFor(expr) { for (let i = 0; i < 60; i++) { if (await js(expr)) return; await sleep(100); } throw Error('Timed out: ' + expr); }
  try {
    await win.loadURL(process.env.LIBSEAT_TEST_URL);
    // A stopped next-booking plan never adopted this reservation; keep it in history only.
    await waitFor("document.getElementById('renewalState').textContent === '未开启'");
    assert.equal(await js("document.getElementById('renewalTiming').textContent"), '');
    assert.notEqual(await js("document.getElementById('renewalEvents').textContent"), '暂无记录。');
    await js("document.querySelectorAll('dialog[open]').forEach(d => d.close()); document.getElementById('renewalMode').value='current'; document.getElementById('renewalArrival').value='14:00'; document.getElementById('renewalInterval').value='37'; document.getElementById('renewalInterval').dispatchEvent(new Event('input'));");
    assert.equal(await js("document.getElementById('renewalIntervalValue').textContent"), '37 分钟');
    await sleep(1100);
    assert.equal(await js("document.getElementById('renewalInterval').value"), '37', 'polling must not reset a draft choice');
    // Keep the browser and isolated server on the same test date.
    await js(`window.RealDate = Date; window.Date = class extends RealDate { constructor(...args){super(...(args.length?args:[RealDate.parse('2026-10-10T08:50:00+08:00')]));} static now(){return RealDate.parse('2026-10-10T08:50:00+08:00');}}; true;`);
    await js("document.getElementById('btnRenewalStart').click()");
    await waitFor("document.getElementById('renewalState').textContent === '计时中'");
    assert.equal(await js("document.getElementById('btnStart').disabled"), true);
    assert.match(await js("document.getElementById('renewalTiming').textContent"), /XF5A149.*37 分钟.*14:00:00.*09:27:00/);
    assert.equal(await js("document.getElementById('renewalInterval').disabled"), true);
    await js("document.querySelectorAll('dialog[open]').forEach(d => d.close()); document.querySelector('.renewal-panel').scrollIntoView({block:'center'})");
    // Optional visual artifact: capturePage can fail when Windows has no drawable
    // desktop (locked/RDP). Functional UI assertions do not require a screenshot.
    if (process.env.LIBSEAT_CAPTURE_UI === '1') {
      win.webContents.invalidate();
      await sleep(300);
      fs.writeFileSync(path.join(process.env.LIBSEAT_TEST_DIR, 'renewal-ui.png'), (await win.webContents.capturePage()).toPNG());
      console.log('UI screenshot: ' + path.join(process.env.LIBSEAT_TEST_DIR, 'renewal-ui.png'));
    }
    await js("document.getElementById('btnRenewalStop').click()");
    await waitFor("document.getElementById('renewalState').textContent === '已停止'");
    assert.equal(await js("document.getElementById('btnStart').disabled"), false);
    await js("document.getElementById('renewalArrival').value='07:00'; document.getElementById('btnRenewalStart').click()");
    await waitFor("document.getElementById('renewalStatus').textContent.includes('尚未到达')");
    await sleep(1200);
    assert.match(await js("document.getElementById('renewalStatus').textContent"), /尚未到达/);
    await waitFor('!loginPollPending');
    await js(`window.originalApi = api; window.mockLoginState = {active:true,mode:'silent',elapsed:8,hint:'正在后台检查'};
      window.cancelCalls=0; api = async (path, body, method) => {
        if(path==='/api/login-status') return window.mockLoginState;
        if(path==='/api/login-cancel'){window.cancelCalls++;window.mockLoginState={active:false,error:'已停止等待'};return {ok:true};}
        return window.originalApi(path,body,method);
      }; pollLogin();`);
    await waitFor("document.getElementById('btnAuto').textContent === '打开登录窗口' && !document.getElementById('btnCancelLogin').hidden");
    assert.equal(await js("document.getElementById('btnAuto').disabled"), false);
    assert.match(await js("document.getElementById('autoHint').textContent"), /8 秒/);
    await js("document.getElementById('btnCancelLogin').click()");
    await waitFor("document.getElementById('autoHint').textContent.includes('已停止等待')");
    assert.equal(await js('window.cancelCalls'), 1);
    assert.equal(await js("document.getElementById('btnCancelLogin').hidden"), true);
    await js('api=window.originalApi; true;');
    await waitFor('!tickPending');
    await js(`window.bookingStatusFixture = {running:false,success:false,pendingBooking:null,logs:[],
      stopReason:'座位 TEST51 预约失败：未选择或申请时间错误',lastFailure:'座位 TEST51 预约失败：未选择或申请时间错误'};
      window.bookingOriginalApi=api; api=async(path,body,method)=>path==='/api/status'?window.bookingStatusFixture:window.bookingOriginalApi(path,body,method); tick();`);
    await waitFor("document.getElementById('runState').textContent==='已停止'");
    assert.match(await js("document.getElementById('taskFeedback').textContent"), /申请时间错误/);
    await js("bookingStatusFixture.running=true;bookingStatusFixture.stopReason='';tick();");
    await waitFor("document.getElementById('taskFeedback').textContent.includes('其他空位')");
    assert.match(await js("document.getElementById('taskFeedback').textContent"), /申请时间错误/);
    await js('api=window.bookingOriginalApi;true;');
    // Dense-map regression: irregular coordinates, all status colors, zoom and refresh.
    await js(`window.mapFixture = {area:{id:'test-map',name:'测试馆-五楼-A区'},seats:Array.from({length:230},(_,i)=>({
      id:String(i),no:'XF5A'+String(i+1).padStart(3,'0'),x:(i%25)*3.3+(i%3-1)*.1,
      y:Math.floor(i/25)*3.8+(i%5-2)*.1,w:2.2+(i%3-1)*.08,h:3.8,status:['1','2','7','6'][i%4]
    }))}; lastMapData=window.mapFixture; renderSeatMap(lastMapData);`);
    const mapState = await js(`(() => {
      const seats=[...document.querySelectorAll('#mapSeats .seat')];
      return {count:seats.length,labels:seats.every(s=>s.textContent.length===3),
        widths:[...new Set(seats.map(s=>s.style.width))],heights:[...new Set(seats.map(s=>s.style.height))],
        cells:new Set(seats.map(s=>s.style.left+','+s.style.top)).size,
        colors:seats.slice(0,4).map(s=>getComputedStyle(s).backgroundColor),
        titles:seats.slice(0,4).map(s=>s.title),zoom:document.getElementById('mapZoomValue').textContent};
    })()`);
    assert.equal(mapState.count, 230); assert.equal(mapState.labels, true); assert.equal(mapState.cells, 230);
    assert.equal(mapState.widths.length, 1); assert.equal(mapState.heights.length, 1);
    assert.deepEqual(mapState.colors, ['rgb(197, 235, 210)', 'rgb(255, 229, 160)', 'rgb(206, 229, 255)', 'rgb(233, 232, 227)']);
    assert.deepEqual(mapState.titles, ['XF5A001 · 空闲', 'XF5A002 · 已预约', 'XF5A003 · 临时离开', 'XF5A004 · 使用中']);
    await js("document.getElementById('btnMapZoomIn').click()");
    assert.ok(parseInt(await js("document.getElementById('mapZoomValue').textContent")) > parseInt(mapState.zoom));
    await js("mapFixture.seats[0].status='7'; renderSeatMap(mapFixture);");
    assert.equal(await js("document.querySelector('#mapSeats .seat').title"), 'XF5A001 · 临时离开');
    await js("document.getElementById('btnMapReset').click()");
    assert.equal(await js('seatMapZoom'), 1);
    assert.equal(await js("document.getElementById('mapWrap').scrollLeft"), 0);
    assert.equal(await js("document.getElementById('mapWrap').scrollTop"), 0);
    console.log('UI PASS: 230 aligned seats, numbers, green/yellow/blue/gray colors, zoom, live status refresh and reset');
    console.log('UI PASS: activate, schedule/seat, disabled conflicting start, stop, persistent validation error');
    console.log('UI PASS: background login permits visible login; elapsed status and cancel-wait work');
    console.log('UI PASS: booking rejection remains visible while searching and after stopping');
    app.exit(0);
  } catch (e) { console.error(e); app.exit(1); }
});
