(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  let snapshot = null, working = false, feedback = '', feedbackBooking = '';
  const names = { cancel: '取消预约', leave: '临时签离', checkout: '完全签离' };
  const hints = {
    reserved: '请按预约系统要求及时到馆签到。取消预约后，座位将释放。',
    signed: '临时签离后须按官网时限返回；完全签离会结束本次使用并释放座位。',
    away: '你已临时签离，请按官网规定的时限返回并签到。完全签离会释放座位。',
    cancelled: '本次预约已取消，座位已释放。', completed: '本次使用已结束，座位已释放。',
    unknown: '正在核实官网预约状态，核实后显示可用操作。'
  };
  async function request(route, body) {
    const r = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
    if (!r.ok) throw Error('本地服务响应异常，请刷新核实操作结果');
    return r.json();
  }
  function render(s) {
    snapshot = s;
    const b = s.booking, m = s.bookingManagement;
    if (!b) return;
    if (feedbackBooking !== b.id) { feedback = ''; feedbackBooking = b.id; }
    const kind = m?.state || 'unknown', signed = ['signed', 'away'].includes(kind);
    $('bookingSummaryTitle').textContent = m?.label || '预约成功';
    $('btnBookingDetails').textContent = signed ? '查看位置信息' : '查看预约结果';
    $('bookingTitle').textContent = signed ? '位置信息' : kind === 'cancelled' ? '预约已取消' : kind === 'completed' ? '本次使用已结束' : '抢到座位了！';
    $('bookingStatus').textContent = m?.label || '';
    $('bookingHint').textContent = (m?.tip ? m.tip + '。' : '') + (hints[kind] || hints.unknown);
    $('bookingActionMessage').textContent = feedback || m?.message || (m?.checking ? '正在刷新官网状态…' : '');
    const locked = working || m?.busy || m?.checking || !!m?.pendingAction;
    for (const [action, name] of Object.entries(names)) {
      const button = $('bookingAction-' + action);
      button.hidden = !m?.actions?.includes(action);
      button.disabled = locked; button.textContent = name;
    }
    $('bookingRefresh').disabled = working || m?.busy || m?.checking;
    if (m && (m.busy || m.pendingAction)) $('runState').textContent = m.busy ? '正在处理预约' : '操作待核实';
    else if (signed) $('runState').textContent = m.label;
    $('btnStart').disabled = $('btnStart').disabled || !!locked;
  }
  async function refresh() {
    if (working || !snapshot?.booking) return;
    working = true; feedback = '正在刷新官网状态…'; render(snapshot);
    try {
      const r = await request('/api/booking-state', {});
      feedback = r.ok ? '' : r.message;
      if (r.bookingManagement) snapshot.bookingManagement = r.bookingManagement;
    } catch (e) { feedback = e.message; }
    finally { working = false; render(snapshot); }
  }
  async function locationPoints() {
    // Match the official desktop flow (empty points); mobile can use real browser coordinates.
    if (!/Android|iPhone|iPad/i.test(navigator.userAgent) || !navigator.geolocation) return {};
    return new Promise(resolve => navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }), () => resolve({}),
      { timeout: 5000, maximumAge: 0, enableHighAccuracy: true }));
  }
  async function act(action) {
    if (working || !snapshot?.booking) return;
    const booking = snapshot.booking;
    const effect = action === 'leave' ? '将临时保留座位，请按官网时限返回并签到。' : '座位将释放。';
    if (!window.confirm('确认' + names[action] + '？\n' + booking.area + ' · ' + booking.seat + '\n' + effect)) return;
    working = true; feedback = '正在' + names[action] + '…'; render(snapshot);
    try {
      const r = await request('/api/booking-action', { id: booking.id, action, points: action === 'cancel' ? undefined : await locationPoints() });
      feedback = r.ok ? '' : r.message;
      if (r.bookingManagement) snapshot.bookingManagement = r.bookingManagement;
      if (typeof loadBookingHistory === 'function') loadBookingHistory();
    } catch (e) { feedback = '暂未收到操作结果，请点击“刷新状态”核实：' + e.message; }
    finally { working = false; render(snapshot); if (typeof tick === 'function') tick(); }
  }
  for (const action of Object.keys(names)) $('bookingAction-' + action).onclick = () => act(action);
  $('bookingRefresh').onclick = refresh;
  window.BookingManagementUI = { render, refresh };
}());
