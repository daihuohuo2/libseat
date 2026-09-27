/**
 * 测试替身：模拟官方接口，用于验证"等待心仪座位 → 空出来就自动抢"的完整流程
 * 场景：
 *   阶段 1（前 N 次查询）：XF5A001 空闲（非心仪），XF5A002 使用中（心仪）→ 程序应"不抢、继续等"
 *   阶段 2：XF5A002 变为空闲 → 程序应立刻抢 XF5A002
 * 通过环境变量控制：
 *   LIBSEAT_MOCK_LOG   记录所有收到的请求（JSONL），供测试断言
 *   LIBSEAT_MOCK_PASS  前多少次座位查询算作阶段 1（默认 2）
 */
'use strict';
const fs = require('fs');

const LOG = process.env.LIBSEAT_MOCK_LOG;
const PASS = Number(process.env.LIBSEAT_MOCK_PASS || 2);
const STATIC = !!process.env.LIBSEAT_MOCK_STATIC;   // 恒定场景：XF5A001 一直空闲，其余占用

let seatQueries = 0;

function record(entry) {
  if (!LOG) return;
  try { fs.appendFileSync(LOG, JSON.stringify(entry) + '\n', 'utf8'); } catch (e) { }
}

const seat = (no, status, statusName) => ({
  id: 'id-' + no, no: no, name: no, area: '59', status: String(status),
  status_name: statusName, point_x: '10', point_y: '20', width: '2', height: '4'
});

function respond(pathname, body) {
  record({ path: pathname, body: body, at: Date.now(), phase: seatQueries });

  if (pathname === '/v4/space/pick') {
    const free = STATIC ? 1 : (seatQueries < PASS ? 1 : 2);
    return {
      code: 0, message: '操作成功',
      data: {
        area: [
          { id: '59', name: 'A区', nameMerge: '测试楼-五楼A区', free_num: free, total_num: 3 },
          { id: '88', name: 'Z区', nameMerge: '测试楼-二楼Z区', free_num: 1, total_num: 2 }
        ]
      }
    };
  }

  if (pathname === '/v4/Space/seat' && String(body.id) === '88') {
    seatQueries++;
    return {
      code: 0, message: '操作成功',
      data: { total_num: 2, free_num: 1, list: [seat('XF2Z001', 1, '空闲'), seat('XF2Z002', 6, '使用中')] }
    };
  }

  if (pathname === '/v4/Space/seat') {
    seatQueries++;
    const phase2 = STATIC ? false : seatQueries > PASS;
    return {
      code: 0, message: '操作成功',
      data: {
        total_num: 3, free_num: phase2 ? 2 : 1,
        list: [
          seat('XF5A001', 1, '空闲'),
          seat('XF5A002', phase2 ? 1 : 6, phase2 ? '空闲' : '使用中'),
          seat('XF5A003', 6, '使用中')
        ]
      }
    };
  }

  if (pathname === '/v4/Space/map') {
    return { code: 0, message: '操作成功', data: { name_merge: '潇湘校区馆-五楼-A区', web_plane: '' } };
  }

  if (pathname === '/v4/space/confirm') {
    const seatId = body && body.seat_id;
    record({ path: 'CONFIRM', seat_id: seatId, raw: body, phase: seatQueries, at: Date.now() });
    return { code: 0, message: '预约成功' };
  }

  return { code: 0, message: 'mock 未实现', data: {} };
}

module.exports = { respond, getSeatQueries: () => seatQueries };
