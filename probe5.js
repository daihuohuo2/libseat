/**
 * 按官网自身的实时口径查询：start = ceil(now/15min)，end = 22:00
 * 验证 pick 汇总与座位明细是否一致，并输出实时状态分布
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = 'https://libzw.csu.edu.cn';
const AES_IV = 'ZZWBKJ_ZHIHUAWEI';
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

function aesKey(d0) {
  const d = d0 || new Date();
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
      'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest',
      'authorization': 'bearer' + cfg.token,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    },
    body: JSON.stringify(body || {})
  });
  return JSON.parse(await res.text());
}
const p2 = n => String(n).padStart(2, '0');
function fmtMin(m) { return p2(Math.floor(m / 60)) + ':' + p2(m % 60); }
/** 官网口径：今日 -> 现在向上取整到 step，不足 08:00 用 08:00，超过 22:00 用 22:00 */
function nowWindow(axisStart, axisEnd, step, maxMin) {
  const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  const s = toMin(axisStart), e = toMin(axisEnd);
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  let start;
  if (mins < s) start = s;
  else { start = Math.ceil(mins / step) * step; if (start >= e) start = e; }
  const end = Math.min(start + maxMin, e);
  return { start: fmtMin(start), end: fmtMin(end) };
}
function fd(d) { return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }

(async () => {
  const w = nowWindow('08:00', '22:00', 15, 240);
  const date = fd(new Date());
  console.log('现在: ' + new Date().toLocaleString('zh-CN'));
  console.log('官网实时口径窗口: ' + w.start + ' - ' + w.end + '  日期 ' + date);

  const pick = await api('/v4/space/pick', {
    premisesIds: cfg.premisesIds, categoryIds: [], storeyIds: cfg.storeyIds,
    boutiqueIds: [], date: date, start_time: w.start, end_time: w.end
  });
  console.log('\npick code=' + pick.code);
  const areas = (pick.data && pick.data.area) || [];
  for (const a of areas.filter(x => ['59', '57'].includes(String(x.id)))) {
    console.log('  [' + a.id + '] ' + (a.nameMerge || a.name) + ' 汇总 free_num=' + a.free_num + '/' + a.total_num);
  }

  for (const id of ['59', '57']) {
    const sr = await api('/v4/Space/seat', {
      id: id, day: date, label_id: '', start_time: w.start, end_time: w.end, begdate: '', enddate: ''
    });
    const list = (sr.data && sr.data.list) || [];
    const dist = {};
    list.forEach(s => { const k = s.status_name || s.status; dist[k] = (dist[k] || 0) + 1; });
    const free = list.filter(s => String(s.status) === '1');
    console.log('\n明细 area=' + id + ' code=' + sr.code + ' 总数=' + list.length);
    console.log('  状态分布: ' + JSON.stringify(dist));
    console.log('  实时可约 status=1: ' + free.length + ' 个 -> ' + free.slice(0, 10).map(s => s.no).join(', '));
    await new Promise(r => setTimeout(r, 300));
  }
  process.exit(0);
})();
