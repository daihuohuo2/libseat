/**
 * 侦察：① 校区/楼层/区域 三级结构数据源 ② 每个区域自己的底图 URL
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const BASE = 'https://libzw.csu.edu.cn';

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

/** 递归找出所有像 URL 的字段 */
function findUrls(obj, prefix, out) {
  out = out || [];
  prefix = prefix || '';
  if (!obj || typeof obj !== 'object') return out;
  Object.keys(obj).forEach(k => {
    const v = obj[k];
    const key = prefix ? prefix + '.' + k : k;
    if (typeof v === 'string' && /^(https?:)?\/\/|^\/?(upload|home|images?)\//.test(v) && /\.(jpg|jpeg|png|webp)/i.test(v)) {
      out.push(key + ' = ' + v);
    } else if (v && typeof v === 'object') {
      findUrls(v, key, out);
    }
  });
  return out;
}

(async () => {
  const now = new Date();
  const date = fd(now), t = hm(now);

  console.log('========== 1) /v4/space/index（疑似区域树） ==========');
  let r = await api('/v4/space/index', {});
  console.log('code=' + r.code + ' msg=' + (r.message || ''));
  console.log(JSON.stringify(r.data).slice(0, 1200));

  console.log('\n========== 2) /v4/index/category ==========');
  r = await api('/v4/index/category', {});
  console.log('code=' + r.code + ' msg=' + (r.message || ''));
  console.log(JSON.stringify(r.data).slice(0, 1200));

  console.log('\n========== 3) /v4/space/pick（看 premises/storey 字段） ==========');
  r = await api('/v4/space/pick', {
    premisesIds: ['1'], categoryIds: [], storeyIds: [], boutiqueIds: [],
    date: date, start_time: t, end_time: '22:00'
  });
  console.log('code=' + r.code + '；区域数=' + ((r.data && r.data.area) || []).length);
  const a0 = ((r.data && r.data.area) || [])[0];
  if (a0) {
    console.log('  第一条全字段: ' + JSON.stringify(a0).slice(0, 900));
    console.log('  --- 其中的图片字段 ---');
    findUrls(a0).forEach(x => console.log('   ' + x));
  }
  const storeys = new Set(((r.data && r.data.area) || []).map(a => a.storeyName + '(' + a.parentId + ')'));
  const premises = new Set(((r.data && r.data.area) || []).map(a => a.premisesName + '(' + a.topId + ')'));
  console.log('  涉及楼层: ' + [...storeys].join(' , '));
  console.log('  涉及校区: ' + [...premises].join(' , '));

  console.log('\n========== 4) /v4/space/detail（区域详情，找底图） ==========');
  r = await api('/v4/space/detail', { id: '59', day: date, start_time: t, end_time: '22:00' });
  console.log('code=' + r.code + ' msg=' + (r.message || ''));
  console.log(JSON.stringify(r.data).slice(0, 900));
  findUrls(r.data).forEach(x => console.log('   IMG ' + x));

  console.log('\n========== 5) /v4/Space/map 的图片字段 ==========');
  r = await api('/v4/Space/map', { id: '59', day: date, start_time: t, end_time: '22:00' });
  findUrls(r.data).forEach(x => console.log('   IMG ' + x));
  console.log('  name=' + (r.data && r.data.name) + ' name_merge=' + (r.data && r.data.name_merge)
    + ' storey=' + (r.data && r.data.storey_name) + ' premise=' + (r.data && r.data.premise_name));

  console.log('\n========== 6) /v4/Space/label ==========');
  r = await api('/v4/Space/label', { id: '59' });
  console.log('code=' + r.code + ' ' + JSON.stringify(r.data).slice(0, 400));
  process.exit(0);
})();
