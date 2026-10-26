'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SeatWatch } = require('../seat-watch');
function fixture(t, kind = 'signed') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libseat-watch-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const file = path.join(dir, 'seat-watch.json');
  let now = Date.parse('2026-10-26T10:00:00+08:00');
  const f = { calls:[], available:false, pending:{}, cfg:{ token:'private', verifyOnly:false, dateMode:'today', timeMode:'now', interval:2 },
    target:{ areaId:'59',seatId:'new',seat:'XF5A048',area:'测试馆-A区' },
    current: kind ? { booking:{ id:'old',seatId:'old',areaId:'59',seat:'XF5A001',outcome:'success' }, state:kind, actions:kind==='reserved'?['cancel']:['checkout'] } : null,
    history:[], control:{} };
  const deps = {
    config:()=>f.cfg, unavailable:()=>false,
    inspect:async()=>{ if(f.control.inspect) await f.control.inspect(); return {target:f.target,available:f.available,rule:{reserveType:'1',segment:'whole',start:'10:00',end:'22:00'}}; },
    current:async()=>f.current, adopt:()=>{}, validate:()=>{},
    pending:()=>f.pending, resolved:id=>f.history.find(b=>b.id===id),
    release:async(b,action,guard)=>{
      if(f.control.beforeRelease) f.control.beforeRelease();
      guard(); f.pending.action={action}; f.calls.push(action);
      if(f.control.releaseUnknown) throw Error('network timeout');
      if(f.control.releaseRejected) { delete f.pending.action; throw Error('不允许签离'); }
      f.history.push({...b,outcome:action==='cancel'?'cancelled':'completed'}); f.current=null; delete f.pending.action;
      if(f.control.afterRelease) f.control.afterRelease();
    },
    reserve:async(b,c,cfg,guard)=>{
      if(f.control.beforeReserve) f.control.beforeReserve();
      try { guard(); } catch(e) {e.beforeSubmission=true;throw e;}
      f.pending.booking=b; f.calls.push('reserve:'+b.seatId);
      if(f.control.reserveUnknown) throw Error('network timeout');
      if(f.control.afterReserve) f.control.afterReserve();
      return {code:f.control.reserveCode || 0,message:'目标已被占用'};
    },
    booked:b=>{ f.history.push({...b,outcome:'success'});delete f.pending.booking; },
    rejected:()=>{delete f.pending.booking;}, reconcileBooking:async()=>{}, reconcileRelease:async()=>{}
  };
  f.manager=new SeatWatch(file,deps,()=>now); f.deps=deps; f.file=file;
  f.advance=ms=>now+=ms; f.reload=()=>new SeatWatch(file,deps,()=>now);
  f.start=()=>f.manager.start(f.target); f.tick=async()=>{f.advance(3000);await f.manager.tick();};
  return f;
}
test('only the exact occupied target is watched, retaining the current seat until it becomes available', async t=>{
  const f=fixture(t);await f.start();await f.tick();assert.deepEqual(f.calls,[]);assert.equal(f.manager.job.active,true);
  f.available=true;await f.tick();assert.deepEqual(f.calls,['checkout','reserve:new']);assert.equal(f.manager.job.phase,'finished');
  await f.tick();assert.equal(f.calls.length,2);assert.ok(!fs.readFileSync(f.file,'utf8').includes('private'));
});
for(const kind of [null,'reserved','signed','away']) test('current state '+kind+' selects the correct release action before booking', async t=>{
  const f=fixture(t,kind);f.available=true;await f.start();await Promise.all([f.tick(),f.tick()]);
  assert.deepEqual(f.calls,[...(kind?[kind==='reserved'?'cancel':'checkout']:[]),'reserve:new']);
});
test('already occupying the target never releases or rebooks it',async t=>{
  const f=fixture(t);f.current.booking.seatId='new';await f.start();await f.tick();
  assert.equal(f.manager.job.phase,'finished');assert.deepEqual(f.calls,[]);
});
test('target changes during preflight; the current seat is kept',async t=>{
  const f=fixture(t);f.available=true;await f.start();let reads=0;
  f.control.inspect=()=>{if(++reads===2)f.available=false;};await f.tick();assert.deepEqual(f.calls,[]);assert.equal(f.manager.job.active,true);
});
test('target lost after release keeps watching only the target, without fallback or repeated checkout',async t=>{
  const f=fixture(t);f.available=true;await f.start();f.control.afterRelease=()=>f.available=false;
  await f.tick();assert.deepEqual(f.calls,['checkout']);assert.equal(f.manager.job.active,true);
  f.available=true;await f.tick();assert.deepEqual(f.calls,['checkout','reserve:new']);
});
test('release rejection preserves the old booking; unknown release persists and blocks restarts/resubmission',async t=>{
  const f=fixture(t);f.available=true;f.control.releaseRejected=true;await f.start();await f.tick();
  assert.equal(f.manager.job.phase,'paused');assert.equal(f.current.booking.id,'old');assert.deepEqual(f.calls,['checkout']);
  const g=fixture(t);g.available=true;g.control.releaseUnknown=true;await g.start();await g.tick();
  assert.equal(g.manager.job.phase,'release-unknown');await g.tick();assert.deepEqual(g.calls,['checkout']);
  const restored=g.reload();assert.equal(restored.blocks(),true);await assert.rejects(restored.start(g.target),/核实/);
  await restored.check();assert.equal(restored.job.phase,'release-unknown');
  g.pending={};g.history.push({id:'old',outcome:'completed'});await restored.check();assert.equal(restored.job.phase,'paused');assert.deepEqual(g.calls,['checkout']);
});
test('unknown reservation persists intent; confirmation finishes without sending another reservation',async t=>{
  const f=fixture(t,null);f.available=true;f.control.reserveUnknown=true;await f.start();await f.tick();
  assert.equal(f.manager.job.phase,'booking-unknown');const restored=f.reload();
  await restored.check();assert.equal(restored.job.phase,'booking-unknown');
  f.history.push({...f.pending.booking,outcome:'success'});f.pending={};await restored.check();
  assert.equal(restored.job.phase,'finished');assert.deepEqual(f.calls,['reserve:new']);
});
test('explicit occupied rejection can continue exact-seat watching without double release',async t=>{
  const f=fixture(t);f.available=true;f.control.reserveCode=409;await f.start();await f.tick();
  assert.equal(f.manager.job.phase,'watching');f.control.reserveCode=0;await f.tick();assert.deepEqual(f.calls,['checkout','reserve:new','reserve:new']);
});
for(const stage of ['beforeRelease','afterRelease','beforeReserve','afterReserve']) test('stop at '+stage+' never sends a later unapproved mutation',async t=>{
  const f=fixture(t);f.available=true;await f.start();f.control[stage]=()=>f.manager.stop();await f.tick();
  assert.deepEqual(f.calls,stage==='beforeRelease'?[]:stage==='afterReserve'?['checkout','reserve:new']:['checkout']);
  assert.equal(f.manager.job.active,false);
  if(stage==='afterReserve') assert.equal(f.history.at(-1).outcome,'success');
});
test('restart of a monitoring job is paused; authentication, date and settings changes never release a seat',async t=>{
  for(const change of [f=>f.cfg.token='other',f=>f.advance(86400000),f=>f.cfg.verifyOnly=true]) {
    const f=fixture(t);f.available=true;await f.start();assert.equal(f.reload().job.active,false);
    change(f);await f.tick();assert.deepEqual(f.calls,[]);assert.equal(f.manager.job.active,false);
  }
});
test('no mutation without an atomic journal; corrupt records block start',async t=>{
  const f=fixture(t);f.available=true;await f.start();f.manager.save=()=>{throw Error('disk full');};await assert.rejects(f.tick(),/disk full/);assert.deepEqual(f.calls,[]);
  fs.writeFileSync(f.file,'broken');assert.equal(f.reload().blocks(),true);
});
