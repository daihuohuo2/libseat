/**
 * 时段语义矩阵测试：确认 pick.free_num 与座位明细 status=1 统计的关系
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = 'https://libzw.csu.edu.cn';
const AES_IV = 'ZZWBKJ_ZHIHUAWEI';
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

function aesKey(date) {
  const d = date || new Date();
  const s = '' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  return s + s.split('').reverse().join('');
}
function aesEncrypt(obj) {
  const c = crypto.createCipheriv('aes-128-cbc', Buffer.from(aesKey(), 'utf8'), Buffer.from(AES_IV, 'utf8'));
  return c.update(JSON.stringify(obj), 'utf8', 'base64') + c.final('base64');
}
async function api(pathname, body) {
  const res = await fetch(BASE + pathname, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'authorization': 'bearer' + cfg.token,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    },
    body: JSON.stringify(body || {})
  });
  return JSON.parse(await res.text());
}
function fd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
async function probeDate(date, list) {
  console.log('\n########## ' + date + ' ##########');
  console.log('时段'.padEnd(14) + ' | pick汇总'.padEnd(10) + ' | 明细status1' + ' | 明细分布');
  for (const [s, e] of list) {
    const p = await api('/v4/space/pick', {
      premisesIds: cfg.premisesIds, categoryIds: [], storeyIds: cfg.storeyIds,
      boutiqueIds: [], date: date, start_time: s, end_time: e
    });
    const areas = (p.data && p.data.area) || [];
    const a59 = areas.find(a => String(a.id) === '59');
    const a57 = areas.find(a => String(a.id) === '57');
    const sr = await api('/v4/Space/seat', {
      id: '59', day: date, label_id: '', start_time: s, end_time: e, begdate: '', enddate: ''
    });
    const l = (sr.data && sr.data.list) || [];
    const dist = {};
    l.forEach(x => { dist[x.status] = (dist[x.status] || 0) + 1; });
    const n1 = l.filter(x => String(x.status) === '1').length;
    console.log(
      (s + '-' + e).padEnd(14) + ' | A:' + String(a59 ? a59.free_num : '-').padEnd(4)
      + ' B:' + String(a57 ? a57.free_num : '-').padEnd(4) + ' | '
      + String(n1).padEnd(10) + ' | ' + JSON.stringify(dist)
    );
    await new Promise(r => setTimeout(r, 400));
  }
}
(async () => {
  const now = new Date();
  const tom = new Date(); tom.setDate(tom.getDate() + 1);
  const dayAfter = new Date(); dayAfter.setDate(dayAfter.getDate() + 2);
  const windows = [
    ['06:00', '08:00'], ['08:00', '12:00'], ['10:00', '12:00'],
    ['12:00', '14:00'], ['15:00', '19:00'], ['18:00', '22:00'], ['20:00', '22:00']
  ];
  console.log('现在: ' + now.toLocaleString('zh-CN'));
  await probeDate(fd(now), windows);
  await probeDate(fd(tom), windows);
  await probeDate(fd(dayAfter), [['08:00', '12:00'], ['15:00', '19:00']]);
  process.exit(0);
})();
