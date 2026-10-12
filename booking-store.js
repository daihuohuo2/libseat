'use strict';
const fs = require('fs');
const path = require('path');

// Reservation dates belong to the school's time zone, regardless of the device zone.
function bookingEnded(booking, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(booking?.date || '')) return false;
  const midnight = Date.parse(booking.date + 'T00:00:00+08:00');
  const end = /^([01]\d|2[0-3]):[0-5]\d$/.test(booking.endTime || '')
    ? Date.parse(booking.date + 'T' + booking.endTime + ':00+08:00') : midnight + 86400000;
  return Number.isFinite(end) && now >= end;
}

// Written before submitting an order, so a crash can never erase an uncertain request.
class BookingStore {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, pending: null, pendingAction: null, history: [], claims: [] };
    this.error = '';
    try {
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const validBooking = b => b && ['id', 'seat', 'date', 'startTime', 'endTime'].every(k => typeof b[k] === 'string' && b[k]);
        if (data.version !== 1 || !Array.isArray(data.history) || !Array.isArray(data.claims)
            || !data.history.every(validBooking) || !data.claims.every(k => typeof k === 'string')
            || (data.pending && !validBooking(data.pending))
            || (data.pendingAction && (!['cancel', 'leave', 'checkout'].includes(data.pendingAction.action)
              || !data.pendingAction.bookingId || !data.pendingAction.recordId))) throw Error('记录格式无效');
        this.data = data;
      }
    } catch (e) { this.error = '无法读取预约记录：' + e.message; }
  }
  write(next) {
    if (this.error) throw Error(this.error);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeFileSync(fd, JSON.stringify(next, null, 2)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
    this.data = next;
  }
  setPending(booking) { this.write({ ...this.data, pending: booking }); }
  finish(booking, outcome) {
    const record = { ...booking, outcome, resolvedAt: new Date().toISOString() };
    this.write({ ...this.data, pending: null,
      history: outcome === 'rejected' ? this.data.history : [record, ...this.data.history.filter(b => b.id !== record.id)].slice(0, 50) });
    return record;
  }
  claim(id, channel) {
    const key = channel + ':' + id;
    if (this.data.claims.includes(key) || !this.data.history.some(b => b.id === id && b.outcome === 'success')) return false;
    this.write({ ...this.data, claims: [...this.data.claims, key].slice(-150) });
    return true;
  }
}
module.exports = { BookingStore, bookingEnded };
