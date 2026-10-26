'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
exports.fixture=async(t,{kind='3',available=false,scenario='normal'}={})=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'libseat-watch-http-'));
  const listen=net.createServer().listen(0,'127.0.0.1');await once(listen,'listening');const port=listen.address().port;await new Promise(r=>listen.close(r));
  const write=(n,v)=>fs.writeFileSync(path.join(dir,n),JSON.stringify(v));
  fs.writeFileSync(path.join(dir,'now.txt'),'2026-10-26T10:00:00+08:00');
  write('config.json',{token:'mock',autoRefresh:false,verifyOnly:false,interval:2,dateMode:'today',timeMode:'now',areaIds:['59'],preferAreas:['59']});
  write('bookings.json',{version:1,pending:null,pendingAction:null,history:[],claims:[]});
  write('watch-school.json',{available,scenario,rows:kind?[{id:'official-old',seat_id:'old',area_id:'59',name:'XF5A001',nameMerge:'测试馆-五楼-A区',
    status:kind,status_name:kind==='9'?'预约成功':kind==='32'?'暂离':'已签到',oksign:kind==='9'?1:0,beginTime:'2026-10-26 09:00:00',endTime:'2026-10-26 22:00:00'}]:[]});
  const env={...process.env,TZ:'Asia/Shanghai',PORT:String(port),LIBSEAT_TEST_DIR:dir,LIBSEAT_CONFIG_FILE:path.join(dir,'config.json'),
    LIBSEAT_PROFILE_DIR:path.join(dir,'browser'),LIBSEAT_LOG_FILE:path.join(dir,'test.log'),LIBSEAT_MOCK:path.join(__dirname,'mock-watch-api.cjs')};
  const child=spawn(process.execPath,['--require',path.join(__dirname,'refresh-clock.cjs'),path.join(__dirname,'../server.js')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.resume();child.stderr.resume();
  t.after(async()=>{if(child.exitCode===null){const done=once(child,'exit');child.kill();await done;}fs.rmSync(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+port;
  const request=async(route,body)=>(await fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)})).json();
  for(let i=0;i<100;i++){try{await request('/api/status');break;}catch{await sleep(30);}}
  const until=async predicate=>{for(let i=0;i<180;i++){const s=await request('/api/status');if(predicate(s))return s;await sleep(50);}throw Error('timeout '+JSON.stringify(await request('/api/status')));};
  const availableNow=()=>{const file=path.join(dir,'watch-school.json'),d=JSON.parse(fs.readFileSync(file));d.available=true;fs.writeFileSync(file,JSON.stringify(d));fs.writeFileSync(path.join(dir,'now.txt'),'2026-10-26T10:00:03+08:00');};
  const calls=()=>fs.readFileSync(path.join(dir,'calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(c=>/\/(cancel|checkout|confirm)$/.test(c.route));
  return {dir,base,env,request,until,availableNow,calls};
};
