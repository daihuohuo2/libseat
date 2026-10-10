'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectedAreaIds, resolveBookingRule, resolveRenewalRule, orderBody, validateSubmission } = require('../booking-protocol');
const { currentRecordsSource, recordsEndpoint } = require('../reservation-records');
const now = new Date(2026, 9, 10, 16, 2);
const cfg = { dateMode: 'today', timeMode: 'now', axisStart: '08:00', axisEnd: '22:00', axisStep: 15, axisMaxMin: 240 };
const desired = { start: '16:15', end: '20:15' };
const segmented = { type: '1', date: { reserveType: '1', list: [{ day: '2026-10-10', times: [
  { id: 'closed', status: 0, start: '08:00', end: '22:00' },
  { id: 'expired', status: 1, start: '08:00', end: '12:00' },
  { id: '1762548', status: 1, start: '16:02', end: '22:00' }
] }] } };
test('whole-day segment uses the official ID and no fabricated custom hours', () => {
  const rule = resolveBookingRule(segmented, cfg, '2026-10-10', desired, now);
  assert.deepEqual(orderBody('seat-1', '2026-10-10', rule), { seat_id: 'seat-1', day: '2026-10-10', segment: '1762548', start_time: '', end_time: '' });
  assert.equal(rule.start, '16:02'); assert.equal(rule.end, '22:00');
  assert.equal(validateSubmission(cfg, '2026-10-10', rule, now), '');
  assert.match(validateSubmission(cfg, '2026-10-10', rule, new Date(2026, 9, 10, 22, 0)), /结束/);
  assert.match(validateSubmission(cfg, '2026-10-10', rule, new Date(2026, 9, 11, 9, 0)), /日期/);
});
test('custom time cannot silently expand into a whole-day segment; missing rules never submit', () => {
  assert.throws(() => resolveBookingRule(segmented, { ...cfg, timeMode: 'custom' }, '2026-10-10', desired, now), /整段/);
  assert.throws(() => resolveBookingRule({}, cfg, '2026-10-10', desired, now), /规则/);
});
test('renewal keeps the original segment through its closing time and ignores the custom four-hour cap', () => {
  const b = { reserveType: '1', segment: '1762548', date: '2026-10-10', startTime: '15:12', endTime: '22:00' };
  const rule = resolveRenewalRule(segmented, b, cfg, desired, now);
  assert.equal(rule.segment, b.segment); assert.equal(rule.start, '16:02'); assert.equal(rule.end, '22:00');
  assert.deepEqual(orderBody('9213', b.date, rule), { seat_id: '9213', day: b.date, segment: '1762548', start_time: '', end_time: '' });
  assert.throws(() => resolveRenewalRule(segmented, { ...b, endTime: '21:00' }, cfg, desired, now), /不可用/);
  assert.throws(() => resolveRenewalRule(segmented, b, cfg, desired, new Date(2026, 9, 10, 22, 0)), /时段/);
});
test('flexible time follows that area official step, length and opening hours', () => {
  const map = { type: '1', date: { reserveType: '3', list: [{ day: '2026-10-10', start_time: '2026-10-10 07:30:00', end_time: '2026-10-10 21:30:00', step: '30', min_time: '30', max_time: '120' }] } };
  const rule = resolveBookingRule(map, cfg, '2026-10-10', desired, now);
  assert.deepEqual(orderBody('seat-2', '2026-10-10', rule), { seat_id: 'seat-2', day: '2026-10-10', segment: '', start_time: '16:30', end_time: '18:30' });
});
test('grab list accepts cross-floor imported IDs independent of stale target areaIds', () => {
  assert.deepEqual(selectedAreaIds({ areaIds: ['59'], preferAreas: ['59', 51, '51'] }), ['59', '51']);
  assert.deepEqual(selectedAreaIds({ areaIds: ['59', '57'], preferAreas: [] }), ['59', '57']);
});
test('record lookup follows the current official build instead of an expired asset URL', async () => {
  const calls = [];
  const assets = {
    '/h5/': '<script src="/h5/assets/index.1791609051660.js"></script>',
    '/h5/assets/index.1791609051660.js': 'const assets=["assets/sear-record.1791609051660.js"]',
    '/h5/assets/sear-record.1791609051660.js': 'function e(e){return a({url:"/v4/member/seat",data:e})}export{e as g};'
  };
  const source = await currentRecordsSource(async asset => { calls.push(asset); assert.ok(assets[asset]); return assets[asset]; });
  assert.equal(recordsEndpoint(source), '/v4/member/seat');
  assert.deepEqual(calls, Object.keys(assets));
});
