'use strict';
const { validateBookingWindow } = require('./booking-window.js');

const minute = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value))
  ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : NaN;
const clock = value => String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
const dayText = now => now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
const timeText = value => String(value || '').match(/(?:^|[ T])([0-2]\d:[0-5]\d)(?::\d\d)?$/)?.[1] || '';

// The grab list is a set, independent of the floor currently shown in the map.
function selectedAreaIds(cfg) {
  return [...new Set((cfg.preferAreas?.length ? cfg.preferAreas : cfg.areaIds || []).map(String))];
}

// Verified against the official appointment page: type 1 submits a segment ID;
// type 3 submits start/end. Never guess a protocol when the rules are missing.
function resolveBookingRule(map, cfg, date, desired, now = new Date()) {
  const type = String(map?.date?.reserveType || '');
  const row = map?.date?.list?.find(row => row.day === date);
  if (String(map?.type) !== '1' || !row) throw Error('官网未提供该区域当天的座位预约规则');
  if (type === '1') {
    const current = date === dayText(now) ? now.getHours() * 60 + now.getMinutes() : 0;
    const slots = (row.times || []).filter(slot => slot.id && String(slot.status) === '1'
      && Number.isFinite(minute(slot.start)) && minute(slot.end) > Math.max(minute(slot.start), current));
    const slot = cfg.timeMode === 'custom'
      ? slots.find(slot => slot.start === desired.start && slot.end === desired.end) : slots[0];
    if (!slot) throw Error(cfg.timeMode === 'custom'
      ? '该区域只支持官网整段预约，所选时段不匹配；请切换实时模式或选择官网时段'
      : '该区域当天暂无可预约的官网时段');
    return { reserveType: type, segment: String(slot.id), start: clock(Math.max(minute(slot.start), current)), end: slot.end };
  }
  if (type !== '3') throw Error('暂不支持该区域的预约类型（' + (type || '未知') + '），未提交预约');
  const axis = { axisStart: timeText(row.start_time), axisEnd: timeText(row.end_time),
    axisStep: Number(row.step), axisMaxMin: Number(row.max_time) };
  let window = { ...desired };
  if (cfg.timeMode === 'now') {
    const open = minute(axis.axisStart), close = minute(axis.axisEnd);
    const current = date === dayText(now) ? now.getHours() * 60 + now.getMinutes() : open;
    const start = open + Math.ceil(Math.max(0, current - open) / axis.axisStep) * axis.axisStep;
    window = { start: clock(start), end: clock(Math.min(start + axis.axisMaxMin, close)) };
  }
  const invalid = validateBookingWindow({ ...cfg, ...axis }, date, window, now);
  if (invalid) throw Error(invalid);
  if (Number(row.min_time) > minute(window.end) - minute(window.start)) throw Error('预约时长小于官网要求的最短时长');
  return { reserveType: type, segment: '', ...window, axis };
}

function validateSubmission(cfg, date, rule, now = new Date()) {
  const target = new Date(now);
  if (cfg.dateMode === 'tomorrow') target.setDate(target.getDate() + 1);
  if (date !== dayText(target)) return '目标日期已变化，请重新查询座位';
  if (rule.reserveType === '1') {
    if (!rule.segment || !Number.isFinite(minute(rule.start)) || minute(rule.end) <= minute(rule.start)) return '官网预约时段无效';
    if (date === dayText(now) && minute(rule.end) <= now.getHours() * 60 + now.getMinutes()) return '官网预约时段已结束';
    return '';
  }
  return validateBookingWindow({ ...cfg, ...rule.axis }, date, rule, now);
}

function orderBody(seatId, date, rule) {
  return { seat_id: seatId, day: date, segment: rule.reserveType === '1' ? rule.segment : '',
    start_time: rule.reserveType === '1' ? '' : rule.start,
    end_time: rule.reserveType === '1' ? '' : rule.end };
}

function resolveRenewalRule(map, booking, cfg, desired, now = new Date()) {
  if (booking.reserveType === '1') {
    if (String(map?.date?.reserveType) !== '1') throw Error('官网预约规则已变化');
    const row = map.date.list?.find(r => r.day === booking.date);
    const candidates = (row?.times || []).filter(s => String(s.status) === '1' && s.end === booking.endTime);
    const slot = candidates.find(s => String(s.id) === String(booking.segment)) || (candidates.length === 1 ? candidates[0] : null);
    if (!slot) throw Error('原预约对应的官网时段不可用');
    const narrowed = { ...map, date: { ...map.date, list: [{ ...row, times: [slot] }] } };
    return resolveBookingRule(narrowed, { ...cfg, dateMode: 'today', timeMode: 'now' }, booking.date, desired, now);
  }
  return resolveBookingRule(map, { ...cfg, dateMode: 'today', timeMode: 'custom' }, booking.date, desired, now);
}

module.exports = { selectedAreaIds, resolveBookingRule, resolveRenewalRule, validateSubmission, orderBody };
