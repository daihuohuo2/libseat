(() => {
  'use strict';
  const el = id => document.getElementById(id);
  let pending = false;
  let actionError = '';
  let latestStatus;
  const seen = new Set();
  let intervalReady = false;
  function showInterval() {
    const n = Number(el('renewalInterval').value);
    el('renewalIntervalValue').textContent = n + ' 分钟';
    el('renewalInterval').setAttribute('aria-valuetext', n + ' 分钟');
    el('renewalIntervalHint').hidden = n < 58;
  }
  const labels = { armed: '等待预约', waiting: '计时中', cancelling: '正在取消', cancelled: '已取消',
    booking: '正在重约', paused: '已暂停', stopped: '已停止', finished: '已结束',
    'cancel-unknown': '取消待核实', 'booking-unknown': '重约待核实' };
  const time = ms => new Date(ms).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  function notice(n) {
    if (!n || seen.has(n.id)) return;
    seen.add(n.id);
    const key = 'libseat-renewal-' + n.id;
    try { if (localStorage.getItem(key)) return; localStorage.setItem(key, '1'); } catch (_) {}
    const dialog = document.createElement('dialog');
    const title = document.createElement('h2'); title.textContent = n.title;
    const content = document.createElement('p'); content.textContent = n.message; content.style.margin = '20px 0';
    const button = document.createElement('button'); button.textContent = '知道了'; button.autofocus = true;
    button.onclick = () => dialog.close();
    dialog.append(title, content, button); document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove(), { once: true }); dialog.showModal();
    if (!window.seatAssistant?.nativeNotifications && 'Notification' in window && Notification.permission === 'granted') {
      try { const notification = new Notification(n.title, { body: n.message, tag: n.id, requireInteraction: true });
        notification.onclick = () => { window.focus(); notification.close(); }; } catch (_) {}
    }
  }
  function render(status) {
    latestStatus = status;
    const job = status.renewal;
    if (!job) {
      el('btnRenewalStart').disabled = true;
      el('renewalStatus').textContent = '请先重启座位助手后台，加载定时重约功能。';
      return;
    }
    const unresolved = ['cancel-unknown', 'booking-unknown'].includes(job.phase);
    const historical = !job.active && !job.busy && !job.error && !unresolved
      && ['stopped', 'finished'].includes(job.phase)
      && (!status.success || job.booking?.id !== status.booking?.id);
    el('renewalState').textContent = historical ? '未开启' : labels[job.phase] || '未开启';
    el('btnRenewalStart').disabled = pending || job.busy || job.active || unresolved || !!job.error || status.running || !!status.pendingBooking
      || status.bookingManagement?.busy || status.bookingManagement?.checking || !!status.bookingManagement?.pendingAction;
    el('btnRenewalStop').hidden = !job.active && !job.busy;
    el('btnRenewalStop').disabled = pending;
    el('btnRenewalCheck').hidden = !unresolved;
    el('btnRenewalCheck').disabled = pending || job.busy;
    el('renewalMode').disabled = el('renewalArrival').disabled = el('renewalInterval').disabled = pending || job.active || job.busy;
    if (job.active || !intervalReady) {
      let saved;
      try { saved = Number(localStorage.getItem('libseat-renewal-interval')); } catch (_) {}
      el('renewalInterval').value = job.intervalMinutes || (Number.isInteger(saved) && saved >= 30 && saved <= 59 ? saved : 50);
      intervalReady = true; showInterval();
    }
    if (job.active && job.arrivalAt) {
      el('renewalArrival').value = new Date(job.arrivalAt + 8 * 3600000).toISOString().slice(11, 16);
      el('renewalMode').value = job.phase === 'armed' ? 'next' : 'current';
    }
    if (!pending) el('renewalStatus').textContent = actionError || (historical ? '' : job.error || job.message || '');
    el('renewalStatus').dataset.error = String(!!actionError || !!job.error || unresolved || job.phase === 'paused');
    const next = job.active && job.nextAt ? (job.nextAt < job.arrivalAt ? '下次重约：' + time(job.nextAt) : '到馆前无需再次重约') : '';
    el('renewalTiming').textContent = !historical && job.arrivalAt ? [job.booking ? '座位：' + job.booking.seat : '等待成功预约', '间隔：' + (job.intervalMinutes || 50) + ' 分钟', '到馆：' + time(job.arrivalAt), next, '已重约 ' + (job.cycles || 0) + ' 次'].filter(Boolean).join(' · ') : '';
    el('renewalEvents').textContent = job.events?.length ? job.events.slice().reverse().map(e => time(e.at) + ' ' + e.message).join('\n') : '暂无记录。';
    notice(job.notice);
  }
  async function action(name, body = {}) {
    pending = true;
    actionError = '';
    el('btnRenewalStart').disabled = el('btnRenewalCheck').disabled = true;
    el('renewalInterval').disabled = true;
    el('renewalStatus').textContent = '正在处理，请稍候…';
    try {
      const response = await fetch('/api/renewal/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
      if (!response.ok) throw Error('服务响应异常，请确认已重启后台');
      const result = await response.json();
      if (!result.ok) throw Error(result.message);
      pending = false;
      await window.tick();
    } catch (e) {
      actionError = e.message;
      el('renewalStatus').textContent = actionError;
      el('renewalStatus').dataset.error = 'true';
    } finally { pending = false; if (latestStatus) render(latestStatus); }
  }
  document.addEventListener('DOMContentLoaded', () => {
    el('renewalInterval').oninput = () => {
      intervalReady = true; showInterval();
      try { localStorage.setItem('libseat-renewal-interval', el('renewalInterval').value); } catch (_) {}
    };
    el('btnRenewalStart').onclick = () => {
      const arrival = el('renewalArrival').value;
      if (!arrival) { el('renewalArrival').reportValidity(); return; }
      const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      action('start', { arrivalAt: today + 'T' + arrival + ':00+08:00', mode: el('renewalMode').value, intervalMinutes: Number(el('renewalInterval').value) });
    };
    el('btnRenewalStop').onclick = () => action('stop');
    el('btnRenewalCheck').onclick = () => action('check');
  });
  window.RenewalUI = { render };
})();
