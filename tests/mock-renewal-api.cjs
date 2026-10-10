'use strict';
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.LIBSEAT_TEST_DIR;
let rows = JSON.parse(fs.readFileSync(path.join(dir, 'rows.json')));
let sequence = 1;
exports.recordAsset = 'function a(e){return request({url:"/v4/member/seat",data:e})}export{a as g};';
exports.respond = async (route, body) => {
  fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ route, body }) + '\n');
  if (route === '/v4/member/seat') return { code: 0, data: { data: rows } };
  if (route === '/v4/index/subscribe') return { code: 0, data: rows.filter(r => r.status !== '6').map(r => ({ ...r, type: '1', area_id: '59', space_id: r.seat_id })) };
  if (route === '/v4/space/cancel') {
    const row = rows.find(r => r.id === body.id);
    if (!row) throw Error('Unexpected reservation ID');
    row.status = '6'; row.status_name = '已取消'; return { code: 0 };
  }
  if (route === '/v4/space/confirm') {
    if (process.env.LIBSEAT_RENEWAL_TYPE === '1' && (body.segment !== 'whole-day' || body.start_time || body.end_time)) return { code: 201, message: '未选择或申请时间错误' };
    const begin = body.segment ? new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai' }).slice(0, 5) : body.start_time;
    rows.unshift({ id: 'renewed-' + sequence++, seat_id: body.seat_id, name: 'XF5A149', status: '2', status_name: '待签到', oksign: 1,
      beginTime: body.day + ' ' + begin + ':00', endTime: body.day + ' ' + (body.segment ? '22:00' : body.end_time) + ':00' });
    return { code: 0 };
  }
  if (route === '/v4/space/index') return { code: 0, data: { premises: [{ id: '1', name: '测试馆' }], storey: [{ name: '五楼', list: [{ id: '5', parentId: '1' }] }] } };
  if (route === '/v4/space/pick') return { code: 0, data: { area: [{ id: '59', name: '五楼A区', nameMerge: '测试馆-五楼A区', free_num: 1, total_num: 1 }] } };
  if (route === '/v4/Space/seat') return { code: 0, data: { list: Array.from({ length: 230 }, (_, i) => ({
    id: String(i + 1), no: 'XF5A' + String(i + 1).padStart(3, '0'), status: ['1','2','7','6'][i % 4],
    point_x: 4 + i % 23 * 3.7, point_y: 5 + Math.floor(i / 23) * 5, width: 2.2, height: 3.8 })) } };
  if (route === '/v4/Space/map') return { code: 0, data: { name: 'A区', name_merge: '测试馆-五楼-A区', type: '1', date: {
    reserveType: process.env.LIBSEAT_RENEWAL_TYPE || '3', list: [{ day: '2026-10-10',
      start_time: '2026-10-10 08:00:00', end_time: '2026-10-10 22:00:00', step: 15, min_time: 15, max_time: 240,
      times: [{ id: 'whole-day', status: process.env.LIBSEAT_SEGMENT_UNAVAILABLE ? 0 : 1, start: '08:00', end: '22:00' }] }] } } };
  return { code: 0, data: {} };
};
