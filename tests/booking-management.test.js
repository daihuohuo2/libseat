'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BookingStore } = require('../booking-store');
const { BookingManagement, findBooking, describe } = require('../booking-management');
const booking = { id: 'local-1', seatId: '9213', seat: 'XF5A048', area: '潇湘校区馆-五楼-A区', date: '2026-10-10', startTime: '16:17', endTime: '22:00', outcome: 'success' };
const record = { id: 'official-42', name: booking.seat, space: booking.seatId, nameMerge: booking.area,
  beginTime: '2026-10-10 16:17:38', endTime: '2026-10-10 22:00:00', status: '9', status_name: '预约成功', oksign: 1 };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libseat-management-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new BookingStore(path.join(dir, 'bookings.json')); store.finish(booking, 'success');
  const f = { booking: { ...booking }, record: { ...record }, calls: [], token: 'mock', blocked: false,
    flags: { id: record.id, type: '1', flag_out: 0, flag_leave: 0, SYS_WEB_MYYUYUE_RIGHTBACK: 1, SYS_WEB_MYYUYUE_LEAVE: 1 } };
  f.deps = { booking: () => f.booking, token: () => f.token, update: b => f.booking = b, unavailable: () => f.blocked,
    stopRenewal: () => { f.stopped = true; }, records: async () => [f.record], current: async () => [f.flags],
    send: async (a, body, before) => { before(); f.calls.push({ a, body }); return { code: 0 }; } };
  f.store = store; f.manager = new BookingManagement(store, f.deps);
  f.sign = () => { Object.assign(f.record, { status: '3', status_name: '已签到', oksign: 0 }); f.flags.flag_out = 1; };
  return f;
}
test('identity: seconds accepted, end changes retain official ID, ambiguous and unrelated rows rejected', () => {
  assert.equal(findBooking([record], booking), record);
  assert.equal(findBooking([{ ...record, endTime: '2026-10-10 18:25:00' }], { ...booking, officialId: record.id }).id, record.id);
  assert.equal(findBooking([record, { ...record, id: 'other' }], booking), null);
  assert.equal(findBooking([{ ...record, beginTime: '2026-10-10 15:17:38' }], booking), null);
});

test('relogin discards an old account response and a forced refresh waits then queries the current session', async t => {
  const f = fixture(t);
  let release, reads = 0;
  f.deps.records = async () => {
    reads++;
    if (reads === 1) return new Promise(resolve => { release = () => resolve([{ ...record, status: '6' }]); });
    return [record];
  };
  const old = f.manager.refresh();
  f.token = 'new-session';
  const fresh = f.manager.refresh(true);
  release(); await old;
  assert.equal(f.booking.outcome, 'success', 'old terminal response cannot cancel the current view');
  await fresh;
  assert.equal(reads, 2); assert.equal(f.manager.status().state, 'reserved');
});
test('official availability flags gate temporary and full checkout', () => {
  assert.deepEqual(describe({ ...record, status: '3' }, { flag_out: 1, SYS_WEB_MYYUYUE_RIGHTBACK: 0, SYS_WEB_MYYUYUE_LEAVE: 1 }).actions, ['checkout']);
  assert.deepEqual(describe({ ...record, status: '3' }, null).actions, []);
  assert.deepEqual(describe({ ...record, status: '3' }, { flag_leave: 1, SYS_WEB_MYYUYUE_RIGHTBACK: 1, SYS_WEB_MYYUYUE_LEAVE: 1 }).actions, ['checkout']);
});

test('same-minute rebooking ignores cancelled history and acts only on the unique live record', async t => {
  const f=fixture(t), replacement={...record,id:'official-replacement'};
  const old={...record,status:'6',status_name:'已取消'};
  f.flags.id=replacement.id;
  f.deps.records=async()=>[old,replacement];
  await f.manager.refresh(true);
  assert.equal(f.booking.officialId,replacement.id);
  assert.equal(f.manager.status().state,'reserved');
  await f.manager.act({id:booking.id,action:'cancel'});
  assert.deepEqual(f.calls,[{a:'cancel',body:{id:replacement.id}}]);
  assert.equal(findBooking([old,replacement,{...replacement,id:'ambiguous'}],booking),null);
  assert.equal(findBooking([old,{...old,id:'another-ended'}],booking),null);
});
test('cancel sends official record ID once, stops renewal, persists released status', async t => {
  const f = fixture(t); await f.manager.act({ id: booking.id, action: 'cancel' });
  assert.deepEqual(f.calls, [{ a: 'cancel', body: { id: record.id } }]); assert.equal(f.stopped, true);
  assert.equal(f.booking.outcome, 'cancelled'); assert.equal(f.store.data.pendingAction, null);
  await assert.rejects(f.manager.act({ id: booking.id, action: 'cancel' }), /已变化/);
});
test('signed transition replaces cancel with leave and checkout; temporary leave keeps booking', async t => {
  const f = fixture(t); f.sign(); await f.manager.refresh(true);
  assert.equal(f.manager.status().state, 'signed'); assert.deepEqual(f.manager.status().actions, ['leave', 'checkout']);
  await f.manager.act({ id: booking.id, action: 'leave' });
  assert.equal(f.booking.remoteState, 'away'); assert.equal(f.booking.outcome, 'success');
  assert.deepEqual(f.calls[0], { a: 'leave', body: { id: record.id, points: {} } });
  f.flags.flag_leave = 1; f.flags.flag_out = 0;
  await f.manager.act({ id: booking.id, action: 'checkout' });
  assert.equal(f.booking.remoteState, 'completed'); assert.equal(f.booking.outcome, 'completed');
  assert.deepEqual(f.calls.map(c => c.a), ['leave', 'checkout']);
});
test('signed between display and click rejects cancellation without submitting', async t => {
  const f = fixture(t); await f.manager.refresh(true); f.sign();
  await assert.rejects(f.manager.act({ id: booking.id, action: 'cancel' }), /不允许取消/);
  assert.equal(f.calls.length, 0); assert.equal(f.manager.status().state, 'signed');
});
test('official rejection preserves booking and exposes reason', async t => {
  const f = fixture(t); f.sign(); f.deps.send = async (a, body, before) => { before(); return { code: 201, message: '不在允许签离范围' }; };
  await assert.rejects(f.manager.act({ id: booking.id, action: 'checkout' }), /不在允许/);
  assert.equal(f.store.data.pendingAction, null); assert.equal(f.booking.outcome, 'success');
});
test('unknown action survives restart, blocks resubmission, resolves only with official evidence', async t => {
  const f = fixture(t); f.deps.send = async (a, body, before) => { before(); f.calls.push(a); throw Error('timeout'); };
  await assert.rejects(f.manager.act({ id: booking.id, action: 'cancel' }), /待确认/);
  const store = new BookingStore(f.store.file); const restored = new BookingManagement(store, f.deps);
  assert.equal(restored.blocked(), true); await restored.refresh(true); assert.equal(restored.blocked(), true);
  await assert.rejects(restored.act({ id: booking.id, action: 'cancel' }), /待核实/);
  f.record.status = '6'; f.record.status_name = '用户取消'; await restored.refresh(true);
  assert.equal(restored.blocked(), false); assert.equal(f.booking.outcome, 'cancelled'); assert.equal(f.calls.length, 1);
});
test('concurrent clicks submit once; account changes before queued send prevent submission', async t => {
  const f = fixture(t); let finish; f.deps.send = async (a, body, before) => { before(); return new Promise(r => finish = r); };
  const first = f.manager.act({ id: booking.id, action: 'cancel' });
  await assert.rejects(f.manager.act({ id: booking.id, action: 'cancel' }), /进行中/);
  while (!finish) await new Promise(r => setImmediate(r)); finish({ code: 0 }); await first;
  const other = fixture(t); other.deps.send = async (a, body, before) => { other.token = 'changed'; before(); throw Error('must not send'); };
  await assert.rejects(other.manager.act({ id: booking.id, action: 'cancel' }), /登录状态已变化/);
  assert.equal(other.store.data.pendingAction, null);
});
test('failure to persist journal prevents an irreversible request', async t => {
  const f = fixture(t); const write = f.store.write.bind(f.store);
  f.store.write = next => { if (next.pendingAction) throw Error('disk full'); return write(next); };
  await assert.rejects(f.manager.act({ id: booking.id, action: 'cancel' }), /disk full/); assert.equal(f.calls.length, 0);
});
