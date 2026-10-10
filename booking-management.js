'use strict';

const LABELS = { reserved: '预约成功', signed: '已签到', away: '临时签离中', cancelled: '已取消预约', completed: '已结束使用', unknown: '状态待核实' };
const ACTIONS = { cancel: '取消预约', leave: '临时签离', checkout: '完全签离' };
const TERMINAL = ['cancelled', 'completed'];
const minute = v => String(v || '').replace('T', ' ').slice(0, 16);

function findBooking(records, booking) {
  if (booking.officialId) return records.find(r => String(r.id) === String(booking.officialId));
  const found = records.filter(r => !r.wait_id && (booking.seatId && String(r.seat_id || r.space || r.space_id) === String(booking.seatId)
    || String(r.name || r.no || r.spaceName) === booking.seat && String(r.nameMerge || r.areaName) === booking.area)
    && minute(r.beginTime) === booking.date + ' ' + booking.startTime);
  // Cancelling and rebooking within one minute leaves multiple matching rows.
  // A unique live record identifies the replacement; multiple live rows remain ambiguous.
  const live = found.filter(r => !['6', '4', '8', '12', '34', '35'].includes(String(r.status)));
  return live.length === 1 ? live[0] : live.length === 0 && found.length === 1 ? found[0] : null;
}

function describe(record, current) {
  const code = String(record.status), name = String(record.status_name || record.statusname || '');
  let state = 'unknown';
  if (code === '6') state = 'cancelled';
  else if (['4', '8', '12', '34', '35'].includes(code)) state = 'completed';
  else if (String(current?.flag_leave) === '1' || /暂离|临时离开|临时签离/.test(name)) state = 'away';
  else if (String(current?.flag_out) === '1' || ['3', '11', '33'].includes(code) || /已签到|使用中/.test(name)) state = 'signed';
  else if (['2', '9'].includes(code)) state = 'reserved';
  const actions = [];
  if (state === 'reserved' && String(record.oksign) === '1' && !record.wait_id) actions.push('cancel');
  // These are the same flags used by the official AppointmentItem component.
  if (state === 'signed' && String(current?.flag_out) === '1' && String(current?.SYS_WEB_MYYUYUE_RIGHTBACK) === '1') actions.push('leave');
  if (['signed', 'away'].includes(state) && String(current?.SYS_WEB_MYYUYUE_LEAVE) === '1'
    && [current?.flag_out, current?.flag_leave].some(v => String(v) === '1')) actions.push('checkout');
  return { state, label: LABELS[state], actions, tip: current?.seat_tips_zh || '' };
}

class BookingManagement {
  constructor(store, deps) {
    this.store = store; this.deps = deps; this.busy = false; this.checking = false;
    this.view = null; this.lastAttempt = 0; this.refreshPromise = null;
  }
  blocked() { return this.busy || this.checking || !!this.store.data.pendingAction; }
  status() {
    const booking = this.deps.booking();
    const view = this.view?.bookingId === booking?.id ? this.view : {
      bookingId: booking?.id, state: booking?.remoteState || 'unknown', label: LABELS[booking?.remoteState] || '正在核实预约状态', actions: [], message: ''
    };
    return { ...view, busy: this.busy, checking: this.checking, pendingAction: this.store.data.pendingAction || null };
  }
  persist(booking, fields, pendingAction = this.store.data.pendingAction) {
    const updated = { ...booking, ...fields };
    this.store.write({ ...this.store.data, pendingAction,
      history: [updated, ...this.store.data.history.filter(b => b.id !== updated.id)].slice(0, 50) });
    this.deps.update(updated);
    return updated;
  }
  async read(booking) {
    const records = await this.deps.records();
    const record = findBooking(records, booking);
    if (!record?.id) throw Error('官网暂未找到唯一匹配的预约，请稍后刷新或在官网核实');
    let current;
    if (!['6', '4', '8', '12', '34', '35'].includes(String(record.status))) {
      const rows = await this.deps.current();
      current = rows.find(r => String(r.id) === String(record.id) && String(r.type) === '1');
    }
    return { record, ...describe(record, current) };
  }
  apply(booking, result) {
    if (TERMINAL.includes(booking.remoteState) && !TERMINAL.includes(result.state)) return;
    const pending = this.store.data.pendingAction;
    const resolved = pending && (TERMINAL.includes(result.state) || pending.action === 'leave' && result.state === 'away');
    const outcome = result.state === 'cancelled' ? 'cancelled' : result.state === 'completed' ? 'completed' : booking.outcome || 'success';
    this.persist(booking, { officialId: String(result.record.id), remoteState: result.state, outcome }, resolved ? null : pending);
    this.view = { bookingId: booking.id, state: result.state, label: result.label, actions: result.actions,
      tip: result.tip, checkedAt: Date.now(), message: pending && !resolved ? '上次操作结果仍待确认，未重复发送。请稍后刷新或到官网核实。' : '' };
  }
  refresh(force = false) {
    if (this.refreshPromise) return this.refreshPromise;
    const booking = this.deps.booking();
    if (!booking || this.busy || this.deps.unavailable() || !force && Date.now() - this.lastAttempt < 30000) return Promise.resolve(this.status());
    this.checking = true; this.lastAttempt = Date.now();
    this.refreshPromise = (async () => {
      try {
        const result = await this.read(booking);
        if (this.deps.booking()?.id === booking.id) this.apply(booking, result);
      } catch (e) {
        this.view = { ...this.status(), bookingId: booking.id, actions: [], message: '刷新失败：' + e.message };
      } finally { this.checking = false; this.refreshPromise = null; }
      return this.status();
    })();
    return this.refreshPromise;
  }
  async act({ id, action, points }) {
    if (!ACTIONS[action]) throw Error('不支持的预约操作');
    if (this.blocked() || this.deps.unavailable()) throw Error('预约操作进行中或结果待核实，请稍后刷新');
    let booking = this.deps.booking();
    if (!booking || booking.id !== id || TERMINAL.includes(booking.remoteState)) throw Error('预约已变化，请刷新后再操作');
    this.busy = true;
    let sent = false;
    const token = this.deps.token();
    try {
      this.deps.stopRenewal();
      const result = await this.read(booking);
      if (this.deps.booking()?.id !== id) throw Error('预约已变化，请刷新后再操作');
      this.apply(booking, result); booking = this.deps.booking();
      if (!result.actions.includes(action)) throw Error('官网当前状态不允许' + ACTIONS[action] + '，已更新预约信息');
      const body = { id: String(result.record.id) };
      if (action !== 'cancel') {
        body.points = {};
        if (points && Number.isFinite(points.lat) && Number.isFinite(points.lng)
          && Math.abs(points.lat) <= 90 && Math.abs(points.lng) <= 180) {
          body.points = { lat: points.lat, lng: points.lng, time: Math.floor(Date.now() / 1000) };
        }
      }
      const response = await this.deps.send(action, body, () => {
        if (this.deps.booking()?.id !== id || this.deps.token() !== token || this.deps.unavailable()) throw Error('预约或登录状态已变化，请刷新后重试');
        this.store.write({ ...this.store.data, pendingAction: { bookingId: id, recordId: body.id, action, startedAt: Date.now() } });
        sent = true;
      });
      if (!response || typeof response.code !== 'number') throw Error('官网响应无法确认');
      if (response.code !== 0) {
        this.store.write({ ...this.store.data, pendingAction: null }); sent = false;
        throw Error(response.message || response.msg || ACTIONS[action] + '失败');
      }
      const state = { cancel: 'cancelled', leave: 'away', checkout: 'completed' }[action];
      this.persist(booking, { remoteState: state, outcome: state === 'away' ? 'success' : state }, null);
      this.view = { bookingId: id, state, label: LABELS[state], actions: state === 'away' ? result.actions.filter(a => a === 'checkout') : [], checkedAt: Date.now(),
        message: ACTIONS[action] + '成功。' + (state === 'away' ? '请按官网规定的时限返回并签到。' : '座位已释放。') };
      this.lastAttempt = Date.now();
      return this.status();
    } catch (e) {
      this.view = { ...this.status(), bookingId: id, message: sent ? ACTIONS[action] + '结果待确认，请刷新核实，未重复发送。' : e.message };
      throw Error(this.view.message);
    } finally { this.busy = false; }
  }
}
module.exports = { BookingManagement, findBooking, describe };
