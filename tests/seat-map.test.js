'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const map = require('../public/seat-map');

function seat(no, x, y, extra = {}) {
  return { id: String(no), no: 'XF5A' + String(no).padStart(3, '0'), x, y, w: 2.2, h: 3.8, status: '1', ...extra };
}

test('hand-positioned seats align in rows and columns, retain aisles and identities', () => {
  const seats = [];
  for (let row = 0; row < 6; row++) for (let col = 0; col < 8; col++) {
    const n = row * 8 + col;
    seats.push(seat(n, col * 3.3 + (col >= 4 ? 6.6 : 0) + (n % 3 - 1) * .12,
      row * 3.8 + (row >= 3 ? 11.4 : 0) + (n % 5 - 2) * .1,
      { w: 2.2 + (n % 4 - 2) * .08, h: 3.8 + (n % 3 - 1) * .1 }));
  }
  const original = JSON.stringify(seats);
  const result = map.layout(seats);
  assert.equal(result.seats.length, seats.length);
  assert.equal(new Set(result.seats.map(s => s.x + ',' + s.y)).size, seats.length);
  for (let row = 0; row < 6; row++) assert.equal(new Set(result.seats.slice(row * 8, row * 8 + 8).map(s => s.y)).size, 1);
  for (let col = 0; col < 8; col++) assert.equal(new Set(result.seats.filter((_, i) => i % 8 === col).map(s => s.x)).size, 1);
  assert.ok(result.seats[4].x - result.seats[3].x > 2 * (result.seats[1].x - result.seats[0].x));
  assert.ok(result.seats[24].y - result.seats[16].y > 2 * (result.seats[8].y - result.seats[0].y));
  result.seats.forEach((placed, i) => assert.equal(placed.seat, seats[i]));
  assert.equal(JSON.stringify(seats), original, 'source coordinates and booking IDs stay unchanged');
});

test('offset seat banks align with existing columns without overlapping', () => {
  const seats = [seat(1, 88, 20), seat(2, 91.3, 20), seat(3, 86.7, 60), seat(4, 90, 60)];
  const placed = map.layout(seats).seats;
  assert.equal(placed[0].x, placed[2].x);
  assert.equal(placed[1].x, placed[3].x);
  assert.notEqual(placed[0].y, placed[2].y);
});

test('coincident source coordinates never hide a seat behind another seat', () => {
  const placed = map.layout([seat(1, 10, 20), seat(2, 10, 20), seat(3, 10.1, 20.1)]).seats;
  assert.equal(placed.length, 3);
  assert.equal(new Set(placed.map(s => s.x + ',' + s.y)).size, 3);
});

test('empty and invalid geometry does not create invalid canvas dimensions', () => {
  assert.deepEqual(map.layout([]).seats, []);
  const result = map.layout([seat(1, NaN, 20), seat(2, 10, 20, { w: 0 }), seat(3, 10, 20, { h: Infinity }), seat(4, 10, 20)]);
  assert.equal(result.seats.length, 1);
  assert.equal(result.seats[0].seat.no, 'XF5A004');
  assert.equal(result.width, result.seatWidth);
  assert.equal(result.height, result.seatHeight);
});

test('seat numbers remain legible identifiers and status codes stay distinct', () => {
  assert.equal(map.label('XF5A049'), '049');
  assert.equal(map.label('XF5A1049'), '1049');
  assert.equal(map.label('A-12B'), 'A-12B');
  assert.equal(map.status(1).className, 'available');
  assert.equal(map.status('2').className, 'reserved');
  assert.equal(map.status('7').className, 'away');
  assert.equal(map.status('6').className, 'occupied');
  assert.equal(map.status('unrecognized').name, '未知状态');
});
test('my reservation is identified by seat, area and date, without recoloring another booking', () => {
  const s = seat(48, 1, 1, { status: '2' });
  const data = { date: '2026-10-10', area: { id: '59', name: '五楼A区' } };
  const status = { success: true, booking: { id: 'local', seatId: '48', seat: 'XF5A048', areaId: '59', date: data.date } };
  assert.equal(map.isMine(s, data, status), true);
  assert.equal(map.isMine({ ...s, id: '49' }, data, status), false);
  assert.equal(map.isMine(s, { ...data, date: '2026-10-11' }, status), false);
  assert.equal(map.isMine(s, { ...data, area: { id: '57' } }, status), false);
  assert.equal(map.isMine(s, data, { ...status, success: false }), false);
  assert.equal(map.isMine(s, data, { ...status, bookingManagement: { pendingAction: { action: 'cancel' } } }), false);
  assert.equal(map.isMine(s, data, { ...status, booking: { ...status.booking, remoteState: 'away' } }), true);
  assert.equal(map.isMine(s, data, { ...status, booking: { ...status.booking, remoteState: 'completed' } }), false);
});
