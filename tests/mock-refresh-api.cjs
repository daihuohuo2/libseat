'use strict';
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.LIBSEAT_TEST_DIR;
exports.recordAsset = 'function a(e){return request({url:"/v4/member/seat",data:e})}export{a as g};';
exports.respond = async (route, body) => {
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'school.json'), 'utf8'));
  fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ route, body }) + '\n');
  if (/\/(confirm|cancel|leave|checkout)$/.test(route)) throw Error('Refresh must never mutate school reservations');
  if (route === '/v4/member/seat') return { code: 0, data: { data: data.records } };
  if (route === '/v4/index/subscribe') return { code: 0, data: [] };
  if (route === '/v4/space/index') return { code: 0, data: { premises: [{ id: '1', name: '测试馆' }], storey: [{ name: '五楼', list: [{ id: '5', parentId: '1' }] }] } };
  if (route === '/v4/space/pick') return { code: 0, data: { area: [{ id: '59', name: 'A区', nameMerge: '测试馆-五楼-A区', free_num: data.free ? 2 : 0, total_num: 2 }] } };
  if (route === '/v4/Space/map') return { code: 0, data: { name: 'A区', name_merge: '测试馆-五楼-A区' } };
  if (route === '/v4/Space/seat') return { code: 0, data: { list: [1, 2].map(i => ({
    id: String(i), no: 'XF5A00' + i, status: data.free ? '1' : '6', point_x: i * 10, point_y: 10, width: 6, height: 8
  })) } };
  throw Error('Unexpected mock route: ' + route);
};
