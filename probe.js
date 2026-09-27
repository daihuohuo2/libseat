/**
 * 诊断探针：对比 /v4/space/pick（区域汇总）与 /v4/Space/seat（座位明细）
 * 目的：确认 free_num 到底代表什么时段、以及它与座位明细是否一致
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
  const s = '' + d.getFullYear()
    + String(d.getMonth() + 1).padStart(2, '0')
    + String(d.getDate()).padStart(2, '0');
  return s + s.split('').reverse().join('');
}
function aesEncrypt(obj) {
  const c = crypto.createCipheriv('aes-128-cbc',
    Buffer.from(aesKey(), 'utf8'), Buffer.from(AES_IV, 'utf8'));
  return c.update(JSON.stringify(obj), 'utf8', 'base64') + c.final('base64');
}

async function api(pathname, body, useCrypto) {
  const payload = useCrypto ? { aesjson: aesEncrypt(body || {}) } : (body || {});
  const res = await fetch(BASE + pathname, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'authorization': 'bearer' + cfg.token,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    },
    body: JSON.stringify(payload)
  });
  return JSON.parse(await res.text());
}

function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function pick(label, start, end, date) {
  const r = await api('/v4/space/pick', {
    premisesIds: cfg.premisesIds, categoryIds: [], storeyIds: cfg.storeyIds,
    boutiqueIds: [], date: date, start_time: start, end_time: end
  });
  console.log('\n===== pick [' + label + '] ' + date + ' ' + start + '-' + end + ' code=' + r.code + ' =====');
  if (r.code !== 0) { console.log(JSON.stringify(r).slice(0, 300)); return; }
  const areas = (r.data && r.data.area) || [];
  console.log('返回区域数: ' + areas.length);
  // 目标区域 + 第一个区域的全字段
  areas.filter(a => ['59', '57'].includes(String(a.id))).forEach(a => {
    console.log('[' + a.id + '] ' + (a.nameMerge || a.name) + '  free_num=' + a.free_num + ' total_num=' + a.total_num);
  });
  const sample = areas.find(a => ['59', '57'].includes(String(a.id))) || areas[0];
  if (sample) {
    console.log('--- 区域对象全字段（' + sample.id + '）---');
    console.log(JSON.stringify(sample, null, 1).slice(0, 1200));
  }
  const keys = areas[0] ? Object.keys(areas[0]) : [];
  console.log('区域可用字段: ' + keys.join(', '));
}

async function seats(label, areaId, date, start, end) {
  const r = await api('/v4/Space/seat', {
    id: areaId, day: date, label_id: '',
    start_time: start, end_time: end, begdate: '', enddate: ''
  });
  console.log('\n===== seat [' + label + '] area=' + areaId + ' ' + date + ' ' + start + '-' + end + ' code=' + r.code + ' =====');
  if (r.code !== 0) { console.log(JSON.stringify(r).slice(0, 300)); return; }
  const list = (r.data && r.data.list) || [];
  const byStatus = {};
  list.forEach(s => { byStatus[s.status] = (byStatus[s.status] || 0) + 1; });
  console.log('座位总数: ' + list.length + '；status 分布: ' + JSON.stringify(byStatus));
  const free = list.filter(s => String(s.status) === '1');
  console.log('status=1 数量: ' + free.length + ' -> ' + free.slice(0, 12).map(s => s.no).join(', '));
  if (list[0]) {
    console.log('--- 座位对象全字段（第一个）---');
    console.log(JSON.stringify(list[0], null, 1).slice(0, 900));
  }
  if (list[1]) {
    console.log('--- 座位对象全字段（第二个）---');
    console.log(JSON.stringify(list[1], null, 1).slice(0, 900));
  }
}

(async () => {
  const d = today();
  console.log('现在时间: ' + new Date().toLocaleString('zh-CN'));
  try {
    await pick('配置时段（已过去）', cfg.startTime, cfg.endTime, d);
    await pick('当前时段', '15:00', '19:00', d);
    await pick('明日同时段', cfg.startTime, cfg.endTime, (() => { const x = new Date(); x.setDate(x.getDate() + 1); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); })());
    await seats('配置时段（已过去）', '59', d, cfg.startTime, cfg.endTime);
    await seats('当前时段', '59', d, '15:00', '19:00');
  } catch (e) {
    console.log('ERR: ' + (e.cause ? (e.cause.code || e.cause.message) : e.message));
  }
  process.exit(0);
})();
