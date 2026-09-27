/**
 * 找到"此刻"的正确查询姿势：
 * 用不同窗口（含当前分钟、窗格取整、未来窗口）查询同一区域，
 * 看哪种结果的 使用中/空闲/临时离开 分布才是"当前状态"。
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
function fd(d) { return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
function hm(d) { return p2(d.getHours()) + ':' + p2(d.getMinutes()); }

async function seat(areaId, date, start, end, tag) {
  const body = { id: areaId, day: date, label_id: '' };
  if (start !== null) { body.start_time = start; body.end_time = end; body.begdate = ''; body.enddate = ''; }
  const r = await api('/v4/Space/seat', body);
  if (r.code !== 0) { console.log(tag.padEnd(28) + ' | code=' + r.code + ' ' + (r.message || '')); return; }
  const list = (r.data && r.data.list) || [];
  const dist = {};
  list.forEach(s => { const k = s.status_name || s.status; dist[k] = (dist[k] || 0) + 1; });
  console.log(tag.padEnd(28) + ' | ' + JSON.stringify(dist));
}

async function pick(date, start, end, tag) {
  const body = {
    premisesIds: cfg.premisesIds, categoryIds: [], storeyIds: cfg.storeyIds,
    boutiqueIds: [], date: date
  };
  if (start !== null) { body.start_time = start; body.end_time = end; }
  const r = await api('/v4/space/pick', body);
  if (r.code !== 0) { console.log(tag.padEnd(28) + ' | pick code=' + r.code + ' ' + (r.message || '')); return; }
  const a = ((r.data && r.data.area) || []).find(x => String(x.id) === '59');
  console.log(tag.padEnd(28) + ' | pick A区 free_num=' + (a ? a.free_num : '-'));
}

(async () => {
  const now = new Date();
  const date = fd(now);
  const nowHM = hm(now);
  const plus = m => hm(new Date(now.getTime() + m * 60000));
  console.log('现在: ' + now.toLocaleString('zh-CN') + '（' + nowHM + '）\n');
  console.log('====== 座位明细（A区 59）======');
  await seat('59', date, null, null, '不带时间参数');
  await seat('59', date, '', '', '空字符串时间');
  await seat('59', date, nowHM, nowHM, '此刻=此刻 ' + nowHM + '-' + nowHM);
  await seat('59', date, nowHM, plus(1), '此刻起1分钟 ' + nowHM + '-' + plus(1));
  await seat('59', date, nowHM, plus(15), '此刻起15分钟 ' + nowHM + '-' + plus(15));
  await seat('59', date, nowHM, plus(240), '此刻起4小时 ' + nowHM + '-' + plus(240));
  await seat('59', date, '15:15', '19:15', '窗格取整 15:15-19:15');
  await seat('59', date, '16:00', '20:00', '未来窗口 16:00-20:00');
  await seat('59', date, '08:00', '12:00', '过去的窗口 08:00-12:00');

  console.log('\n====== 区域汇总（A区 59）======');
  await pick(date, null, null, '不带时间参数');
  await pick(date, nowHM, plus(1), '此刻起1分钟 ' + nowHM + '-' + plus(1));
  await pick(date, nowHM, plus(15), '此刻起15分钟');
  await pick(date, nowHM, plus(240), '此刻起4小时');
  await pick(date, '16:00', '20:00', '未来窗口 16:00-20:00');
  process.exit(0);
})();
