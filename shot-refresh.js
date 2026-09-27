/**
 * 专门截一张"心仪座位状态刷新"的界面图：node shot-refresh.js
 * 步骤：清空 → 加 3 个座位 → 点刷新状态 → 等结果 → 截图
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 9224;
const PROFILE = path.join(os.tmpdir(), 'libseat-shot-profile');
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function cdp(wsUrl, method, params) {
  const s = new WebSocket(wsUrl);
  await new Promise((res, rej) => { s.onopen = res; s.onerror = rej; });
  return new Promise(resolve => {
    const t = setTimeout(() => { try { s.close(); } catch (e) { } resolve(null); }, 25000);
    s.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id === 1) { clearTimeout(t); try { s.close(); } catch (e) { } resolve(m.result); }
    };
    s.send(JSON.stringify({ id: 1, method: method, params: params || {} }));
  });
}
const evalJs = async (ws, expr) => {
  const r = await cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r && r.result ? r.result.value : undefined;
};

(async () => {
  if (!EDGE) { console.log('未找到 Edge'); process.exit(1); }
  // 演示态：加入两个区到抢选名单，并保存一个示例方案
  await fetch('http://127.0.0.1:8848/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatPrefs: [], preferAreas: ['59', '57'], seatPrefMode: 'only' })
  });

  const child = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE, '--no-first-run', '--window-size=1200,1600',
    'http://127.0.0.1:8848/'], { detached: true, stdio: 'ignore' });
  child.unref();

  let ws = null;
  for (let i = 0; i < 20 && !ws; i++) {
    await sleep(1000);
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
      const t = list.find(x => x.type === 'page' && x.url.includes('8848'));
      if (t) ws = t.webSocketDebuggerUrl;
    } catch (e) { }
  }
  if (!ws) { console.log('未能连接页面'); process.exit(1); }
  await cdp(ws, 'Runtime.enable', {});
  await cdp(ws, 'Page.addScriptToEvaluateOnNewDocument', { source: "window.__errs=[];window.addEventListener('error',e=>window.__errs.push(String(e.message)));" });

  await sleep(9000);
  // 等区域面板真正渲染出来（首次实时查询可能较慢）
  for (let i = 0; i < 30; i++) {
    const ok = await evalJs(ws, "document.querySelectorAll('#areas .area-item').length > 0");
    if (ok) break;
    await sleep(1000);
  }
  // 等座位图渲染
  for (let i = 0; i < 40; i++) {
    const ok = await evalJs(ws, "document.querySelectorAll('#mapSeats .seat').length > 20");
    if (ok) break;
    await sleep(1000);
  }

  // 可选：截图前切到指定区域（SHOT_AREA=<区域id>）
  const AREA = process.env.SHOT_AREA || '';
  if (AREA) {
    const switched = await evalJs(ws, `(function(){
      var s=document.getElementById('selArea');
      var o=[...s.options].find(x=>x.value==='${AREA}');
      if(!o) return 'no-option';
      s.value='${AREA}'; s.dispatchEvent(new Event('change')); return 'ok';
    })()`);
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const cur = String(await evalJs(ws, 'String(lastMapData && lastMapData.area && lastMapData.area.id)'));
      if (cur === AREA) break;
    }
    console.log('切换区域(' + AREA + ') = ' + switched);
  }

  console.log('画布 = ' + await evalJs(ws, "(function(){var w=document.getElementById('mapWrap');return w.clientWidth+'x'+w.clientHeight;})()"));
  console.log('图例：' + String(await evalJs(ws, "document.getElementById('mapLegend').innerText")).replace(/\n/g, ' | '));
  console.log('抢选名单：' + String(await evalJs(ws, "document.getElementById('grabList').innerText")).replace(/\n/g, ' '));
  console.log('区域面板：' + String(await evalJs(ws, "document.getElementById('areas').innerText")).replace(/\n/g, ' | ').slice(0, 80));
  console.log('实时提示：' + String(await evalJs(ws, "document.getElementById('liveHint').innerText")).slice(0, 80));

  const shot = await cdp(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  if (shot && shot.data) {
    fs.writeFileSync(path.join(__dirname, process.env.SHOT_OUT || 'shot-refresh.png'), Buffer.from(shot.data, 'base64'));
    console.log('已保存 ' + (process.env.SHOT_OUT || 'shot-refresh.png'));
  }

  try {
    const ver = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(r => r.json());
    await cdp(ver.webSocketDebuggerUrl, 'Browser.close', {});
  } catch (e) { }
  process.exit(0);
})();
