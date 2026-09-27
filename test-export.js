/**
 * 实测"导出文件"：在无头 Edge 里点导出，检查下载目录真的落了 JSON 文件且内容正确
 * 运行：node test-export.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 9225;
const PROFILE = path.join(os.tmpdir(), 'libseat-export-profile');
const DL = path.join(os.tmpdir(), 'libseat-downloads');
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
    s.send(JSON.stringify({ id: 1, method: method, params: params || {} }));
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
  fs.rmSync(DL, { recursive: true, force: true });
  fs.mkdirSync(DL, { recursive: true });

  // 准备一份方案 + 名单
  await fetch('http://127.0.0.1:8848/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      seatPrefs: [], preferAreas: ['59', '57'], seatPrefMode: 'only',
      seatPlans: [{ id: 'pExportTest', name: '导出测试方案', areas: ['59', '57'], dateMode: 'today', interval: 6 }],
      activePlanId: 'pExportTest'
    })
  });

  const child = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE, '--no-first-run', '--window-size=1200,1400',
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

  // 允许下载到指定目录
  await cdp(ws, 'Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  await cdp(ws, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL }).catch(() => { });

  await sleep(8000);
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (Number(await evalJs(ws, "document.querySelectorAll('#mapSeats .seat').length")) > 50) break;
  }

  console.log('点击「导出文件」...');
  await evalJs(ws, "document.getElementById('btnPlanExport').click()");

  // headless 下 CDP 的下载目录重定向不总生效，因此同时检查系统下载文件夹
  const DL_DEFAULT = path.join(os.homedir(), 'Downloads');
  let file = null;
  for (let i = 0; i < 20 && !file; i++) {
    await sleep(1000);
    for (const dir of [DL, DL_DEFAULT]) {
      let files = [];
      try { files = fs.readdirSync(dir).filter(f => /座位助手方案-\d{8}\.json$/i.test(f)); } catch (e) { }
      if (files.length) { file = path.join(dir, files[files.length - 1]); break; }
    }
  }
  check('下载目录出现 JSON 文件', !!file, file ? path.basename(file) : '（没找到）');
  if (file) {
    let obj = null;
    try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { }
    check('文件是合法 JSON', !!obj);
    if (obj) {
      check('含 app 标识', obj.app === 'libseat', String(obj.app));
      check('含方案数组', Array.isArray(obj.plans) && obj.plans.length === 1, '方案数=' + (obj.plans || []).length);
      check('方案里有区域集合', (obj.plans[0].areas || []).length === 2, JSON.stringify(obj.plans[0].areas));
      check('文件名带日期', /座位助手方案-\d{8}\.json/.test(path.basename(file)), path.basename(file));
    }
  }
  const hint = String(await evalJs(ws, "document.getElementById('planHint').innerText"));
  check('界面提示已导出', /已导出 1 个方案/.test(hint), '=> ' + hint.slice(0, 40));

  // 复原
  await fetch('http://127.0.0.1:8848/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatPlans: [], activePlanId: '' })
  });
  try {
    const ver = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(r => r.json());
    await cdp(ver.webSocketDebuggerUrl, 'Browser.close', {});
  } catch (e) { }
  console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
