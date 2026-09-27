'use strict';
function dateText(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}
function minutes(text) {
  if (typeof text !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) return NaN;
  const [h, m] = text.split(':').map(Number);
  return h * 60 + m;
}
function validateBookingWindow(cfg, date, window, now = new Date()) {
  if (!['today', 'tomorrow'].includes(cfg.dateMode) || !['now', 'custom'].includes(cfg.timeMode)) return '日期或查询方式无效';
  const target = new Date(now);
  if (cfg.dateMode === 'tomorrow') target.setDate(target.getDate() + 1);
  if (date !== dateText(target)) return '目标日期已变化，请重新查询座位';
  const start = minutes(window.start), end = minutes(window.end);
  const open = minutes(cfg.axisStart), close = minutes(cfg.axisEnd);
  const step = Number(cfg.axisStep), max = Number(cfg.axisMaxMin);
  if (![start, end, open, close, step, max].every(Number.isFinite) || step <= 0 || max <= 0 || open >= close) return '预约时间配置无效';
  if (start >= end) return '预约时段已结束或时长为零';
  if (start < open || end > close) return '预约时段超出开放时间 ' + cfg.axisStart + '–' + cfg.axisEnd;
  if (end - start > max) return '单次预约不能超过 ' + max + ' 分钟';
  if ((start - open) % step || (end - open) % step) return '预约时间需按 ' + step + ' 分钟对齐';
  if (date === dateText(now) && start < now.getHours() * 60 + now.getMinutes()) return '预约开始时间已经过去';
  return '';
}
module.exports = { validateBookingWindow };
