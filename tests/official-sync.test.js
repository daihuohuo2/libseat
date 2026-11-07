'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture}=require('./watch-fixture.cjs');
for(const [kind,expected] of [['9','reserved'],['3','signed'],['32','away']])test('login refresh imports an official-only '+expected+' booking without a success notification',async t=>{
  const f=await fixture(t,{kind});assert.equal((await f.request('/api/status')).success,false);
  assert.equal((await f.request('/api/booking-state',{})).ok,true);
  const s=await f.request('/api/status');assert.equal(s.success,true);assert.equal(s.booking.seat,'XF5A001');
  assert.equal(s.bookingManagement.state,expected);assert.equal(s.booking.reserveType,'1');assert.equal(s.booking.segment,'segment');
  assert.ok(Number.isFinite(Date.parse(s.booking.bookedAt)));
  assert.equal((await f.request('/api/notification-claim',{id:s.booking.id,channel:'page'})).claimed,false);
  assert.deepEqual(f.calls(),[]);
});
test('an optional map read failure does not hide the verified official reservation',async t=>{
  const f=await fixture(t,{kind:'9',scenario:'map-abort'});
  assert.equal((await f.request('/api/booking-state',{})).ok,true);
  const s=await f.request('/api/status');assert.equal(s.booking.seat,'XF5A001');
  assert.equal(s.bookingManagement.state,'reserved');assert.deepEqual(f.calls(),[]);
});
test('an imported official reservation can be managed by renewal using its original time and segment',async t=>{
  const f=await fixture(t,{kind:'9'}),file=path.join(f.dir,'watch-school.json');const data=JSON.parse(fs.readFileSync(file));
  data.rows[0].beginTime='2026-10-26 09:50:00';fs.writeFileSync(file,JSON.stringify(data));
  await f.request('/api/booking-state',{});
  const r=await f.request('/api/renewal/start',{mode:'current',arrivalAt:'2026-10-26T12:00:00+08:00',intervalMinutes:30});
  assert.equal(r.ok,true,r.message);assert.equal(r.renewal.booking.reserveType,'1');
  assert.equal(r.renewal.nextAt,Date.parse('2026-10-26T10:20:00+08:00'));assert.deepEqual(f.calls(),[]);
});
test('fresh empty official state clears the banner and map identity without discarding history',async t=>{
  const f=await fixture(t);await f.request('/api/booking-state',{});
  const file=path.join(f.dir,'watch-school.json'),data=JSON.parse(fs.readFileSync(file));data.rows=[];fs.writeFileSync(file,JSON.stringify(data));
  await f.request('/api/booking-state',{});const s=await f.request('/api/status');assert.equal(s.success,false);assert.equal(s.booking,null);
  assert.equal((await f.request('/api/bookings')).history.length,1);assert.deepEqual(f.calls(),[]);
});
