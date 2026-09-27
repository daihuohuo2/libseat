/**
 * 用无头 Edge + CDP 实测前端界面（座位图渲染、点选、实时数据）
 * 输出：截图 verify-ui.png + 断言结果
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 9223;
const PROFILE = path.join(require('os').tmpdir(), 'libseat-verify-profile');
const URL = 'http://127.0.0.1:8848/';
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));

const sleep = ms => new Promise(r => setTimeout(r, ms));

function ws(wsUrl) {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(wsUrl);
    s.onopen = () => resolve(s);
    s.onerror = (e) => reject(new Error('ws error'));
  });
}
async function cdp(wsUrl, method, params, timeoutMs) {
  const s = await ws(wsUrl);
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { s.close(); } catch (e) { } resolve(null); }, timeoutMs || 20000);
    s.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id === 1) { clearTimeout(t); try { s.close(); } catch (e) { } resolve(m.result); }
    };
    s.send(JSON.stringify({ id: 1, method, params: params || {} }));
  });
}
async function evalJs(pageWs, expr) {
  const r = await cdp(pageWs, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, 20000);
  return r && r.result ? r.result.value : undefined;
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
}

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
  // 测试自包含：先清空心仪座位与方案，避免受上一次运行残留影响
  try {
    const r0 = await fetch('http://127.0.0.1:8848/api/config').then(r => r.json());
    await fetch('http://127.0.0.1:8848/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatPrefs: [], seatPlans: [], activePlanId: '', seatPrefMode: r0.config.seatPrefMode || 'only' })
    });
  } catch (e) { }

  // 确保抢座引擎处于停止状态，避免干扰（同时验证界面请求不会被饿死）
  try { await fetch(URL + 'api/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (e) { }
  console.log('启动无头 Edge 验证界面...\n');
  const child = spawn(EDGE, [
    '--headless=new', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE, '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,900', URL
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  let pageWs = null;
  for (let i = 0; i < 20 && !pageWs; i++) {
    await sleep(1000);
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
      const p = list.find(t => t.type === 'page' && t.url.indexOf('127.0.0.1:8848') !== -1);
      if (p && p.webSocketDebuggerUrl) pageWs = p.webSocketDebuggerUrl;
    } catch (e) { }
  }
  if (!pageWs) { console.log('未能连接到页面'); process.exit(1); }

  // 等首屏实时数据真正回来（首次查询可能 10 秒以上）
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    const ok = await evalJs(pageWs, "document.querySelectorAll('#areas .area-item').length > 0");
    if (ok) break;
  }
  await sleep(1500);

  console.log('1) 基础渲染：');
  const title = await evalJs(pageWs, 'document.title');
  check('页面标题', title === '图书馆座位预约系统' || /座位/.test(String(title)), '=> ' + title);
  const areasHtml = await evalJs(pageWs, "document.getElementById('areas').innerText");
  check('区域面板有内容', /五楼|A区|B区/.test(String(areasHtml)), '=> ' + String(areasHtml).replace(/\n/g, ' | ').slice(0, 80));
  const winShow = await evalJs(pageWs, "document.getElementById('windowShow').value");
  check('同步时刻已填充', /\d{2}:\d{2}/.test(String(winShow)), '=> ' + winShow);
  const liveHint = await evalJs(pageWs, "document.getElementById('liveHint').innerText");
  check('实时同步提示', /实时同步/.test(String(liveHint)), '=> ' + String(liveHint).slice(0, 60));

  const badge = await evalJs(pageWs, "document.getElementById('tokenState').innerText");
  check('登录态徽标显示剩余有效期', /剩余 \d+ 分钟|有效/.test(String(badge)), '=> ' + badge);
  const noBox = await evalJs(pageWs, "document.getElementById('token') === null");
  check('已移除手动 token 输入框', noBox === true);

  console.log('\n2) 抢选名单区：');
  const grabPill = await evalJs(pageWs, "document.getElementById('prefState').innerText");
  check('抢选名单状态徽标', /未加入区域|\d+ 个区/.test(String(grabPill)), '=> ' + grabPill);
  check('有加入名单按钮', (await evalJs(pageWs, "document.getElementById('btnAddArea').innerText")).indexOf('加入') !== -1);
  check('有方案下拉与另存按钮', (await evalJs(pageWs, "!!document.getElementById('planSelect') && !!document.getElementById('btnPlanSave')")) === true);

  console.log('\n3) 实时座位图（只展示状态）：');
  let seatCount = 0;
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    seatCount = Number(await evalJs(pageWs, "document.querySelectorAll('#mapSeats .seat').length")) || 0;
    if (seatCount > 100) break;
  }
  check('座位块已渲染', seatCount > 100, '=> ' + seatCount + ' 个');
  check('已移除底图（只看位置图）', (await evalJs(pageWs, "document.getElementById('mapPlane') === null")) === true);
  check('已移除底图开关', (await evalJs(pageWs, "document.getElementById('chkPlane') === null")) === true);

  const pmOpts = await evalJs(pageWs, "document.getElementById('selPremise').options.length");
  check('① 校区馆下拉', Number(pmOpts) >= 1, '=> ' + pmOpts + ' 个');
  const stText = String(await evalJs(pageWs, "document.getElementById('selStorey').innerText")).replace(/    /g, '');
  check('② 楼层下拉含多楼', /一楼|二楼|三楼|四楼|五楼/.test(stText), '=> ' + stText.replace(/\n/g, '/').slice(0, 40));
  const arOpts = await evalJs(pageWs, "document.getElementById('selArea').options.length");
  check('③ 区域下拉（该楼层）', Number(arOpts) >= 2, '=> ' + arOpts + ' 个');

  const legendText = String(await evalJs(pageWs, "document.getElementById('mapLegend').innerText"));
  check('图例标明四种状态', /空闲/.test(legendText) && /已预约/.test(legendText) && /使用中/.test(legendText) && /临时离开/.test(legendText),
    '=> ' + legendText.replace(/\n/g, ' ').slice(0, 60));
  const swatches = await evalJs(pageWs, "document.querySelectorAll('#mapLegend .sw').length");
  check('图例带颜色色块', Number(swatches) === 4, '=> ' + swatches + ' 个');

  const cursor = await evalJs(pageWs, "getComputedStyle(document.querySelector('#mapSeats .seat')).cursor");
  check('座位不可点选（仅展示）', cursor === 'default', '=> cursor=' + cursor);
  const beforeCfg = await fetch('http://127.0.0.1:8848/api/config').then(r => r.json());
  const beforePrefs = JSON.stringify(beforeCfg.config.seatPrefs || []);
  await evalJs(pageWs, "(function(){document.querySelectorAll('#mapSeats .seat')[0].click();return 1;})()");
  await sleep(1500);
  const afterCfg = await fetch('http://127.0.0.1:8848/api/config').then(r => r.json());
  check('点击座位不再写入任何选择', JSON.stringify(afterCfg.config.seatPrefs || []) === beforePrefs,
    '=> ' + JSON.stringify(afterCfg.config.seatPrefs || []));

  console.log('\n3a) 切换楼层（三级联动）：');
  await evalJs(pageWs, `(function(){
    var s=document.getElementById('selStorey');
    var opt=[...s.options].find(o=>o.text.indexOf('四楼')===0);
    if(!opt) return 'no';
    s.value=opt.value; s.dispatchEvent(new Event('change')); return 'ok';
  })()`);
  await sleep(9000);
  const areaText = String(await evalJs(pageWs, "document.getElementById('selArea').innerText"));
  check('切到四楼后区域列表刷新', /区/.test(areaText), '=> ' + areaText.replace(/\n/g, '/').slice(0, 50));
  await evalJs(pageWs, `(function(){
    var s=document.getElementById('selStorey');
    var opt=[...s.options].find(o=>o.text.indexOf('五楼')===0);
    s.value=opt.value; s.dispatchEvent(new Event('change')); return 'ok';
  })()`);
  await sleep(9000);
  check('切回五楼后地图重新加载', Number(await evalJs(pageWs, "document.querySelectorAll('#mapSeats .seat').length")) > 100);

  console.log('\n3b) 加入抢选名单：');
  await fetch('http://127.0.0.1:8848/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preferAreas: [], seatPrefs: [] })
  });
  await evalJs(pageWs, "location.reload()");
  await sleep(5000);
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    if (Number(await evalJs(pageWs, "document.querySelectorAll('#mapSeats .seat').length")) > 100) break;
  }
  await evalJs(pageWs, "document.getElementById('btnAddArea').click()");
  await sleep(5000);
  let cfgG = await fetch('http://127.0.0.1:8848/api/config').then(r => r.json());
  check('加入名单写入 preferAreas', (cfgG.config.preferAreas || []).length === 1, JSON.stringify(cfgG.config.preferAreas));
  let listChips = await evalJs(pageWs, "document.querySelectorAll('#grabList .chip').length");
  check('名单显示区域标签', Number(listChips) === 1, '=> ' + listChips + ' 个');
  const pill = await evalJs(pageWs, "document.getElementById('prefState').innerText");
  check('名单计数正确', /1 个区/.test(String(pill)), '=> ' + pill);

  // 换一个区域再加一个（多区）
  await evalJs(pageWs, `(function(){
    var s=document.getElementById('selArea');
    if(s.options.length<2) return 'no';
    s.value=s.options[1].value; s.dispatchEvent(new Event('change')); return 'ok';
  })()`);
  await sleep(9000);
  console.log('      诊断: 下拉当前值=' + await evalJs(pageWs, "document.getElementById('selArea').value")
    + ' 显示名=' + await evalJs(pageWs, "document.getElementById('selArea').options[document.getElementById('selArea').selectedIndex].text")
    + ' curArea=' + await evalJs(pageWs, "String(curArea)" + '')
    + ' currentMapArea=' + await evalJs(pageWs, "String(currentMapArea)"));
  await evalJs(pageWs, "document.getElementById('btnAddArea').click()");
  await sleep(2500);
  console.log('      诊断: planHint=' + String(await evalJs(pageWs, "document.getElementById('planHint').innerText")).slice(0, 60));
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    cfgG = await fetch('http://127.0.0.1:8848/api/config').then(r => r.json());
    if ((cfgG.config.preferAreas || []).length === 2) break;
  }
  check('可加入多个区域', (cfgG.config.preferAreas || []).length === 2, JSON.stringify(cfgG.config.preferAreas));

  const order = await evalJs(pageWs, `(function(){
    var g=document.getElementById('grabList'), a=document.getElementById('areas');
    return String(g.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) === '4' ? 'after' : 'not-after';
  })()`);
  check('区域状态卡片位于抢选名单下方', order === 'after', '=> ' + order);
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const n = await evalJs(pageWs, "document.querySelectorAll('#areas .area-item').length");
    if (Number(n) === 2) break;
  }
  const areaCards = await evalJs(pageWs, "document.querySelectorAll('#areas .area-item').length");
  check('只显示名单里的 2 个区', Number(areaCards) === 2, '=> ' + areaCards + ' 张卡片');
  const areasHint = await evalJs(pageWs, "document.getElementById('areasHint').innerText");
  check('地区状态区标注了筛选说明', /仅显示抢选名单里的 2 个区/.test(String(areasHint)), '=> ' + areasHint);

  console.log('\n4) 常用方案（保存 / 套用）：');
  await evalJs(pageWs, "document.getElementById('btnPlanSave').click()");
  await sleep(600);
  await evalJs(pageWs, `(function(){document.getElementById('planNameInput').value='测试方案甲';document.getElementById('btnPlanOk').click();return 1;})()`);
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const n = await fetch('http://127.0.0.1:8848/api/config').then(r => r.json()).then(r => (r.config.seatPlans || []).length);
    if (n >= 1) break;
  }
  let cfgP = await fetch('http://127.0.0.1:8848/api/config').then(r => r.json());
  check('方案已保存', (cfgP.config.seatPlans || []).length === 1 && cfgP.config.seatPlans[0].name === '测试方案甲',
    JSON.stringify((cfgP.config.seatPlans || []).map(p => p.name + ':' + (p.areas || []).length + '区')));
  check('方案记住了区域', (cfgP.config.seatPlans[0].areas || []).length === 2, JSON.stringify(cfgP.config.seatPlans[0].areas));
  check('下拉里能看到方案', /测试方案甲（2 个区）/.test(String(await evalJs(pageWs, "document.getElementById('planSelect').innerText"))));

  // 清空名单后再套用方案，应恢复两个区
  await fetch('http://127.0.0.1:8848/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preferAreas: [] })
  });
  await evalJs(pageWs, "location.reload()");
  await sleep(5000);
  const planId = cfgP.config.seatPlans[0].id;
  // 等方案下拉真正填充好再操作（页面刚重载，配置加载需要时间）
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const has = await evalJs(pageWs, `[...document.getElementById('planSelect').options].some(o=>o.value==='${planId}')`);
    if (has) break;
  }
  await evalJs(pageWs, `(function(){
    var s=document.getElementById('planSelect');
    s.value='${planId}'; s.dispatchEvent(new Event('change')); return 1;
  })()`);
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    const t = String(await evalJs(pageWs, "document.getElementById('planHint').innerText"));
    if (/已套用方案/.test(t)) break;
  }
  cfgP = await fetch('http://127.0.0.1:8848/api/config').then(r => r.json());
  check('套用方案后名单恢复', (cfgP.config.preferAreas || []).length === 2, JSON.stringify(cfgP.config.preferAreas));
  check('套用时提示已显示', /已套用方案/.test(String(await evalJs(pageWs, "document.getElementById('planHint').innerText"))));

  const planPill = await evalJs(pageWs, "document.getElementById('activePlanPill').innerText");
  check('标题显示当前方案', /当前方案：测试方案甲/.test(String(planPill)), '=> ' + planPill);
  const saveBtn = await evalJs(pageWs, "document.getElementById('btnPlanSave').innerText");
  check('保存按钮在名单旁、文案明确', /保存为方案/.test(String(saveBtn)), '=> ' + saveBtn);
  check('有导出/导入按钮', (await evalJs(pageWs, "!!document.getElementById('btnPlanExport') && !!document.getElementById('btnPlanImport')")) === true);

  const payload = String(await evalJs(pageWs, "planExportPayload()"));
  let okJson = false, areasOk = false;
  try {
    const o = JSON.parse(payload);
    okJson = o.app === 'libseat' && Array.isArray(o.plans) && o.plans.length === 1;
    areasOk = (o.plans[0].areas || []).length === 2;
  } catch (e) { }
  check('导出内容为合法方案 JSON', okJson);
  check('导出内容包含区域集合', areasOk);

  // 导入一份方案（同名应改名去重）
  await evalJs(pageWs, `importPlansFromText(JSON.stringify({ plans: [{ name: '测试方案甲', areas: ['55'] }, { name: '导入新方案', areas: ['56','58'] }] }))`);
  await sleep(4000);
  cfgP = await fetch('http://127.0.0.1:8848/api/config').then(r => r.json());
  check('导入后方案增加到 3 个', (cfgP.config.seatPlans || []).length === 3,
    JSON.stringify((cfgP.config.seatPlans || []).map(p => p.name)));
  check('同名方案被改名去重', (cfgP.config.seatPlans || []).some(p => /测试方案甲（导入）/.test(p.name)));

  // 清理
  const delIds = (cfgP.config.seatPlans || []).map(p => p.id);
  for (const id of delIds) {
    await fetch('http://127.0.0.1:8848/api/plan-delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id })
    });
    await sleep(500);
  }
  await evalJs(pageWs, "location.reload()");
  await sleep(4000);
  cfgP = await fetch('http://127.0.0.1:8848/api/config').then(r => r.json());
  check('清理后方案已清空', (cfgP.config.seatPlans || []).length === 0, JSON.stringify(cfgP.config.seatPlans));
  await evalJs(pageWs, "document.getElementById('btnPlanDel').click()");
  await sleep(4000);
  cfgP = await fetch('http://127.0.0.1:8848/api/config').then(r => r.json());
  check('可删除方案', (cfgP.config.seatPlans || []).length === 0, JSON.stringify(cfgP.config.seatPlans));
  await fetch('http://127.0.0.1:8848/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preferAreas: [], seatPrefs: [] })
  });

  console.log('\n7) 截图：');
  const shot = await cdp(pageWs, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, 30000);
  if (shot && shot.data) {
    fs.writeFileSync(path.join(__dirname, 'verify-seatmap.png'), Buffer.from(shot.data, 'base64'));
    check('已保存 verify-seatmap.png', true);
  } else {
    check('截图', false);
  }

  // 复原：清空心仪座位
  await fetch('http://127.0.0.1:8848/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatPrefs: [] })
  });
  console.log('\n（已清空心仪座位，恢复默认任意座位）');
  console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');

  try { await fetch(`http://127.0.0.1:${PORT}/json/version`).then(r => r.json()).then(v => cdp(v.webSocketDebuggerUrl, 'Browser.close', {}, 3000)); } catch (e) { }
  process.exit(fail ? 1 : 0);
})();
