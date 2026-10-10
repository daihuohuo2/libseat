'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { matchesRecord } = require('./reservation-records');

const MINUTE = 60000;
function validateInterval(value = 50) {
  if (!Number.isInteger(value) || value < 30 || value > 59) throw Error('重约间隔必须为 30～59 分钟的整数');
  return value;
}
const shanghaiDate = ms => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
const timeMinutes = value => {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value))) return NaN;
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
};
const waiting = r => r && !r.wait_id && String(r.oksign) === '1'
  && ['2', '9'].includes(String(r.status))
  && ['已预约', '预约成功', '待签到', '待入馆'].includes(String(r.status_name).trim());
const signed = r => r && ['已签到', '使用中', '暂离', '临时离开'].includes(String(r.status_name).trim());

function nextWindow(job, now) {
  const cfg = job.axis;
  const date = shanghaiDate(now);
  const china = new Date(now + 8 * 3600000);
  const mins = china.getUTCHours() * 60 + china.getUTCMinutes();
  const fmt = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  if (job.booking?.reserveType === '1') {
    const start = Math.max(mins, timeMinutes(job.booking.startTime)), end = timeMinutes(job.booking.endTime);
    if (date !== job.date || !Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw Error('官网预约时段已结束，未继续重约');
    return { date, startTime: fmt(start), endTime: fmt(end) };
  }
  const open = timeMinutes(cfg.axisStart), close = timeMinutes(cfg.axisEnd);
  const step = Number(cfg.axisStep), max = Number(cfg.axisMaxMin);
  const duration = job.duration;
  if (![open, close, step, max, duration].every(Number.isFinite) || step < 1 || step > 60
      || open >= close || duration < step || duration > max || duration % step) throw Error('预约时间轴或原预约时长无效');
  const start = open + Math.ceil(Math.max(0, mins - open) / step) * step;
  const end = Math.min(start + duration, close);
  if (date !== job.date || start >= end) throw Error('已跨日或超出开放时间');
  return { date, startTime: fmt(start), endTime: fmt(end) };
}

// Every destructive request is preceded by an atomic journal write. In-flight
// operations recovered after a crash are checked, never blindly repeated.
class Renewal {
  constructor(file, deps, now = Date.now) {
    this.file = file;
    this.deps = deps;
    this.now = now;
    this.busy = false;
    this.generation = 0;
    this.error = '';
    this.job = null;
    try {
      if (fs.existsSync(file)) {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (saved.version !== 1 || (saved.job && (!saved.job.id || !Number.isFinite(saved.job.arrivalAt)
          || typeof saved.job.active !== 'boolean' || !Array.isArray(saved.job.events)))) throw Error('格式无效');
        this.job = saved.job;
        if (this.job) this.job.intervalMinutes = validateInterval(this.job.intervalMinutes);
        if (this.job && ['cancelling', 'booking'].includes(this.job.phase)) {
          this.set({ active: false, phase: this.job.phase === 'cancelling' ? 'cancel-unknown' : 'booking-unknown' },
            '程序在请求期间退出，结果需要核实，未重复发送请求。', 'error');
        } else if (this.job?.phase === 'cancelled') {
          this.set({ active: false, phase: 'paused' }, '程序在取消成功后退出，原座位已释放；请手动重新预约。', 'error');
        } else if (this.job?.active) {
          this.set({ phase: this.job.booking ? 'waiting' : 'armed' }, '已恢复计划，执行前会重新核实官网预约。');
        }
      }
    } catch (e) { this.error = '无法读取或保存定时重约计划：' + e.message; }
  }
  status() { return { ...this.job, busy: this.busy, error: this.error }; }
  blocksBooking() { return !!(this.error || this.busy || this.job?.active || ['cancel-unknown', 'booking-unknown'].includes(this.job?.phase)); }
  save(job) {
    if (this.error) throw Error(this.error);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + '.tmp';
    const fd = fs.openSync(temp, 'w');
    try { fs.writeFileSync(fd, JSON.stringify({ version: 1, job }, null, 2)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file);
    this.job = job;
  }
  set(fields, message, level) {
    const next = { ...this.job, ...fields };
    if (message) {
      next.message = message;
      next.events = [...(next.events || []), { at: this.now(), message }].slice(-30);
      if (level) next.notice = { id: crypto.randomUUID(), title: level === 'error' ? '定时重约需要处理' : '定时重约已结束', message, level };
    }
    try { this.save(next); }
    catch (e) {
      this.error = '定时重约记录保存失败：' + e.message;
      this.job = { ...next, active: false, message: this.error,
        notice: { id: crypto.randomUUID(), title: '定时重约记录保存失败', message: this.error + '。请核实官网预约状态。', level: 'error' } };
      throw e;
    }
  }
  async start({ arrivalAt, mode, intervalMinutes }) {
    const interval = validateInterval(intervalMinutes);
    if (this.blocksBooking()) throw Error('已有定时重约计划运行中或结果待核实，请先停止或核实');
    if (!['current', 'next'].includes(mode)) throw Error('请选择接管当前预约或等待下一次预约');
    if (this.deps.unavailable()) throw Error('请先停止抢座并处理待确认的预约');
    const now = this.now();
    const arrival = Date.parse(arrivalAt);
    if (!Number.isFinite(arrival) || arrival <= now || shanghaiDate(arrival) !== shanghaiDate(now)) throw Error('到馆时间必须是今天尚未到达的时间（北京时间）');
    const cfg = this.deps.config();
    const close = Date.parse(shanghaiDate(now) + 'T' + cfg.axisEnd + ':00+08:00');
    if (!Number.isFinite(close) || arrival >= close) throw Error('到馆时间必须早于闭馆时间');
    if (mode === 'next' && cfg.verifyOnly !== false) throw Error('请先关闭“仅观察空位”，再设置下一次预约的重约计划');
    this.busy = true;
    const generation = ++this.generation;
    try {
      let booking = null, officialId = null;
      if (mode === 'current') {
        booking = this.deps.booking();
        if (!booking || booking.date !== shanghaiDate(now)) throw Error('没有今天的成功预约，请选择等待下一次预约');
        const rows = await this.deps.records();
        const record = rows.find(r => matchesRecord(r, booking));
        if (!waiting(record) || !record.id) throw Error('官网未确认这笔预约可取消且未签到，不能接管');
        officialId = String(record.id);
        this.validateBookingTime(booking, interval);
      }
      if (generation !== this.generation) throw Error('开启请求已停止');
      this.save({ id: crypto.randomUUID(), active: true, phase: booking ? 'waiting' : 'armed',
        arrivalAt: arrival, date: shanghaiDate(now), intervalMinutes: interval,
        // Snapshot only the time axis. Credentials are never written to this file.
        axis: { axisStart: cfg.axisStart, axisEnd: cfg.axisEnd, axisStep: cfg.axisStep, axisMaxMin: cfg.axisMaxMin },
        booking, officialId, duration: booking ? timeMinutes(booking.endTime) - timeMinutes(booking.startTime) : null,
        nextAt: booking ? Date.parse(booking.bookedAt) + interval * MINUTE : null,
        cycles: 0, events: [], notice: null,
        ignoreBookingId: mode === 'next' ? this.deps.booking()?.id : null });
      if (booking) await this.prepareWindow();
      if (generation !== this.generation) throw Error('开启请求已停止');
      this.set({}, booking ? '已接管当前预约，每 ' + interval + ' 分钟取消并重约同一座位。' : '计划已开启，请开始抢座；下一次成功预约后开始计时。');
    } catch (e) {
      if (this.job?.active) this.set({ active: false, phase: 'paused' }, e.message, 'error');
      throw e;
    } finally { this.busy = false; }
  }
  validateBookingTime(booking, interval = this.job?.intervalMinutes ?? 50) {
    if (booking.reserveType && !['1', '3'].includes(booking.reserveType)) throw Error('官网预约类型暂不支持重约，已保留当前预约');
    const age = this.now() - Date.parse(booking.bookedAt);
    // Allow the selected 58/59-minute schedule to run. Official availability is
    // still checked before every cancellation; stale timers never run blindly.
    const latest = Math.max(58, validateInterval(interval) + 1);
    if (!Number.isFinite(age) || age < 0 || age >= latest * MINUTE) throw Error('预约时间不明或计时已过期，请到官网核实签到期限（原约定为 59 分钟）');
  }
  async prepareWindow() {
    const window = nextWindow(this.job, this.now());
    if (!this.deps.prepare && this.job.booking.reserveType === '1') throw Error('无法校验官网整段预约规则，已保留当前预约');
    if (!this.deps.prepare) return window;
    const prepared = await this.deps.prepare(this.job.booking, window);
    if (prepared.areaId && !this.job.booking.areaId) this.set({ booking: { ...this.job.booking, areaId: prepared.areaId } });
    return { ...window, ...prepared };
  }
  stop() {
    this.generation++;
    if (!this.job) return;
    // Keep uncertain phases visible until the user performs a read-only check.
    const unresolved = ['cancel-unknown', 'booking-unknown', 'cancelling', 'booking'].includes(this.job.phase);
    this.set({ active: false, phase: unresolved ? this.job.phase : 'stopped' },
      this.busy ? '已请求停止；已发送的请求仍需等待结果，不会发起下一步操作。' : '已停止定时重约，未取消当前预约。');
  }
  guard(phase) {
    if (!this.job?.active || this.job.phase !== phase) throw Error('计划已停止');
    if (this.now() >= this.job.arrivalAt) throw Error('已到计划到馆时间，停止操作');
    if (this.deps.unavailable()) throw Error('有其他预约操作或待确认结果，请先核实');
  }
  findRecord(rows) {
    return this.job.officialId ? rows.find(r => String(r.id) === this.job.officialId)
      : rows.find(r => matchesRecord(r, this.job.booking) && String(r.id) !== this.job.previousOfficialId);
  }
  async tick() {
    if (this.busy || this.error || !this.job?.active) return;
    this.busy = true;
    try {
      if (this.now() >= this.job.arrivalAt) {
        if (this.job.phase === 'armed') this.deps.stopSearch?.();
        this.set({ active: false, phase: 'finished' }, '已到计划到馆时间，定时重约已停止。请现在到馆签到，并以官网当前预约为准。', 'info');
        return;
      }
      // A read-only refresh or another operation may temporarily own the booking.
      if (this.deps.unavailable()) return;
      if (this.job.phase === 'waiting' && ['signed', 'away'].includes(this.deps.booking()?.remoteState)) {
        this.set({ active: false, phase: 'finished' }, '官网显示已签到，已停止重约。', 'info');
        return;
      }
      if (this.job.phase === 'armed') {
        const booking = this.deps.booking();
        if (!booking || this.deps.unavailable()) return;
        if (booking.id === this.job.ignoreBookingId) return;
        this.validateBookingTime(booking);
        if (booking.date !== this.job.date) throw Error('成功预约不是今天的预约，计划已暂停');
        this.set({ booking, duration: timeMinutes(booking.endTime) - timeMinutes(booking.startTime),
          phase: 'waiting', nextAt: Date.parse(booking.bookedAt) + this.job.intervalMinutes * MINUTE }, '预约成功，已开始 ' + this.job.intervalMinutes + ' 分钟计时。');
        await this.prepareWindow();
      }
      if (this.now() < this.job.nextAt) return;
      this.validateBookingTime(this.job.booking);
      this.guard('waiting');
      const record = this.findRecord(await this.deps.records());
      if (signed(record)) {
        this.set({ active: false, phase: 'finished' }, '官网显示已签到，已停止定时重约并保留座位。', 'info');
        return;
      }
      if (!waiting(record) || !record.id || !matchesRecord(record, this.job.booking)) throw Error('官网预约不匹配、不可取消或状态已变化，未取消预约');
      this.guard('waiting');
      await this.prepareWindow();
      this.guard('waiting');
      this.set({ officialId: String(record.id), phase: 'cancelling' }, '正在取消预约 ' + this.job.booking.seat + '…');
      let response;
      try {
        response = await this.deps.cancel(String(record.id), () => {
          this.guard('cancelling');
          this.validateBookingTime(this.job.booking);
        });
      } catch (e) {
        if (e.beforeSubmission) throw e;
        this.set({ active: false, phase: 'cancel-unknown' }, '取消请求结果不明，未发送重约。请核实官网记录：' + e.message, 'error');
        this.deps.cancelUnknown(this.job.booking);
        return;
      }
      if (!response || response.code !== 0) {
        // Even a nonzero response might reflect a changed server state. No retry.
        this.set({ active: false, phase: 'cancel-unknown' }, '取消未确认成功，未发送重约：' + (response?.message || '响应无效'), 'error');
        this.deps.cancelUnknown(this.job.booking);
        return;
      }
      this.deps.cancelled(this.job.booking);
      this.set({ phase: 'cancelled' }, '原预约已取消，准备重新预约同一座位。');
      if (!this.job.active || this.now() >= this.job.arrivalAt) {
        this.set({ active: false, phase: 'stopped' }, '原预约已取消；由于停止请求或到馆时间已到，没有重新预约。请手动查看座位。', 'error');
        return;
      }
      // Recalculate after cancellation so queue/network delay cannot submit a past window.
      const window = await this.prepareWindow();
      const booking = { ...this.job.booking, ...window, id: crypto.randomUUID(), bookedAt: new Date(this.now()).toISOString() };
      // A replacement is a new official reservation, never the old cancelled record.
      for (const key of ['officialId', 'remoteState', 'outcome', 'confirmedBy', 'resolvedAt']) delete booking[key];
      this.set({ phase: 'booking', replacement: booking }, '正在重新预约 ' + booking.seat + '…');
      try {
        response = await this.deps.reserve(booking, () => {
          this.guard('booking');
          const current = nextWindow(this.job, this.now());
          if (booking.reserveType === '1') booking.startTime = current.startTime > booking.startTime ? current.startTime : booking.startTime;
          else if (current.startTime !== booking.startTime) throw Error('预约起点已变化，未提交过期时段');
          booking.bookedAt = new Date(this.now()).toISOString();
          this.set({ replacement: booking });
        });
      } catch (e) {
        if (e.beforeSubmission) throw e;
        this.set({ active: false, phase: 'booking-unknown' }, '重约结果不明，请核实官网预约；不会重复提交：' + e.message, 'error');
        return;
      }
      if (response?.code === 0) {
        this.deps.booked(booking);
        const active = this.job.active && this.now() < this.job.arrivalAt;
        this.set({ booking, replacement: null, officialId: null, previousOfficialId: String(record.id),
          phase: active ? 'waiting' : 'finished', active, cycles: this.job.cycles + 1,
          nextAt: Date.parse(booking.bookedAt) + this.job.intervalMinutes * MINUTE },
          '已重新预约 ' + booking.seat + '，累计完成 ' + (this.job.cycles + 1) + ' 次。' + (active ? '' : '计划已结束，请按时签到。'), active ? null : 'info');
      } else if (Number.isInteger(response?.code) && response.code > 0) {
        this.deps.rejected(booking);
        this.set({ active: false, phase: 'paused' }, '原预约已取消，重新预约失败：' + (response.message || response.code) + '。当前没有通过本计划保留座位。', 'error');
      } else {
        this.set({ active: false, phase: 'booking-unknown' }, '重约响应无法确认，请核实官网预约；不会重复提交。', 'error');
      }
    } catch (e) {
      if (!this.error) this.set({ active: false, phase: 'paused' },
        (this.job?.phase === 'cancelled' || this.job?.phase === 'booking' ? '原预约已取消。' : '') + e.message, 'error');
    } finally { this.busy = false; }
  }
  async check() {
    if (this.busy || !this.job) throw Error('请等待当前操作结束');
    this.busy = true;
    try {
      if (this.job.phase === 'booking-unknown') {
        await this.deps.reconcile();
        if (this.deps.unavailable()) throw Error('重约结果仍待核实，请使用预约结果核实面板');
        const saved = this.deps.resolvedBooking?.(this.job.replacement?.id);
        if (saved?.outcome === 'success') this.deps.restore(saved);
        this.set({ active: false, phase: 'stopped' }, '重约结果已处理，计划保持停止；如需继续请重新开启。');
        return;
      }
      const record = this.findRecord(await this.deps.records());
      if (!record || !['已取消', '已取消预约', '预约取消', '用户取消'].includes(String(record.status_name).trim())) {
        if (!record || (!waiting(record) && !signed(record)) || !matchesRecord(record, this.job.booking)) throw Error('官网记录尚不能确认，请打开官网核实后重试');
        this.deps.restore(this.job.booking);
      } else this.deps.cancelled(this.job.booking);
      this.set({ active: false, phase: 'stopped' }, '已核实官网当前记录。计划保持停止，没有自动重约。');
    } finally { this.busy = false; }
  }
}
module.exports = { Renewal, nextWindow, waiting, shanghaiDate };
