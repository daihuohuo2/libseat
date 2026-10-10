'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Renewal } = require('../renewal');

const initial = Date.parse('2026-10-10T08:00:00+08:00');
const minutes = n => n * 60000;
const arrivalAt = '2026-10-10T14:00:00+08:00';
function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libseat-renewal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'renewal.json');
  let now = initial, pending = null, sequence = 1;
  let booking = { id: 'b1', seat: 'XF5A149', seatId: '149', area: '五楼A区', date: '2026-10-10',
    startTime: '08:00', endTime: '12:00', bookedAt: new Date(now).toISOString(), ...overrides };
  const makeRecord = b => ({ id: 'official-' + sequence, seat_id: b.seatId, status: '2', status_name: '待签到', oksign: 1,
    beginTime: b.date + ' ' + b.startTime + ':00', endTime: b.date + ' ' + b.endTime + ':00' });
  let rows = [makeRecord(booking)];
  const calls = [], control = {};
  const deps = {
    config: () => ({ verifyOnly: false, axisStart: '08:00', axisEnd: '22:00', axisStep: 15, axisMaxMin: 240, token: 'secret' }),
    booking: () => booking, unavailable: () => !!pending,
    records: async () => { if (control.recordsError) throw Error('离线'); return rows; },
    cancel: async (id, before) => {
      if (control.beforeCancel) control.beforeCancel();
      try { before(); } catch (e) { e.beforeSubmission = true; throw e; }
      calls.push(['cancel', id]);
      if (control.cancelError) throw Error('取消超时');
      if (control.cancelCode) return { code: control.cancelCode, message: '不允许取消' };
      rows.find(r => r.id === id).status_name = '已取消';
      if (control.afterCancel) control.afterCancel();
      return { code: 0 };
    },
    reserve: async (b, before) => {
      if (control.beforeReserve) control.beforeReserve();
      try { before(); } catch (e) { e.beforeSubmission = true; throw e; }
      pending = b; calls.push(['book', b]);
      if (control.reserveError) throw Error('重约超时');
      if (control.reserveCode) return { code: control.reserveCode, message: '座位已被预约' };
      sequence++; rows.unshift(makeRecord(b));
      if (control.afterReserve) control.afterReserve();
      return { code: 0 };
    },
    booked: b => { booking = b; pending = null; }, cancelled: () => { booking = null; },
    cancelUnknown: () => { booking = null; }, restore: b => { booking = b; },
    rejected: () => { pending = null; }, reconcile: async () => {},
    stopSearch: () => calls.push(['stop-search'])
  };
  const manager = new Renewal(file, deps, () => now);
  return { manager, deps, control, calls, file, rows,
    setTime: value => { now = value; }, advance: value => { now += minutes(value); },
    reload: () => new Renewal(file, deps, () => now),
    get booking() { return booking; }, set booking(b) { booking = b; },
    get pending() { return pending; }
  };
}
test('8:00 through 14:00: seven single cancellations/rebookings, same seat, preserve final booking', async t => {
  const f = fixture(t), m = f.manager;
  await m.start({ arrivalAt, mode: 'current' });
  await m.tick(); assert.equal(f.calls.length, 0);
  for (let i = 0; i < 7; i++) {
    f.advance(50); await Promise.all([m.tick(), m.tick()]);
    assert.equal(m.job.cycles, i + 1);
    assert.equal(m.job.active, true);
    assert.equal(f.booking.seat, 'XF5A149');
    assert.equal(m.job.nextAt, Date.parse(f.booking.bookedAt) + minutes(50));
  }
  assert.equal(f.calls.filter(c => c[0] === 'cancel').length, 7);
  assert.equal(f.calls.filter(c => c[0] === 'book').length, 7);
  assert.equal(f.booking.startTime, '14:00');
  assert.equal(f.booking.endTime, '18:00');
  f.advance(10); await m.tick();
  assert.equal(m.job.phase, 'finished'); assert.ok(f.booking); assert.equal(f.calls.length, 14);
  assert.equal(fs.readFileSync(f.file, 'utf8').includes('secret'), false);
});
test('arming ignores a previous success, then adopts a new successful booking', async t => {
  const f = fixture(t), m = f.manager;
  await m.start({ arrivalAt, mode: 'next' });
  await m.tick(); assert.equal(m.job.phase, 'armed');
  f.booking = { ...f.booking, id: 'new-success' };
  await m.tick(); assert.equal(m.job.phase, 'waiting'); assert.equal(f.calls.length, 0);
});

for (const interval of [30, 37, 50, 58, 59]) test('selected ' + interval + '-minute interval survives restart and repeats from actual booking time', async t => {
  const f = fixture(t, { reserveType:'1', segment:'slot', endTime:'22:00' });
  f.deps.prepare = async (b, window) => ({ ...window, reserveType:'1', segment:'slot' });
  await f.manager.start({ arrivalAt, mode:'current', intervalMinutes:interval });
  let m = f.reload(); assert.equal(m.job.intervalMinutes, interval);
  for (let cycle = 1; cycle <= 2; cycle++) {
    f.advance(interval - 1); await m.tick(); assert.equal(m.job.cycles, cycle - 1);
    f.advance(1 + 5 / 60); await m.tick(); // Real timer may be a few seconds after the due time.
    assert.equal(m.job.cycles, cycle, m.job.message);
    assert.equal(m.job.nextAt, Date.parse(f.booking.bookedAt) + minutes(interval));
    m = f.reload();
  }
  assert.equal(f.calls.length, 4);
});

test('next-booking interval, validation, legacy migration and corrupt interval recovery', async t => {
  const f = fixture(t), m = f.manager;
  for (const intervalMinutes of [29,60,30.5,'40',null,NaN]) {
    await assert.rejects(m.start({arrivalAt,mode:'current',intervalMinutes}), /30～59/);
  }
  assert.equal(f.calls.length, 0);
  await m.start({arrivalAt,mode:'next',intervalMinutes:35});
  f.booking={...f.booking,id:'new'}; await m.tick();
  assert.equal(m.job.nextAt, initial + minutes(35));
  const saved=JSON.parse(fs.readFileSync(f.file)); delete saved.job.intervalMinutes;
  fs.writeFileSync(f.file,JSON.stringify(saved)); assert.equal(f.reload().job.intervalMinutes,50);
  saved.job.intervalMinutes=15; fs.writeFileSync(f.file,JSON.stringify(saved));
  const invalid=f.reload(); assert.match(invalid.error,/30～59/); await invalid.tick(); assert.equal(f.calls.length,0);
});
test('invalid arrival, no current booking, and observation mode are rejected without requests', async t => {
  const f = fixture(t), m = f.manager;
  for (const value of ['bad', '2026-10-10T07:00:00+08:00', '2026-10-11T14:00:00+08:00']) {
    await assert.rejects(m.start({ arrivalAt: value, mode: 'current' }));
  }
  f.booking = null;
  await assert.rejects(m.start({ arrivalAt, mode: 'current' }));
  f.deps.config = () => ({ axisEnd: '22:00', verifyOnly: true });
  await assert.rejects(m.start({ arrivalAt, mode: 'next' }), /观察/);
  assert.equal(f.calls.length, 0);
});
test('signed-in record stops automatically without cancellation', async t => {
  const f = fixture(t), m = f.manager;
  await m.start({ arrivalAt, mode: 'current' });
  f.rows[0].status_name = '已签到'; f.rows[0].status = '3';
  f.advance(50); await m.tick();
  assert.equal(m.job.phase, 'finished'); assert.equal(f.calls.length, 0); assert.ok(f.booking);
});
test('a synchronized check-in stops the timer before its next due time', async t => {
  const f = fixture(t); await f.manager.start({ arrivalAt, mode: 'current' });
  f.booking.remoteState = 'signed'; await f.manager.tick();
  assert.equal(f.manager.job.active, false); assert.equal(f.manager.job.phase, 'finished'); assert.equal(f.calls.length, 0);
});

test('whole-day renewal uses segments across cycles, independent of custom duration limits', async t => {
  const f = fixture(t, { reserveType: '1', segment: 'official-slot', endTime: '22:00', officialId: 'official-1', remoteState: 'reserved', outcome: 'success' }), m = f.manager;
  let preparations = 0;
  f.deps.prepare = async (b, window) => { preparations++; return { ...window, areaId: '59', reserveType: '1', segment: 'official-slot' }; };
  await m.start({ arrivalAt, mode: 'current' });
  for (let i = 0; i < 3; i++) {
    f.advance(50); await m.tick();
    assert.equal(m.job.cycles, i + 1); assert.equal(m.job.active, true);
    assert.equal(f.booking.endTime, '22:00'); assert.equal(f.booking.segment, 'official-slot');
    assert.equal(f.booking.officialId, undefined); assert.equal(f.booking.remoteState, undefined);
    assert.equal(f.booking.areaId, '59');
  }
  assert.equal(f.booking.startTime, '10:30'); assert.equal(preparations, 7); assert.equal(f.calls.length, 6);
});
test('unavailable official segment at execution preserves the existing seat', async t => {
  const f = fixture(t, { reserveType: '1', segment: 'slot', endTime: '22:00' });
  f.deps.prepare = async (b, window) => window;
  await f.manager.start({ arrivalAt, mode: 'current' });
  f.deps.prepare = async () => { throw Error('官网时段不可用'); };
  f.advance(50); await f.manager.tick();
  assert.equal(f.calls.length, 0); assert.ok(f.booking); assert.equal(f.manager.job.active, false);
});
test('next-booking plan accepts segments and a queued minute change records the real submission time', async t => {
  const f = fixture(t), m = f.manager;
  f.deps.prepare = async (b, window) => ({ ...window, reserveType: b.reserveType, segment: b.segment });
  await m.start({ arrivalAt, mode: 'next' });
  f.booking = { ...f.booking, id: 'segmented', reserveType: '1', segment: 'slot' };
  await m.tick(); assert.equal(m.job.phase, 'waiting');
  f.control.beforeReserve = () => f.advance(1);
  f.advance(50); await m.tick();
  assert.equal(m.job.cycles, 1); assert.equal(f.booking.startTime, '08:51');
  assert.equal(f.booking.bookedAt, new Date(initial + minutes(51)).toISOString());
});
test('sleep beyond safety margin stops instead of cancelling stale reservations', async t => {
  const f = fixture(t), m = f.manager;
  await m.start({ arrivalAt, mode: 'current' }); f.advance(59); await m.tick();
  assert.equal(m.job.active, false); assert.equal(f.calls.length, 0); assert.match(m.job.message, /59/);
});
test('cancellation timeout blocks new booking and check restores still-active original', async t => {
  const f = fixture(t), m = f.manager;
  await m.start({ arrivalAt, mode: 'current' }); f.control.cancelError = true;
  f.advance(50); await m.tick(); await m.tick();
  assert.equal(m.job.phase, 'cancel-unknown'); assert.equal(f.booking, null); assert.equal(f.calls.length, 1);
  m.stop(); assert.equal(m.blocksBooking(), true);
  await m.check(); assert.equal(m.job.phase, 'stopped'); assert.ok(f.booking); assert.equal(m.blocksBooking(), false);
});
test('cancellation rejection never proceeds to booking', async t => {
  const f = fixture(t), m = f.manager;
  await m.start({ arrivalAt, mode: 'current' }); f.control.cancelCode = 287;
  f.advance(50); await m.tick(); assert.equal(f.calls.length, 1); assert.equal(m.job.active, false);
});
test('seat taken after cancel: stop, notify, no claim that seat is held', async t => {
  const f = fixture(t), m = f.manager;
  await m.start({ arrivalAt, mode: 'current' }); f.control.reserveCode = 409;
  f.advance(50); await m.tick();
  assert.equal(m.job.phase, 'paused'); assert.equal(f.booking, null); assert.equal(f.pending, null);
  assert.match(m.job.notice.message, /没有.*保留座位/); assert.equal(f.calls.length, 2);
});
test('rebooking timeout preserves pending and never retries', async t => {
  const f = fixture(t), m = f.manager;
  await m.start({ arrivalAt, mode: 'current' }); f.control.reserveError = true;
  f.advance(50); await m.tick(); await m.tick();
  assert.equal(m.job.phase, 'booking-unknown'); assert.ok(f.pending); assert.equal(f.calls.length, 2);
  assert.equal(f.reload().blocksBooking(), true);
});
test('stop before queued cancellation prevents request; stop during cancellation prevents rebooking', async t => {
  for (const timing of ['beforeCancel', 'afterCancel']) {
    const f = fixture(t), m = f.manager;
    await m.start({ arrivalAt, mode: 'current' });
    f.control[timing] = () => m.stop(); f.advance(50); await m.tick();
    assert.equal(m.job.active, false); assert.equal(f.calls.some(c => c[0] === 'book'), false);
    assert.equal(!!f.booking, timing === 'beforeCancel');
  }
});
test('stop while a booking response is in flight preserves confirmed result without scheduling again', async t => {
  const f = fixture(t), m = f.manager;
  await m.start({ arrivalAt, mode: 'current' });
  f.control.afterReserve = () => m.stop(); f.advance(50); await m.tick();
  assert.ok(f.booking); assert.equal(m.job.active, false); assert.equal(m.job.cycles, 1);
});
test('restart waiting job resumes from persisted due time, in-flight cancellation only pauses', async t => {
  const f = fixture(t), m = f.manager;
  await m.start({ arrivalAt, mode: 'current' });
  const resumed = f.reload(); assert.equal(resumed.job.nextAt, initial + minutes(50));
  f.advance(50); await resumed.tick(); assert.equal(resumed.job.cycles, 1);
  resumed.set({ phase: 'cancelling' });
  const uncertain = f.reload(); await uncertain.tick();
  assert.equal(uncertain.job.phase, 'cancel-unknown'); assert.equal(f.calls.length, 2);
});
test('record lookup failure and corrupt journal never cancel', async t => {
  const f = fixture(t), m = f.manager;
  await m.start({ arrivalAt, mode: 'current' });
  f.control.recordsError = true; f.advance(50); await m.tick();
  assert.equal(f.calls.length, 0); assert.equal(m.job.active, false);
  fs.writeFileSync(f.file, '{broken');
  const broken = f.reload(); assert.ok(broken.error); await broken.tick(); assert.equal(f.calls.length, 0);
});
test('arrival at next due time stops before cancellation; an armed search stops too', async t => {
  for (const mode of ['current', 'next']) {
    const f = fixture(t), m = f.manager;
    await m.start({ arrivalAt: '2026-10-10T08:50:00+08:00', mode });
    f.advance(50); await m.tick();
    assert.equal(m.job.phase, 'finished'); assert.equal(f.calls.some(c => c[0] === 'cancel'), false);
    if (mode === 'next') assert.deepEqual(f.calls, [['stop-search']]);
  }
});
test('stop during activation cannot enable the plan afterwards', async t => {
  const f = fixture(t), m = f.manager;
  f.deps.records = async () => { m.stop(); return f.rows; };
  await assert.rejects(m.start({ arrivalAt, mode: 'current' }), /停止/);
  assert.equal(m.job, null); assert.equal(f.calls.length, 0);
});
test('crash after confirmed cancellation does not resume a released reservation', async t => {
  const f = fixture(t), m = f.manager;
  await m.start({ arrivalAt, mode: 'current' }); m.set({ phase: 'cancelled' });
  const recovered = f.reload(); await recovered.tick();
  assert.equal(recovered.job.active, false); assert.match(recovered.job.notice.message, /已释放/);
  assert.equal(f.calls.length, 0);
});
test('journal write failure before cancellation stops and alerts without sending', async t => {
  const f = fixture(t), m = f.manager;
  await m.start({ arrivalAt, mode: 'current' });
  m.save = () => { throw Error('磁盘不可写'); };
  f.advance(50); await m.tick();
  assert.equal(f.calls.length, 0); assert.equal(m.job.active, false);
  assert.match(m.status().notice.message, /磁盘不可写/); assert.equal(m.blocksBooking(), true);
});
