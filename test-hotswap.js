/**
 * 运行中热切换方案测试：node test-hotswap.js
 * 场景（接口替身，不发真实请求）：
 *   XF5A001 一直空闲，XF5A002/XF5A003 一直占用
 *   方案A = 只抢 XF5A002（不可约）→ 应持续等待
 *   运行中切到 方案B = 只抢 XF5A001（可约）→ 下一轮应立即改用新方案并识别到可约
 * 证明：改方案不需要重启程序。
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = 8898;
const BASE = 'http://127.0.0.1:' + PORT;
const CFG_BAK = path.join(ROOT, '.tmp-config.bak.json');
const MOCK_LOG = path.join(ROOT, '.tmp-swap-mock.jsonl');

let pass = 0, fail = 0;
const check = (n, c, e) => {
  if (c) { pass++; console.log('  ✓ ' + n + (e ? '  ' + e : '')); }
  else { fail++; console.log('  ✗ ' + n + (e ? '  ' + e : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const post = (p, b) => fetch(BASE + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {})
}).then(r => r.json());
const logs = async () => ((await fetch(BASE + '/api/status').then(r => r.json())).logs || []).map(l => l.msg);

(async () => {
  fs.copyFileSync(path.join(ROOT, 'config.json'), CFG_BAK);
  console.log('启动测试服务（端口 ' + PORT + '，恒定场景）...');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      LIBSEAT_MOCK: path.join(ROOT, 'mock-api.js'),
      LIBSEAT_MOCK_STATIC: '1',
      LIBSEAT_MOCK_LOG: MOCK_LOG
    }),
    stdio: 'ignore'
  });
  const cleanup = () => {
    try { child.kill(); } catch (e) { }
    try { fs.copyFileSync(CFG_BAK, path.join(ROOT, 'config.json')); fs.unlinkSync(CFG_BAK); } catch (e) { }
    try { if (fs.existsSync(MOCK_LOG)) fs.unlinkSync(MOCK_LOG); } catch (e) { }
  };

  try {
    let up = false;
    for (let i = 0; i < 30 && !up; i++) {
      await sleep(500);
      try { up = (await fetch(BASE + '/api/config')).ok; } catch (e) { }
    }
    if (!up) throw new Error('测试服务未启动');

    await post('/api/config', {
      verifyOnly: true,                 // 安全模式：只观察，便于持续观察多轮
      interval: 1,
      areaIds: ['59'],
      areaNames: { '59': '五楼A区' },
      timeMode: 'now',
      seatPrefMode: 'only',
      seatPrefs: ['XF5A002']
    });

    console.log('\n用"只抢 XF5A002"启动引擎...');
    await post('/api/start', {});
    await sleep(5000);
    const before = (await logs()).join('\n');

    check('每轮日志带方案/区域标记', /\[方案：/.test(before), '');
    check('目标座位被占时识别为暂无可约', /可约情况：暂无可约/.test(before));
    check('没有误抢 XF5A001', /都不在你的心仪列表内/.test(before));

    console.log('\n运行中改选座位（不重启）...');
    const sw = await post('/api/config', { seatPrefs: ['XF5A001'], seatPrefMode: 'only' });
    check('配置更新成功', sw.ok === true);
    const cfgNow = await fetch(BASE + '/api/config').then(r => r.json());
    check('配置里座位已换成 XF5A001', JSON.stringify(cfgNow.config.seatPrefs) === '["XF5A001"]',
      JSON.stringify(cfgNow.config.seatPrefs));
    check('引擎仍在运行（未被打断）', (await fetch(BASE + '/api/status').then(r => r.json())).running === true);

    await sleep(6000);
    const after = (await logs()).join('\n');
    check('后续轮询改用新座位', /可约情况：XF5A001/.test(after));
    check('B 方案下识别到可约', /心仪座位（.*）可约情况：XF5A001/.test(after));
    check('安全模式下只提示不提交', /【安全模式】仅观察/.test(after));

    console.log('\n3) 区域级心仪（只按区选，不用挑座位号）：');
    try { fs.unlinkSync(MOCK_LOG); } catch (e) { }
    await post('/api/config', {
      areaIds: ['59', '88'],
      areaNames: { '59': '五楼A区', '88': '二楼Z区' },
      preferAreas: ['88'],
      seatPrefs: [],            // 不指定具体座位 → 抢该区任意空位
      seatPrefMode: 'only'
    });
    await sleep(7000);

    const logs3 = (await logs()).join('\n');
    check('启动/轮询日志标记了心仪区域', /心仪区：二楼Z区/.test(logs3));
    const calls3 = fs.existsSync(MOCK_LOG)
      ? fs.readFileSync(MOCK_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    const seatCalls = calls3.filter(c => c.path === '/v4/Space/seat').map(c => String(c.body && c.body.id));
    check('只在心仪区(88)里查座位', seatCalls.length > 0 && seatCalls.every(id => id === '88'),
      '查询区域=' + JSON.stringify([...new Set(seatCalls)]));
    check('没有再去查非心仪区(59)', seatCalls.indexOf('59') === -1);
    check('识别到该区空闲座位', /XF2Z001/.test(logs3));

    console.log('\n--- 切换后的关键日志 ---');
    (await logs()).filter(l => /方案|心仪区|XF2Z001|安全模式/.test(l)).slice(-6).forEach(l => console.log('  ' + l));

    await post('/api/stop', {});
  } catch (e) {
    fail++;
    console.log('\n测试异常: ' + e.message);
  } finally {
    cleanup();
    console.log('\n（已恢复原配置）');
    console.log('结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
  }
})();
