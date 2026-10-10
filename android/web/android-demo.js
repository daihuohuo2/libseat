'use strict';
// Isolated local school simulator: no real network or account data.
const fs = require('fs');
const file = '/data/demo-records.json';
let rows = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
const save = () => fs.writeFileSync(file, JSON.stringify(rows));
const areas = [{ id: '59', name: 'A区' }, { id: '57', name: 'B区' }];
const active = () => rows.find(r => ['9','3','32'].includes(r.status));
const chinaTime = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(11,16);
function seats(id) {
  return Array.from({ length: 48 }, (_, i) => {
    const no = 'XF5' + (id === '57' ? 'B' : 'A') + String(i + 1).padStart(3, '0');
    const own = active();
    const status = own?.name === no ? ({'9':'2','3':'6','32':'7'}[own.status]) : i % 5 === 0 || i % 7 === 0 ? '1' : '6';
    return { id: 'demo-' + no, no, name: no, status,
      point_x: 5 + (i % 8) * 11.5, point_y: 6 + Math.floor(i / 8) * 15, width: 6, height: 8 };
  });
}
module.exports = {
  recordAsset: 'function a(e){return request({url:"/v4/member/seat",data:e})}export{a as g};',
  signIn() {
    const row = active();
    if (!row) return { ok:false, message:'请先完成一次演示预约' };
    row.status='3'; row.status_name='已签到'; row.oksign=0; save(); return {ok:true};
  },
  respond(path, body) {
    if (path === '/v4/space/index') return { code: 0, data: { premises: [{ id: '1', name: '演示馆' }], storey: [{ name: '五楼', list: [{ id: '5', parentId: '1' }] }] } };
    if (path === '/v4/space/pick') return { code: 0, data: { area: areas.map(a => ({ ...a, nameMerge: '演示馆-五楼-' + a.name, total_num: 48, free_num: seats(a.id).filter(s => s.status === '1').length })) } };
    if (path === '/v4/Space/seat') return { code: 0, data: { list: seats(String(body.id)) } };
    if (path === '/v4/Space/map') return { code: 0, data: { name: body.id === '57' ? 'B区' : 'A区', name_merge: '演示馆-五楼-' + (body.id === '57' ? 'B区' : 'A区'), web_plane: '', brother_area: areas,
      type: '1', date: { reserveType: '1', list: [{ day: body.day, times: [{ id: 'demo-segment', status: 1, start: '08:00', end: '22:00' }] }] } } };
    if (path === '/v4/member/seat') return {code:0, data:{data:rows}};
    if (path === '/v4/index/subscribe') return {code:0, data:rows.filter(r => ['9','3','32'].includes(r.status)).map(r => ({...r,type:'1',space_id:r.seat_id,
      flag_out:r.status==='3'?1:0,flag_leave:r.status==='32'?1:0,SYS_WEB_MYYUYUE_RIGHTBACK:1,SYS_WEB_MYYUYUE_LEAVE:1}))};
    if (path === '/v4/space/confirm') {
      if (active()) return {code:1,message:'已有演示预约，请先取消或完全签离'};
      const name=body.seat_id.replace(/^demo-/, '');
      rows.unshift({id:'demo-record-'+require('crypto').randomUUID(),seat_id:body.seat_id,name,nameMerge:'演示馆-五楼-'+(name.includes('B')?'B区':'A区'),
        area_id:name.includes('B')?'57':'59',status:'9',status_name:'预约成功',oksign:1,
        beginTime:body.day+' '+(body.segment?chinaTime():body.start_time)+':00',endTime:body.day+' '+(body.segment?'22:00':body.end_time)+':00'});
      rows=rows.slice(0,50); save(); return {code:0,message:'演示预约成功（未提交学校）'};
    }
    if (['/v4/space/cancel','/v4/space/leave','/v4/space/checkout'].includes(path)) {
      const row=rows.find(r=>r.id===body.id);
      if (!row || (path.endsWith('/cancel') ? row.status!=='9' : !['3','32'].includes(row.status))) return {code:1,message:'演示预约状态不允许此操作'};
      const state=path.endsWith('/cancel')?['6','已取消']:path.endsWith('/leave')?['32','暂离']:['4','已结束'];
      row.status=state[0];row.status_name=state[1];row.oksign=0;save();return {code:0};
    }
    return { code: -1, message: '演示模式不支持此操作' };
  }
};
