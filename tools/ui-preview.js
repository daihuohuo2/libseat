'use strict';
// Isolated design preview: state is in memory, no credentials or real bookings.
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', 'public');
const areas = [
  { id: '59', short: 'A区', name: '潇湘校区馆-五楼-A区', total: 200, free: 10, seatFree: 10, isTarget: true },
  { id: '60', short: 'B区', name: '潇湘校区馆-五楼-B区', total: 160, free: 6, seatFree: 6, isTarget: true }
];
let cfg = { designPreview: true, tokenExp: Math.floor(Date.now()/1000) + 7200, dateMode: 'today', timeMode: 'now', interval: 6, startTime: '08:00', endTime: '12:00', verifyOnly: true, autoRefresh: true, areaIds: ['59','60'], preferAreas: ['59','60'], areaNames: Object.fromEntries(areas.map(a => [a.id, a.name])), seatPlans: [], activePlanId: '' };
let running = false;
let logs = [{ level: 'info', msg: '设计预览已就绪。所有座位和预约结果均为模拟数据。' }];
const date = () => new Date().toLocaleDateString('en-CA');
const log = msg => logs.push({ level: 'info', msg });
function result(route, body) {
  if (route === '/api/config') { Object.assign(cfg, body || {}); return { ok: true, config: cfg }; }
  if (route === '/api/tree') return { ok: true, current: { premiseId: '1', storeyId: '5' }, tree: [{id:'1',name:'潇湘校区馆',storeys:[{id:'5',name:'五楼'}]}] };
  if (route === '/api/areas-of-storey') return { ok: true, areas };
  if (route === '/api/seats') {
    const area = areas.find(a => a.id === body.areaId) || areas[0];
    const seats = Array.from({length:area.total}, (_,i) => {
      const block = Math.floor(i/50), local = i%50;
      const available = new Set([7,12,23,35,62,75,101,123,152,194].slice(0,area.free));
      const status = available.has(i) ? '1' : i%27===2 ? '2' : i%13===5 ? '7' : '6';
      return { no: 'XF5' + (area.id==='59'?'A':'B') + String(i+1).padStart(3,'0'),status,statusName:({'1':'空闲','2':'已预约','6':'使用中','7':'临时离开'})[status],x:3+(block%2)*51+(local%10)*4.4,y:5+Math.floor(block/2)*50+Math.floor(local/10)*8,w:3.8,h:6.6 };
    });
    return { ok:true, area, areas, seats, view:{x:0,y:0,w:100,h:100},planeSize:{w:1000,h:550},syncedAt:new Date().toLocaleTimeString('zh-CN',{hour12:false}) };
  }
  if (route === '/api/areas' || route === '/api/verify') return { ok:true,areas,date:date(),mode:cfg.timeMode,window:{start:'14:00',end:'18:00'},bookWindow:{start:'14:00',end:'18:00'} };
  if (route === '/api/status') return { running,success:false,logs };
  if (route === '/api/bookings') return {ok:true,history:[]};
  if (route === '/api/login-status') return { active:false,tokenOk:true };
  if (route === '/api/auto-login') return {ok:true};
  if (route === '/api/start') { Object.assign(cfg,body); running=true; log(cfg.verifyOnly ? '开始观察空位（预览模式）' : '开始模拟抢座；预览不会提交真实预约。'); return {ok:true}; }
  if (route === '/api/stop') { running=false; log('已停止'); return {ok:true}; }
  if (route === '/api/plan-activate') {
    const plan = cfg.seatPlans.find(p => p.id === body.id);
    if(!plan) return {ok:false,message:'方案不存在'};
    cfg.activePlanId=plan.id;cfg.preferAreas=plan.areas;cfg.dateMode=plan.dateMode;cfg.interval=plan.interval;
    return {ok:true,config:cfg};
  }
  if (route === '/api/plan-delete') {cfg.seatPlans=cfg.seatPlans.filter(p=>p.id!==body.id);cfg.activePlanId='';return {ok:true,config:cfg};}
  return {ok:false,message:'预览未实现此操作'};
}
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.ico':'image/x-icon','.webmanifest':'application/manifest+json'};
http.createServer(async (req,res)=>{
  const route=new URL(req.url,'http://localhost').pathname;
  res.setHeader('Cache-Control','no-store');
  if(route.startsWith('/api/')) {
    let raw='';for await(const chunk of req) raw+=chunk;
    try {res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result(route,raw?JSON.parse(raw):{})));}
    catch(e){res.writeHead(400);res.end(JSON.stringify({ok:false,message:e.message}));}return;
  }
  let name=(route==='/' || route==='/desktop-preview.html')?'index.html':route.slice(1);
  if(name.includes('/')||name.includes('\\')||name.includes('..')) {res.writeHead(403);res.end();return;}
  fs.readFile(path.join(root,name),(err,data)=>{
    if(err){res.writeHead(404);res.end();return;}
    if(route==='/desktop-preview.html') data=Buffer.from(data.toString('utf8').replace('<head>','<head><script>window.seatAssistant={desktopUI:true,customTitlebar:true};</script>'));
    res.setHeader('Content-Type',mime[path.extname(name)]||'application/octet-stream');res.end(data);
  });
}).listen(8850,'127.0.0.1',()=>console.log('Design preview: http://127.0.0.1:8850'));
