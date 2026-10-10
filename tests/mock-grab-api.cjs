'use strict';
const fs = require('node:fs');
const path = require('node:path');
const scenario = process.env.LIBSEAT_GRAB_SCENARIO;
exports.recordAsset = 'function a(e){return request({url:"/v4/member/seat",data:e})}export{a as g};';
exports.respond = async (route, body) => {
  fs.appendFileSync(path.join(process.env.LIBSEAT_TEST_DIR, 'calls.jsonl'), JSON.stringify({ route, body }) + '\n');
  if (route === '/v4/space/pick') {
    const area = [{ id: '59', name: '五楼A区', free_num: scenario === 'fallback' || scenario === 'bad-area' ? 1 : 0, total_num: 1 },
      { id: '57', name: '五楼B区', free_num: 0, total_num: 1 },
      { id: '51', name: '四楼D区', free_num: 1, total_num: 1 },
      { id: '55', name: '未选择的C区', free_num: 99, total_num: 99 }];
    return { code: 0, data: { area: body.storeyIds.length || body.premisesIds.length ? area.filter(a => a.id !== '51') : area } };
  }
  if (route === '/v4/Space/map') {
    if (scenario === 'bad-area' && body.id === '51') throw Error('测试区域查询失败');
    return { code: 0, data: { type: '1', date: { reserveType: '1', list: [{ day: '2026-10-10', times: [{ id: 'segment-' + body.id, status: 1, start: '16:02', end: '22:00' }] }] } } };
  }
  if (route === '/v4/Space/seat') {
    if (scenario === 'preferences-change') await new Promise(r => setTimeout(r, 350));
    const list = scenario.startsWith('preferences')
      ? Array.from({ length: 6 }, (_, i) => ({ id: 'seat-' + body.id + '-' + (i + 1), no: 'AREA' + body.id + String(i + 1).padStart(3, '0'), status: scenario === 'preferences-occupied' && i < 4 ? '6' : '1' }))
      : [{ id: 'seat-' + body.id, no: 'TEST' + body.id, status: '1' }];
    return { code: 0, data: { list } };
  }
  if (route === '/v4/space/confirm') {
    if (scenario === 'timeout') throw Error('response timeout after submission');
    if (scenario === 'time-error' || body.segment !== 'segment-' + body.seat_id.split('-')[1] || body.start_time || body.end_time) return { code: 201, message: '未选择或申请时间错误' };
    if (scenario === 'preferences-race' && Number(body.seat_id.split('-')[2]) <= 4) return { code: 409, message: '座位刚被他人预约' };
    if (scenario === 'fallback' && body.seat_id === 'seat-51') return { code: 409, message: '座位已被他人预约' };
    return { code: 0, message: '预约成功' };
  }
  if (route === '/v4/member/seat') return { code: 0, data: { data: [] } };
  return { code: 0, data: {} };
};
