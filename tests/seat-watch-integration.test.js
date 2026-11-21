'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const {fixture}=require('./watch-fixture.cjs');
for(const kind of [null,'9','3','32'])test('HTTP watch adopts official '+kind+' reservation and submits only target',async t=>{
  const f=await fixture(t,{kind});
  assert.equal((await f.request('/api/watch-start',{areaId:'59',seat:'048'})).ok,true);
  const s=await f.until(s=>s.seatWatch.message?.includes('暂不可约'));
  assert.deepEqual(f.calls(),[]);if(kind)assert.equal(s.booking.seat,'XF5A001');
  assert.equal((await f.request('/api/start',{})).ok,false);
  assert.equal((await f.request('/api/renewal/start',{mode:'current',arrivalAt:'2026-10-26T14:00:00+08:00'})).ok,false);
  assert.equal((await f.request('/api/booking-action',{id:s.booking?.id,action:'checkout'})).ok,false);
  f.availableNow();const booked=await f.until(s=>s.seatWatch.phase==='finished');
  assert.equal(booked.booking.seat,'XF5A048');assert.equal(booked.success,true);
  assert.deepEqual(f.calls().map(c=>c.route),[...(kind?[kind==='9'?'/v4/space/cancel':'/v4/space/checkout']:[]),'/v4/space/confirm']);
  assert.equal(f.calls().at(-1).body.seat_id,'target');
});
for(const scenario of ['denied','release-timeout','book-timeout'])test('HTTP watch '+scenario+' persists uncertainty and never duplicates release',async t=>{
  const f=await fixture(t,{scenario,available:true});await f.request('/api/watch-start',{areaId:'59',seatId:'target'});
  const s=await f.until(s=>!s.seatWatch.active && !s.seatWatch.busy);
  if(scenario==='denied'){assert.equal(s.success,true);assert.equal(s.seatWatch.phase,'paused');assert.equal(f.calls().length,1);return;}
  assert.equal((await f.request('/api/start',{})).ok,false);
  assert.equal((await f.request('/api/watch-start',{areaId:'59',seatId:'target'})).ok,false);
  assert.equal(s.seatWatch.phase,scenario==='release-timeout'?'release-unknown':'booking-unknown');
  await f.request('/api/watch-check',{});const resolved=await f.request('/api/status');
  assert.equal(resolved.seatWatch.phase,scenario==='release-timeout'?'paused':'finished');
  assert.equal(resolved.success,scenario==='book-timeout');assert.equal(f.calls().length,scenario==='release-timeout'?1:2);
});
test('HTTP watch stop retains current seat and prevents future release',async t=>{
  const f=await fixture(t);await f.request('/api/watch-start',{areaId:'59',seatId:'target'});
  await f.until(s=>s.seatWatch.message?.includes('暂不可约'));await f.request('/api/stop',{});f.availableNow();
  const s=await f.request('/api/status');assert.equal(s.seatWatch.active,false);assert.equal(s.success,true);assert.deepEqual(f.calls(),[]);
});
test('real desktop UI picks exact occupied seat and switches only when target becomes free', {timeout:30000},async t=>{
  const f=await fixture(t),electron=path.join(__dirname,'../desktop/node_modules/electron/dist/electron.exe');
  if(!fs.existsSync(electron)){t.skip('Electron not installed');return;}
  const env={...f.env,LIBSEAT_TEST_URL:f.base};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[path.join(__dirname,'seat-watch-ui.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  const timer=setTimeout(()=>child.kill(),25000),[code]=await once(child,'exit');clearTimeout(timer);
  assert.equal(code,0,output);assert.deepEqual(f.calls().map(c=>c.route),['/v4/space/checkout','/v4/space/confirm']);
});

for (const kind of [null,'9','32']) test('list swap requires a signed source: '+kind, async t => {
  const f = await fixture(t,{kind});
  assert.equal((await f.request('/api/watch-start',{mode:'signed-list'})).ok,false);
  assert.deepEqual(f.calls(),[]);
});
for (const scenario of ['swap-success','swap-after-checkout','swap-conflict','swap-both-lost','book-timeout']) test('signed list swap: '+scenario, async t => {
  const f = await fixture(t,{scenario, available:scenario==='book-timeout'});
  assert.equal((await f.request('/api/watch-start',{mode:'signed-list'})).ok,true);
  if (scenario!=='book-timeout') {
    await f.until(s=>s.seatWatch.message?.includes('名单内暂无'));
    assert.deepEqual(f.calls(),[]); f.availableNow();
  }
  const final=await f.until(s=>!s.seatWatch.active && !s.seatWatch.busy);
  const writes=f.calls().map(c=>c.route.endsWith('checkout')?'checkout':c.body.seat_id);
  if (scenario==='book-timeout') {
    assert.equal(final.seatWatch.phase,'booking-unknown');
    assert.equal(writes.length,2); return;
  }
  if (scenario==='swap-both-lost') {
    assert.deepEqual(writes,['checkout','target','old']);
    assert.equal(final.seatWatch.phase,'paused');
    assert.equal(final.success,false); assert.match(final.seatWatch.message,/原座补约未成功/); return;
  }
  const restored=scenario!=='swap-success';
  assert.deepEqual(writes,scenario==='swap-after-checkout'?['checkout','old']:restored?['checkout','target','old']:['checkout','target']);
  assert.equal(final.booking.seat,restored?'XF5A001':'XF5A048');
  assert.equal(final.seatWatch.phase,'finished');
});
