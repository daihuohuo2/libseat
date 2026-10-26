'use strict';
const fs = require('node:fs');
const path = require('node:path');
const dir=process.env.LIBSEAT_TEST_DIR, file=path.join(dir,'watch-school.json');
exports.recordAsset='function a(e){return request({url:"/v4/member/seat",data:e})}export{a as g};';
exports.respond=async(route,body)=>{
  const data=JSON.parse(fs.readFileSync(file,'utf8'));
  const live=data.rows.filter(r=>!['4','6'].includes(r.status));
  fs.appendFileSync(path.join(dir,'calls.jsonl'),JSON.stringify({route,body})+'\n');
  const save=()=>fs.writeFileSync(file,JSON.stringify(data));
  if(route==='/v4/member/seat')return {code:0,data:{data:data.rows}};
  if(route==='/v4/index/subscribe')return {code:0,data:live.map(r=>({...r,type:'1',space_id:r.seat_id,flag_out:r.status==='3'?1:0,
    flag_leave:r.status==='32'?1:0,SYS_WEB_MYYUYUE_LEAVE:1,SYS_WEB_MYYUYUE_RIGHTBACK:1}))};
  if(route==='/v4/space/index')return {code:0,data:{premises:[{id:'1',name:'测试馆'}],storey:[{name:'五楼',list:[{id:'5',parentId:'1'}]}]}};
  if(route==='/v4/space/pick')return {code:0,data:{area:[{id:'59',name:'A区',nameMerge:'测试馆-五楼-A区',free_num:1,total_num:3}]}};
  if(route==='/v4/Space/map')return {code:0,data:{type:'1',name:'A区',name_merge:'测试馆-五楼-A区',date:{reserveType:'1',list:[{day:body.day,times:[{id:'segment',status:1,start:'08:00',end:'22:00'}]}]}}};
  if(route==='/v4/Space/seat')return {code:0,data:{list:[['old','XF5A001',live.some(r=>r.seat_id==='old')?'6':'1'],['target','XF5A048',data.available?'1':'6'],['other','XF5A006','1']].map(([id,no,status],i)=>({id,no,status,point_x:10+i*10,point_y:10,width:6,height:8}))}};
  if(['/v4/space/cancel','/v4/space/checkout'].includes(route)){
    const row=live.find(r=>r.id===body.id);if(!row)throw Error('wrong official record');
    if(route.endsWith('/cancel') && row.status!=='9')return {code:201,message:'不能取消已签到预约'};
    if(route.endsWith('/checkout') && !['3','32'].includes(row.status))return {code:201,message:'未签到不能签离'};
    if(data.scenario==='denied')return {code:201,message:'官网拒绝签离'};
    row.status=route.endsWith('/cancel')?'6':'4';row.oksign=0;save();
    if(data.scenario==='release-timeout')throw Error('timeout after releasing');
    return {code:0};
  }
  if(route==='/v4/space/confirm'){
    if(body.seat_id!=='target' || body.segment!=='segment' || body.start_time || body.end_time)throw Error('must book only exact target with official segment');
    if(live.length)return {code:201,message:'尚有预约未释放'};
    if(!data.available)return {code:409,message:'目标已被占用'};
    data.rows.unshift({id:'new-record',seat_id:'target',name:'XF5A048',nameMerge:'测试馆-五楼-A区',area_id:'59',status:'9',status_name:'预约成功',oksign:1,
      beginTime:body.day+' 10:00:00',endTime:body.day+' 22:00:00'});save();
    if(data.scenario==='book-timeout')throw Error('timeout after booking');
    return {code:0};
  }
  throw Error('Unexpected route: '+route);
};
