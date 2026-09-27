/**
 * 探查座位图数据：/v4/Space/map 返回结构 + 座位几何坐标范围
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

(async () => {
  const now = new Date();
  const date = fd(now), t = hm(now);

  console.log('=== /v4/Space/map（不带参数）===');
  let r = await api('/v4/Space/map', {});
  console.log('code=' + r.code + ' msg=' + (r.message || ''));
  console.log(JSON.stringify(r).slice(0, 1500));

  console.log('\n=== /v4/Space/map（带 id/day/时间）===');
  r = await api('/v4/Space/map', { id: '59', day: date, start_time: t, end_time: '22:00' });
  console.log('code=' + r.code + ' msg=' + (r.message || ''));
  console.log(JSON.stringify(r).slice(0, 2000));

  console.log('\n=== 座位几何范围（A区）===');
  const sr = await api('/v4/Space/seat', { id: '59', day: date, label_id: '', start_time: t, end_time: t, begdate: '', enddate: '' });
  const list = (sr.data && sr.data.list) || [];
  const nums = k => list.map(s => Number(s[k])).filter(v => !isNaN(v));
  const stat = (arr) => arr.length ? 'min=' + Math.min(...arr).toFixed(2) + ' max=' + Math.max(...arr).toFixed(2) : '空';
  for (const k of ['point_x', 'point_y', 'width', 'height']) console.log('  ' + k + ': ' + stat(nums(k)));
  console.log('  座位数=' + list.length + '，示例3个:');
  list.slice(0, 3).forEach(s => console.log('   ', s.no, 'x=' + s.point_x, 'y=' + s.point_y, 'w=' + s.width, 'h=' + s.height, 'status=' + s.status + '(' + s.status_name + ')'));
  console.log('  data 其它字段: ' + Object.keys(sr.data || {}).join(', '));
  console.log('  data 摘要: ' + JSON.stringify(sr.data).slice(0, 400));
  process.exit(0);
})();
