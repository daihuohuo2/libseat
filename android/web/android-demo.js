'use strict';
// This module never makes a network request. Demo storage is separate from real accounts.
const areas = [{ id: '59', name: 'A区' }, { id: '57', name: 'B区' }];
function seats(id) {
  return Array.from({ length: 48 }, (_, i) => {
    const status = i % 5 === 0 || i % 7 === 0 ? '1' : '6';
    const no = 'XF5' + (id === '57' ? 'B' : 'A') + String(i + 1).padStart(3, '0');
    return { id: 'demo-' + no, no, name: no, status, status_name: status === '1' ? '空闲' : '使用中',
      point_x: 5 + (i % 8) * 11.5, point_y: 6 + Math.floor(i / 8) * 15, width: 6, height: 8 };
  });
}
module.exports = { respond(path, body) {
  if (path === '/v4/space/index') return { code: 0, data: { premises: [{ id: '1', name: '潇湘校区馆（演示）' }], storey: [{ name: '五楼', list: [{ id: '5', parentId: '1' }] }] } };
  if (path === '/v4/space/pick') return { code: 0, data: { area: areas.map(a => ({ ...a, nameMerge: '演示馆-五楼-' + a.name, total_num: 48, free_num: seats(a.id).filter(s => s.status === '1').length })) } };
  if (path === '/v4/Space/seat') return { code: 0, data: { list: seats(String(body.id)) } };
  if (path === '/v4/Space/map') return { code: 0, data: { name: body.id === '57' ? 'B区' : 'A区', name_merge: '演示馆-五楼-' + (body.id === '57' ? 'B区' : 'A区'), web_plane: '', brother_area: areas } };
  if (path === '/v4/space/confirm') return { code: 0, message: '演示预约成功（未提交学校）' };
  return { code: -1, message: '演示模式不支持此操作' };
} };
