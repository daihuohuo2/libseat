(() => {
  const el = id => document.getElementById(id);
  let snapshot, draft, jobId, working = false, error = '', map, locating = false, locationAt = 0;
  try { draft = JSON.parse(localStorage.getItem('libseat-watch-target')); } catch (_) {}
  const labels = { watching:'盯座中', releasing:'正在换出', released:'正在换座', booking:'正在预约',
    'release-unknown':'释放待核实', 'booking-unknown':'预约待核实', finished:'已完成', paused:'已暂停', stopped:'已停止' };
  const unresolved = w => ['releasing','release-unknown','booking','booking-unknown'].includes(w?.phase);
  function redraw() { if (typeof lastMapData !== 'undefined' && lastMapData) renderSeatMap(lastMapData); }
  async function locate() {
    if (!/Android|iPhone|iPad/i.test(navigator.userAgent) || !navigator.geolocation) return {};
    return new Promise(resolve => navigator.geolocation.getCurrentPosition(p => resolve({ lat:p.coords.latitude, lng:p.coords.longitude }),
      () => resolve({}), { timeout:5000, maximumAge:10000, enableHighAccuracy:true }));
  }
  async function refreshLocation() {
    if (locating || document.hidden || Date.now() - locationAt < 30000) return;
    locating = true; locationAt = Date.now();
    try { const points = await locate(); if (Number.isFinite(points.lat)) await api('/api/watch-location', { points }); }
    catch (_) {} finally { locating = false; }
  }
  function render(s) {
    snapshot = s;
    const w = s.seatWatch || {}, locked = working || w.active || w.busy || unresolved(w) || !!w.error;
    if (w.target && w.id !== jobId) { jobId = w.id; draft = w.target; redraw(); }
    el('watchTarget').textContent = draft?.seat ? draft.seat + ' · ' + draft.area : '未设置目标';
    el('watchState').textContent = labels[w.phase] || '未开启';
    el('watchChoose').disabled = locked;
    el('watchStart').hidden = !!w.active || !!w.busy;
    el('watchStart').disabled = locked || !draft?.seatId || s.running || s.pendingBooking || s.storageError
      || s.renewal?.active || s.renewal?.busy || s.renewal?.error || s.renewal?.phase?.endsWith('unknown')
      || s.bookingManagement?.busy || s.bookingManagement?.checking || s.bookingManagement?.pendingAction;
    el('watchStop').hidden = !w.active && !w.busy;
    el('watchStop').disabled = working;
    el('watchCheck').hidden = !unresolved(w);
    el('watchCheck').disabled = working || w.busy;
    el('watchMessage').textContent = error || w.error || w.message || '';
    el('watchMessage').dataset.error = String(!!error || !!w.error || unresolved(w) || w.phase === 'paused');
    el('watchHistory').hidden = !w.events?.length;
    el('watchEvents').textContent = (w.events || []).slice().reverse().map(e => new Date(e.at).toLocaleTimeString('zh-CN', {hour12:false}) + ' ' + e.message).join('\n');
    if (locked) {
      el('btnStart').disabled = true; el('btnRenewalStart').disabled = true;
      for (const action of ['cancel','leave','checkout']) el('bookingAction-' + action).disabled = true;
    }
    if (w.active || w.busy || unresolved(w)) el('runState').textContent = labels[w.phase] || '正在盯座';
    if (w.active) refreshLocation();
    if (w.notice) RenewalUI.notice(w.notice);
  }
  async function action(name) {
    if (working) return;
    working = true; error = ''; if (snapshot) render(snapshot);
    try {
      let body = {};
      if (name === 'start') {
        if (!draft?.seatId) throw Error('请先指定一个座位');
        if (el('verifyOnly').checked) throw Error('请先关闭“仅观察空位”，盯座会实际预约或换座');
        const saved = await api('/api/config', { verifyOnly:false });
        if (!saved.ok) throw Error(saved.message);
        body = { areaId:draft.areaId, seatId:draft.seatId, points:await locate() };
      }
      const r = await api('/api/watch-' + name, body);
      if (!r.ok) throw Error(r.message || '操作失败');
    } catch (e) { error = e.message; }
    finally { working = false; await tick(); if (snapshot) render(snapshot); }
  }
  el('watchChoose').onclick = () => {
    if (!lastMapData || !mapReady || mapLoading) { error = '请先在地图选择区域并刷新座位'; if(snapshot) render(snapshot); return; }
    map = lastMapData;
    el('watchArea').textContent = map.area.name;
    el('watchSeatInput').value = draft?.areaId === String(map.area.id) ? draft.seat : '';
    el('watchInputError').textContent = '';
    el('watchSeatOptions').replaceChildren(...map.seats.map(s => { const option = document.createElement('option'); option.value = s.no; return option; }));
    el('watchDialog').showModal(); el('watchSeatInput').focus();
  };
  el('watchClose').onclick = () => el('watchDialog').close();
  el('watchSave').onclick = () => {
    try {
      const selected = AreaSeatPrefs.parse(el('watchSeatInput').value, map.seats);
      if (selected.length !== 1) throw Error('盯座只能指定一个座位');
      const seat = map.seats.find(s => s.no.toUpperCase() === selected[0]);
      draft = { areaId:String(map.area.id), seatId:String(seat.id), seat:seat.no, area:map.area.name };
      try { localStorage.setItem('libseat-watch-target', JSON.stringify(draft)); } catch (_) {}
      error = ''; el('watchDialog').close(); if (snapshot) render(snapshot); redraw();
    } catch(e) { el('watchInputError').textContent = e.message; }
  };
  el('watchStart').onclick = () => action('start');
  el('watchStop').onclick = () => action('stop');
  el('watchCheck').onclick = () => action('check');
  window.SeatWatchUI = { render, isTarget:(seat, data) => draft?.areaId === String(data.area.id) && draft?.seatId === String(seat.id) };
})();
