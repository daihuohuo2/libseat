'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const prefs = require('../public/area-seat-prefs');
const { orderAreaCandidates } = require('../seat-prefs');
const seats = [149, 150, 160, 161, 162, 164, 170].map(n => ({ no: 'XF5A' + n }));
test('single numbers, full labels and inclusive ranges resolve only actual seats and deduplicate', () => {
  assert.deepEqual(prefs.parse('149，XF5A150, 160 - 164; 161', seats), ['XF5A149', 'XF5A150', 'XF5A160', 'XF5A161', 'XF5A162', 'XF5A164']);
  assert.deepEqual(prefs.parse('xf5a149～xf5a150', seats), ['XF5A149', 'XF5A150']);
  assert.deepEqual(prefs.parse('001-002', ['XF5A001', 'XF5A002', 'XF5A003']), ['XF5A001', 'XF5A002']);
});
test('invalid, reversed, ambiguous and cross-prefix numbers are rejected', () => {
  for (const text of ['999', '170-149', '149-999', '', '149-XF5B170']) assert.throws(() => prefs.parse(text, seats));
  assert.throws(() => prefs.parse('001', ['A001', 'B001']), /完整编号/);
  assert.throws(() => prefs.parse('A001-B002', ['A001', 'B002']), /无效/);
});
test('preferences stay in their own area and fall back to other free seats there', () => {
  const cfg = { preferAreas: ['59', '57'], areaSeatPrefs: { '59': { mode: 'prefer', seats: ['XF5A150', 'XF5A149'] }, '57': { mode: 'any', seats: [] } } };
  const free = [seats[2], seats[1]];
  assert.deepEqual(orderAreaCandidates(cfg, '59', free).map(c => [c.seat.no, c.pref]), [['XF5A150', true], ['XF5A160', false]]);
  assert.deepEqual(orderAreaCandidates(cfg, '59', [seats[2]]).map(c => c.seat.no), ['XF5A160']);
  assert.deepEqual(orderAreaCandidates(cfg, '57', [{ no: 'XF5B150' }]).map(c => [c.seat.no, c.pref]), [['XF5B150', false]]);
});
test('any mode clears old selections; plan snapshots cannot inherit other areas or mutate config', () => {
  assert.deepEqual(prefs.normalize({ mode: 'any', seats: ['OLD'] }), { mode: 'any', seats: [] });
  const map = { '59': { mode: 'prefer', seats: ['XF5A149'] }, '57': { mode: 'prefer', seats: ['XF5B001'] } };
  const saved = prefs.snapshot(['59'], map); saved['59'].seats.push('XF5A150');
  assert.deepEqual(map['59'].seats, ['XF5A149']); assert.equal(saved['57'], undefined);
  assert.deepEqual(prefs.snapshot(['59'], undefined), {});
  assert.throws(() => prefs.normalize({ mode: 'prefer', seats: [] }), /至少/);
  assert.throws(() => prefs.normalizeMap(JSON.parse('{"__proto__":{"mode":"any"}}')), /区域/);
});
