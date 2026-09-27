/**
 * 端到端模拟测试：验证用户的初衷
 *   「选好心仪座位 → 程序盯着 → 没有就等 → 一空出来立刻自动抢」
 *
 * 做法：用 LIBSEAT_MOCK 把官方接口替换成 mock-api.js 的场景（不发出任何真实请求），
 *      在独立端口启动一份服务，配置成"只抢心仪座位 + 关安全模式"，跑真实引擎循环。
 *
 * 运行：node test-engine.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = 8899;
const BASE = 'http://127.0.0.1:' + PORT;
const MOCK_LOG = path.join(ROOT, '.tmp-mock.jsonl');
const CFG_BAK = path.join(ROOT, '.tmp-config.bak.json');
const PREF = 'XF5A002';   // 心仪座位
const OTHER = 'XF5A001';  // 非心仪但先空出来的座位

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const post = (p, body) => fetch(BASE + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {})
}).then(r => r.json());
const getStatus = () => fetch(BASE + '/api/status').then(r => r.json());

(async () => {
  // 备份真实配置，测试结束必须恢复
  fs.copyFileSync(path.join(ROOT, 'config.json'), CFG_BAK);
  if (fs.existsSync(MOCK_LOG)) fs.unlinkSync(MOCK_LOG);

  console.log('启动测试服务（mock 接口，端口 ' + PORT + '）...');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      LIBSEAT_MOCK: path.join(ROOT, 'mock-api.js'),
      LIBSEAT_MOCK_LOG: MOCK_LOG,
      LIBSEAT_MOCK_PASS: '2'
    }),
    stdio: 'ignore'
  });

  const cleanup = () => {
    try { child.kill(); } catch (e) { }
    try { fs.copyFileSync(CFG_BAK, path.join(ROOT, 'config.json')); fs.unlinkSync(CFG_BAK); } catch (e) { }
    try { if (fs.existsSync(MOCK_LOG)) fs.unlinkSync(MOCK_LOG); } catch (e) { }
  };

  try {
    // 等服务起来
    let up = false;
    for (let i = 0; i < 30 && !up; i++) {
      await sleep(500);
      try { const r = await fetch(BASE + '/api/config'); up = r.ok; } catch (e) { }
    }
    if (!up) throw new Error('测试服务未启动（端口 ' + PORT + ' 是否被占用？）');

    // 配置：只抢心仪座位 + 关安全模式（真正提交）+ 快轮询
    await post('/api/config', {
      verifyOnly: false,
      seatPrefs: [PREF],
      seatPrefMode: 'only',
      areaIds: ['59'],
      areaNames: { '59': '五楼A区' },
      interval: 1,
      timeMode: 'now'
    });

    console.log('\n开始抢座（心仪座位 ' + PREF + '，只抢心仪模式）...');
    const started = await post('/api/start', {});
    check('引擎已启动', started.ok === true, JSON.stringify(started));

    // 等待引擎结束（成功后自动停止）
    let st = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      st = await getStatus();
      if (!st.running) break;
    }

    const logs = (st.logs || []).map(l => l.msg);
    const text = logs.join('\n');
    const mockCalls = fs.existsSync(MOCK_LOG)
      ? fs.readFileSync(MOCK_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      : [];
    const confirms = mockCalls.filter(c => c.path === 'CONFIRM');

    console.log('\n--- 引擎日志（节选）---');
    logs.filter(l => /心仪|候选|空闲|等待|预约|安全/.test(l)).slice(0, 14).forEach(l => console.log('  ' + l));

    console.log('\n1) 没有心仪空位时：等待，不抢别人的座位');
    check('日志显示候选里没有心仪座位', /暂无可约|都不在你的心仪列表内/.test(text));
    const earlyConfirms = confirms.filter(c => (c.phase || 0) < 2);
    check('等待阶段没有提交任何预约', earlyConfirms.length === 0, '等待阶段 confirm 次数=' + earlyConfirms.length);

    console.log('\n2) 心仪座位空出来后：立即自动抢');
    check('检测到心仪座位可约', /心仪座位（.*）可约情况：XF5A002/.test(text));
    check('候选标记为心仪座位（★）', /XF5A002★/.test(text));
    check('提交了预约', confirms.length === 1, 'confirm 次数=' + confirms.length);
    check('抢的正是心仪座位', confirms[0] && confirms[0].seat_id === 'id-' + PREF, '=> ' + (confirms[0] && confirms[0].seat_id));
    check('没有误抢非心仪座位 ' + OTHER, !confirms.some(c => c.seat_id === 'id-' + OTHER));
    check('日志明确报告成功', /预约成功！座位：XF5A002/.test(text) && /正是你的心仪座位/.test(text));

    console.log('\n3) 抢到后自动收工');
    check('引擎已自动停止', st.running === false);
    check('状态标记为已完成', st.success === true);

    console.log('\n4) 请求窗口正确（实时模式）');
    const confirmCall = mockCalls.find(c => c.path === '/v4/space/confirm');
    const seatCall = mockCalls.find(c => c.path === '/v4/Space/seat');
    const okTime = h => /^\d{2}:\d{2}$/.test(String(h || ''));
    check('预约请求带了时段', confirmCall && okTime(confirmCall.body.start_time) && okTime(confirmCall.body.end_time),
      confirmCall ? confirmCall.body.start_time + '-' + confirmCall.body.end_time : '无');
    check('查询请求带了时段', seatCall && okTime(seatCall.body.start_time), seatCall ? seatCall.body.start_time : '无');
  } catch (e) {
    fail++;
    console.log('\n测试异常: ' + e.message);
  } finally {
    cleanup();
    console.log('\n（已恢复原配置并清理临时文件）');
    console.log('结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
  }
})();
