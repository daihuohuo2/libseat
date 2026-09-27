'use strict';
// The archived official seat-record page imports `g` from this API module.
// Read its URL declaration; never evaluate downloaded JavaScript or guess an endpoint.
const RECORD_ASSET = '/h5/assets/sear-record.1787201907183.js';
function recordsEndpoint(source) {
  const exports = source.match(/export\s*\{([^}]+)\}/);
  const entry = exports && exports[1].split(',').map(s => s.trim()).find(s => /\s+as\s+g$/.test(s));
  const name = entry && entry.split(/\s+/)[0];
  if (!name || !/^[$\w]+$/.test(name)) throw Error('无法识别官网预约记录接口');
  const escaped = name.replace(/[$]/g, '\\$');
  const body = source.match(new RegExp('function\\s+' + escaped + '\\([^)]*\\)\\s*\\{([^}]+)'));
  const url = body && body[1].match(/url\s*:\s*["'](\/v4\/[\w/]+)["']/);
  if (!url) throw Error('官网预约记录接口格式已变化');
  return url[1];
}
function timestamp(value) {
  const raw = String(value || '');
  const parts = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?$/);
  if (parts) return parts[1] + ' ' + parts[2];
  if (/^\d{10}(?:\d{3})?$/.test(raw)) {
    const date = new Date(Number(raw) * (raw.length === 10 ? 1000 : 1));
    const pad = n => String(n).padStart(2, '0');
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }
  return '';
}
function matchesRecord(record, booking) {
  if (!record || !['1', '2', '3', '9', '11', '32', '33'].includes(String(record.status))) return false;
  // Do not infer active bookings from UI color codes alone; ended/cancelled records can look similar.
  if (!['已预约', '预约成功', '待签到', '已签到', '使用中', '暂离', '临时离开', '待入馆'].includes(String(record.status_name || '').trim())) return false;
  const sameSeat = record.seat_id != null
    ? String(record.seat_id) === booking.seatId
    : String(record.name || '') === booking.seat && String(record.nameMerge || '') === booking.area;
  return sameSeat && timestamp(record.beginTime) === booking.date + ' ' + booking.startTime
    && timestamp(record.endTime) === booking.date + ' ' + booking.endTime;
}
module.exports = { RECORD_ASSET, recordsEndpoint, matchesRecord };
