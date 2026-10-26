'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const today = now => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
const uncertain = phase => ['releasing', 'release-unknown', 'booking', 'booking-unknown'].includes(phase);
const signature = c => JSON.stringify(['dateMode', 'timeMode', 'startTime', 'endTime', 'axisStart', 'axisEnd', 'axisStep', 'axisMaxMin', 'verifyOnly'].map(k => c[k]));

// One exact target. Releasing and booking each have a durable intent, with no retry
// of a mutation whose result is unknown. No credentials or coordinates are persisted.
class SeatWatch {
  constructor(file, deps, now = () => Date.now()) {
    this.file = file; this.deps = deps; this.now = now;
    this.job = null; this.error = ''; this.busy = false; this.generation = 0;
    this.sessionToken = ''; this.nextAt = 0;
    try {
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data.version !== 1 || data.job && (!data.job.id || !data.job.target?.seatId || !data.job.target?.areaId
          || !data.job.date || !Array.isArray(data.job.events) || typeof data.job.active !== 'boolean')) throw Error('记录格式无效');
        this.job = data.job;
        if (this.job && (this.job.active || uncertain(this.job.phase) || this.job.phase === 'released')) {
          const phase = ['releasing', 'release-unknown'].includes(this.job.phase) ? 'release-unknown'
            : ['booking', 'booking-unknown'].includes(this.job.phase) ? 'booking-unknown' : 'paused';
          this.set({ active: false, phase, notice: null }, phase.endsWith('unknown') ? '程序退出时有请求待确认，请核实结果，未重复发送。'
            : this.job.phase === 'released' ? '原座位已释放，程序重启后未继续预约。请确认后重新开启盯座。' : '盯座已暂停，请确认目标后重新开启。');
        }
      }
    } catch (e) { this.error = '无法读取或保存盯座记录：' + e.message; }
  }
  status() { return { ...this.job, busy: this.busy, error: this.error }; }
  blocks() { return !!(this.error || this.busy || this.job?.active || uncertain(this.job?.phase)); }
  save(job) {
    if (this.error) throw Error(this.error);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const fd = fs.openSync(this.file + '.tmp', 'w');
      try { fs.writeFileSync(fd, JSON.stringify({ version: 1, job }, null, 2)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(this.file + '.tmp', this.file); this.job = job;
    } catch (e) { this.error = '保存盯座记录失败：' + e.message; throw Error(this.error); }
  }
  set(fields, message, notify = false) {
    const next = { ...this.job, ...fields };
    if (message) {
      next.message = message;
      if (message !== this.job?.message) next.events = [...(next.events || []), { at: this.now(), message }].slice(-30);
      if (notify) next.notice = { id: crypto.randomUUID(), title: '盯座状态', message, level: 'error' };
    }
    this.save(next);
  }
  async start(input) {
    if (this.blocks() || this.deps.unavailable()) throw Error('请先停止其他任务并处理待核实的预约');
    const cfg = this.deps.config();
    if (cfg.verifyOnly !== false) throw Error('请先关闭“仅观察空位”，盯座会实际预约或换座');
    if (cfg.dateMode !== 'today') throw Error('盯座换座仅支持今天，请先把日期切换为今天');
    if (!cfg.token) throw Error('请先登录');
    this.busy = true;
    const generation = ++this.generation, date = today(this.now());
    try {
      const result = await this.deps.inspect(input, cfg, date);
      if (generation !== this.generation || cfg.token !== this.deps.config().token || signature(cfg) !== signature(this.deps.config())) throw Error('任务或登录设置已变化，请重新开启');
      this.save({ id: crypto.randomUUID(), target: result.target, date, settings: signature(cfg), active: true,
        phase: 'watching', events: [], notice: { id: crypto.randomUUID(), event:'started', level:'info', title:'盯座任务正在运行',
          message:'正在盯 ' + result.target.seat + ' · ' + result.target.area + '。目标空闲后按当前预约状态自动预约或换座。' },
        message: '正在盯 ' + result.target.seat + '，只预约这个座位。' });
      this.sessionToken = cfg.token; this.nextAt = 0;
    } finally { this.busy = false; }
  }
  stop() {
    this.generation++;
    if (!this.job) return;
    const phase = uncertain(this.job.phase) ? this.job.phase : 'stopped';
    this.set({ active: false, phase, notice: this.job.notice?.event === 'started' ? null : this.job.notice }, uncertain(phase) ? '已停止后续操作，正在确认已发出请求的结果。'
      : '已停止盯座。停止本身不会取消或签离当前预约。');
  }
  guard(generation, cfg) {
    if (!this.job?.active || generation !== this.generation) throw Error('盯座已停止');
    if (today(this.now()) !== this.job.date) throw Error('已跨日，盯座已停止');
    if (cfg.token !== this.deps.config().token || this.sessionToken !== cfg.token) throw Error('登录状态已变化，请确认目标后重新开启盯座');
    if (signature(this.deps.config()) !== this.job.settings) throw Error('预约设置已变化，请重新开启盯座');
  }
  async tick() {
    if (!this.job?.active || this.busy || this.error || this.now() < this.nextAt || this.deps.unavailable()) return;
    this.busy = true;
    const generation = this.generation, cfg = this.deps.config();
    let released = false, attemptedBooking = null;
    try {
      this.guard(generation, cfg);
      let candidate = await this.deps.inspect(this.job.target, cfg, this.job.date);
      this.guard(generation, cfg);
      const current = await this.deps.current(cfg, this.job.date);
      this.guard(generation, cfg);
      if (current) this.deps.adopt(current.booking);
      if (current && String(current.booking.seatId) === this.job.target.seatId && String(current.booking.areaId) === this.job.target.areaId) {
        this.set({ active: false, phase: 'finished', notice: null }, '当前已是目标座位，未取消或签离。'); return;
      }
      if (!candidate.available) {
        this.set({}, '正在盯 ' + this.job.target.seat + '：暂不可约，保留当前座位。'); return;
      }
      if (current) {
        const action = current.state === 'reserved' ? 'cancel' : ['signed', 'away'].includes(current.state) ? 'checkout' : '';
        if (!action || !current.actions.includes(action)) throw Error('官网当前状态不允许取消或完全签离，已保留当前座位');
        // Recheck the exact target after reading current reservation/status/permissions.
        candidate = await this.deps.inspect(this.job.target, cfg, this.job.date);
        this.guard(generation, cfg);
        if (!candidate.available) { this.set({}, '目标刚被占用，保留当前座位，继续盯座。'); return; }
        const inspectedAt = this.now();
        this.set({ phase: 'releasing', source: current.booking, releaseAction: action }, action === 'cancel' ? '目标可约，正在取消原预约…' : '目标可约，正在完全签离原座位…');
        try {
          await this.deps.release(current.booking, action, () => {
            this.guard(generation, cfg);
            if (this.now() - inspectedAt > 30000) throw Error('座位查询已过时，未释放原座位，请重新开启盯座');
            this.deps.validate(candidate, cfg, this.job.date);
          });
        } catch (e) {
          const unknown = this.deps.pending().action;
          this.set({ active: false, phase: unknown ? 'release-unknown' : 'paused' }, unknown
            ? '取消或完全签离结果待核实，未预约目标、未重复释放，请点击“核实结果”。' : e.message, true);
          return;
        }
        released = true;
        this.set({ phase: 'released' }, '原座位已释放，正在预约指定座位…');
        this.guard(generation, cfg);
      }
      // A fresh window is needed after release; never submit a rounded time from an earlier minute.
      candidate = await this.deps.inspect(this.job.target, cfg, this.job.date);
      this.guard(generation, cfg);
      if (!candidate.available) {
        this.set({ phase: 'watching' }, (released ? '原座位已释放；' : '') + '目标刚被占用，继续只盯这个座位。', released); return;
      }
      const rule = candidate.rule;
      attemptedBooking = { id: crypto.randomUUID(), ...this.job.target, date: this.job.date,
        startTime: rule.start, endTime: rule.end, reserveType: rule.reserveType, segment: rule.segment,
        bookedAt: new Date(this.now()).toISOString() };
      const booking = attemptedBooking;
      this.set({ phase: 'booking', attempt: booking }, '正在预约 ' + booking.seat + '…');
      let response;
      try {
        response = await this.deps.reserve(booking, candidate, cfg, () => {
          this.guard(generation, cfg);
          this.deps.validate(candidate, cfg, this.job.date);
        });
      } catch (e) {
        if (e.beforeSubmission) throw e;
        this.set({ active: false, phase: 'booking-unknown' }, '目标预约结果待核实，已暂停，未重复预约。请点击“核实结果”。', true); return;
      }
      if (!response || !Number.isInteger(response.code) || response.code < 0) {
        this.set({ active: false, phase: 'booking-unknown' }, '目标预约响应无法确认，已暂停，请核实结果。', true); return;
      }
      if (response.code === 0) {
        this.deps.booked(booking);
        this.set({ active: false, phase: 'finished', notice: null }, '已预约指定座位 ' + booking.seat + '。请按官网要求重新签到。');
      } else {
        this.deps.rejected(booking);
        const retry = response.code === 409 && this.job.active && generation === this.generation;
        this.set({ active: retry, phase: retry ? 'watching' : 'paused' }, (released ? '原座位已释放；' : '')
          + '目标预约未成功：' + (response.message || '官网拒绝') + (retry ? '。继续只盯目标座位。' : '。请核实后重新开启。'), true);
      }
    } catch (e) {
      // Unknown reservation writes are represented by BookingStore even if a later journal write fails.
      const phase = this.deps.pending().booking && attemptedBooking ? 'booking-unknown' : 'paused';
      if (!this.error) this.set({ active: false, phase }, (released ? '原座位已释放；' : '') + e.message, true);
    } finally {
      this.nextAt = this.now() + Math.max(2, Math.min(120, Number(cfg.interval) || 6)) * 1000;
      this.busy = false;
    }
  }
  async check() {
    if (this.busy) throw Error('正在处理，请稍后核实');
    if (!uncertain(this.job?.phase)) return;
    this.busy = true;
    try {
      if (['booking', 'booking-unknown'].includes(this.job.phase)) {
        await this.deps.reconcileBooking();
        if (this.deps.pending().booking) return;
        const success = this.deps.resolved(this.job.attempt?.id)?.outcome === 'success';
        this.set({ active: false, phase: success ? 'finished' : 'paused', notice: null }, success ? '已确认指定座位预约成功。' : '已核实预约结果，请确认后重新开启盯座。');
      } else {
        await this.deps.reconcileRelease();
        if (this.deps.pending().action) return;
        const previous = this.deps.resolved(this.job.source?.id);
        const freed = ['cancelled', 'completed'].includes(previous?.outcome);
        this.set({ active: false, phase: 'paused', notice: null }, freed ? '已确认原座位释放；未继续预约，请重新开启盯座。'
          : '原座位尚未确认释放，盯座保持暂停，请在官网核实后重新开启。');
      }
    } finally { this.busy = false; }
  }
}
module.exports = { SeatWatch };
