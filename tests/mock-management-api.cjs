'use strict';
const fs = require('node:fs');
const path = require('node:path');
exports.recordAsset = 'function a(e){return request({url:"/v4/member/seat",data:e})}export{a as g};';
exports.respond = async (route, body) => {
  const file = path.join(process.env.LIBSEAT_TEST_DIR, 'management-row.json');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.appendFileSync(path.join(process.env.LIBSEAT_TEST_DIR, 'calls.jsonl'), JSON.stringify({ route, body }) + '\n');
  if (route === '/v4/member/seat') return { code: 0, data: { data: [record] } };
  if (route === '/v4/index/subscribe') return { code: 0, data: ['4', '6'].includes(record.status) ? [] : [{ ...record,
    type: '1', flag_out: record.status === '3' ? 1 : 0, flag_leave: record.status === '11' ? 1 : 0,
    SYS_WEB_MYYUYUE_LEAVE: 1, SYS_WEB_MYYUYUE_RIGHTBACK: 1 }] };
  if (['/v4/space/cancel', '/v4/space/leave', '/v4/space/checkout'].includes(route)) {
    if (body.id !== record.id) return { code: 201, message: '记录编号不匹配' };
    if (process.env.LIBSEAT_MANAGEMENT_SCENARIO === 'rejected') return { code: 201, message: '官网拒绝：不在允许签离范围' };
    if (process.env.LIBSEAT_MANAGEMENT_SCENARIO === 'timeout') throw Error('timeout');
    const status = { '/v4/space/cancel': '6', '/v4/space/leave': '11', '/v4/space/checkout': '4' }[route];
    record.status = status; record.oksign = 0; record.status_name = { '6': '用户取消', '11': '临时离开', '4': '已结束' }[status];
    if (status === '4') record.endTime = '2026-10-10 17:25:00';
    fs.writeFileSync(file, JSON.stringify(record));
    return { code: 0, message: '操作成功' };
  }
  return { code: 0, data: {} };
};
