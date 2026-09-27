/**
 * 心仪座位逻辑单测：node test-prefs.js
 */
'use strict';
const { normalizePrefs, orderCandidates } = require('./seat-prefs.js');

let pass = 0, fail = 0;
function eq(actual, expect, name) {
  const a = JSON.stringify(actual), e = JSON.stringify(expect);
  if (a === e) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '\n      期望 ' + e + '\n      实际 ' + a); }
}
const seat = no => ({ no: no, id: 'id-' + no, status: '1' });
const nos = list => list.map(c => c.seat.no);
const marks = list => list.map(c => c.seat.no + (c.pref ? '★' : ''));

console.log('normalizePrefs：');
eq(normalizePrefs([' xf5a137 ', 'XF5A195', 'xf5a137', '', null]), ['XF5A137', 'XF5A195'], '去空/大写/去重/保序');
eq(normalizePrefs(undefined), [], 'undefined 安全');

console.log('\n未设置心仪座位：');
eq(nos(orderCandidates({ seatPrefs: [] }, [seat('A1'), seat('A2'), seat('A3')])), ['A1', 'A2', 'A3'], '按接口原顺序返回全部');

console.log('\n优先模式（prefer）：');
eq(marks(orderCandidates(
  { seatPrefs: ['B2', 'A3'], seatPrefMode: 'prefer' },
  [seat('A1'), seat('A2'), seat('A3'), seat('B1'), seat('B2')]
)), ['B2★', 'A3★', 'A1', 'A2', 'B1'], '心仪按用户顺序在前，其余依次跟上');

console.log('\n只抢模式（only）：');
eq(marks(orderCandidates(
  { seatPrefs: ['B2', 'A3'], seatPrefMode: 'only' },
  [seat('A1'), seat('A3'), seat('B2')]
)), ['B2★', 'A3★'], '只返回心仪座位');
eq(orderCandidates(
  { seatPrefs: ['X9'], seatPrefMode: 'only' }, [seat('A1'), seat('A2')]
).length, 0, '心仪座位都不可约 → 空数组（调用方继续等待）');

console.log('\n部分可约 / 大小写 / 优先级编号：');
const r = orderCandidates({ seatPrefs: ['b2', 'A9', 'a1'], seatPrefMode: 'prefer' },
  [seat('A1'), seat('B2'), seat('C3')]);
eq(marks(r), ['B2★', 'A1★', 'C3'], '不可约的心仪座位自动跳过');
eq(r.filter(c => c.pref).map(c => c.priority), [1, 3], 'priority 反映用户填写次序');

console.log('\n没有空闲座位：');
eq(orderCandidates({ seatPrefs: ['A1'] }, []).length, 0, '空列表安全');

console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
