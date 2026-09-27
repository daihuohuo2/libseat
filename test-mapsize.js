/**
 * 校验：不同区域的地图框大小是否一致、座位是否都在框内
 * A区（扁平）、B区（高瘦）、D区（窄高）分别测量
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 9226;
const PROFILE = path.join(os.tmpdir(), 'libseat-mapsize-profile');
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, c, e) => {
  if (c) { pass++; console.log('  ✓ ' + n + (e ? '  ' + e : '')); }
  else { fail++; console.log('  ✗ ' + n + (e ? '  ' + e : '')); }
};

async function cdp(wsUrl, method, params) {
  const s = new WebSocket(wsUrl);
  await new Promise((res, rej) => { s.onopen = res; s.onerror = rej; });
  return new Promise(resolve => {
    const t = setTimeout(() => { try { s.close(); } catch (e) { } resolve(null); }, 25000);
    s.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id === 1) { clearTimeout(t); try { s.close(); } catch (e) { } resolve(m.result); }
    };
    s.send(JSON.stringify({ id: 1, method, params: params || {} }));
  });
}
const evalJs = async (ws, expr) => {
  const r = await cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r && r.result ? r.result.value : undefined;
};

(async () => {

  // 前置：确保登录态可用（会话被挤掉时 /api/verify 会自动静默续期）
  try {
    const v = await fetch('http://127.0.0.1:8848/api/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    }).then(r => r.json());
    if (!v.ok) {
      console.log('⚠️ 登录态不可用：' + (v.message || '') + '（请在界面点「一键获取登录态」后重试）');
    } else {
      console.log('登录态检查：可用');
    }
  } catch (e) { console.log('⚠️ 登录态检查失败: ' + e.message); }
  if (!EDGE) { console.log('未找到 Edge'); process.exit(1); }
  await fetch('http://127.0.0.1:8848/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preferAreas: ['59', '57'], seatPrefs: [] })
  });

  const child = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE, '--no-first-run', '--window-size=1200,1500',
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

  await sleep(8000);
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    if (Number(await evalJs(ws, "document.querySelectorAll('#mapSeats .seat').length")) > 50) break;
  }

  const measure = () => evalJs(ws, `(function(){
    var w=document.getElementById('mapWrap');
    var seats=[...document.querySelectorAll('#mapSeats .seat')];
    var out=0, bad=[];
    seats.forEach(function(el){
      var l=parseFloat(el.style.left), t=parseFloat(el.style.top);
      var ww=parseFloat(el.style.width), hh=parseFloat(el.style.height);
      if(l< -0.5 || t< -0.5 || l+ww>100.5 || t+hh>100.5){
        out++;
        if(bad.length<4) bad.push(el.dataset.no+': left='+el.style.left+' top='+el.style.top+' w='+el.style.width+' h='+el.style.height);
      }
    });
    return JSON.stringify({w:w.clientWidth,h:w.clientHeight,seats:seats.length,out:out,bad:bad,view:JSON.stringify(lastMapData&&lastMapData.view)});
  })()`);

  const sizes = [];
  for (const [id, label] of [['59', 'A区(扁平)'], ['57', 'B区(高瘦)'], ['56', 'D区(窄高)'], ['55', 'C区(竖向)']]) {
    const sel = await evalJs(ws, `(function(){
      var s=document.getElementById('selArea');
      var o=[...s.options].find(x=>x.value==='${id}');
      if(!o) return 'no';
      s.value='${id}'; s.dispatchEvent(new Event('change')); return 'ok';
    })()`);
    if (sel !== 'ok') { console.log('  跳过 ' + label + '（当前楼层没有该区）'); continue; }
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const n = Number(await evalJs(ws, "document.querySelectorAll('#mapSeats .seat').length"));
      const cur = await evalJs(ws, "String(lastMapData && lastMapData.area && lastMapData.area.id)");
      if (n > 20 && cur === id) break;
    }
    const m = JSON.parse(String(await measure()));
    sizes.push(m.h);
    console.log('  ' + label + ' -> 画布 ' + m.w + '×' + m.h + '，座位 ' + m.seats + ' 个，越界 ' + m.out + ' 个');
    if (m.out) { console.log('      view=' + m.view); (m.bad || []).forEach(b => console.log('      ' + b)); }
    check(label + ' 座位都在画布内', m.out === 0, 'out=' + m.out);
  }

  check('各区域画布高度一致', new Set(sizes).size === 1, '高度=' + JSON.stringify(sizes));
  check('画布统一且更小（≤320px）', sizes[0] <= 320, sizes[0] + 'px');

  await fetch('http://127.0.0.1:8848/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preferAreas: [] })
  });
  try {
    const ver = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(r => r.json());
    await cdp(ver.webSocketDebuggerUrl, 'Browser.close', {});
  } catch (e) { }
  console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
