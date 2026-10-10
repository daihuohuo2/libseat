(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const dialog = el('seatPrefsDialog');
  let areaId = '', seats = [], selected = new Set(), generation = 0, loading = false, saving = false, supported = true;
  const status = message => { el('seatPrefMessage').textContent = message; };
  function render() {
    const prefer = el('seatPrefMode').value === 'prefer';
    el('seatPrefChoices').hidden = !prefer;
    el('seatPrefSave').disabled = saving || loading || !supported;
    el('seatPrefSave').textContent = saving ? '正在保存…' : '保存偏好';
    el('seatPrefMode').disabled = saving || loading;
    el('seatPrefClose').disabled = saving;
    el('seatPrefInputs').disabled = loading || saving;
    el('seatPrefCount').textContent = '已选 ' + selected.size + ' 个优先座位';
    el('seatPrefSelection').textContent = [...selected].join('、') || '尚未选择座位';
    const fragment = document.createDocumentFragment();
    seats.forEach(seat => {
      const no = String(seat.no).toUpperCase();
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.no = no;
      button.className = 'seat-pref-option';
      button.textContent = no.match(/\d+$/)?.[0] || no;
      button.setAttribute('aria-pressed', String(selected.has(no)));
      button.setAttribute('aria-label', no + ' · ' + (seat.statusName || '状态未知'));
      button.title = no + ' · ' + (seat.statusName || '状态未知');
      button.disabled = saving || loading;
      button.onclick = () => { selected.has(no) ? selected.delete(no) : selected.add(no); status(''); render(); };
      fragment.append(button);
    });
    el('seatPrefGrid').replaceChildren(fragment);
  }
  async function open(id) {
    if (saving || !id) return;
    areaId = String(id); seats = []; loading = true; supported = true;
    const current = ++generation;
    const pref = AreaSeatPrefs.normalize(cfgCache.areaSeatPrefs?.[areaId]);
    selected = new Set(pref.seats);
    el('seatPrefMode').value = pref.mode;
    el('seatPrefNumbers').value = '';
    el('seatPrefArea').textContent = cfgCache.areaNames?.[areaId] || areaId;
    status('正在加载本区域座位…'); render();
    if (!dialog.open) dialog.showModal();
    try {
      const cfg = await api('/api/config');
      if (current !== generation) return;
      if (!cfg.ok || !Object.hasOwn(cfg.config, 'areaSeatPrefs')) {
        supported = false; throw Error('后台版本较旧，请从托盘退出并重启座位助手后再设置偏好');
      }
      const latest = AreaSeatPrefs.normalize(cfg.config.areaSeatPrefs?.[areaId]);
      selected = new Set(latest.seats); el('seatPrefMode').value = latest.mode;
      const result = await api('/api/seats', { areaId });
      if (current !== generation) return;
      if (!result.ok) throw Error(result.message || '座位列表加载失败');
      seats = result.seats || [];
      el('seatPrefArea').textContent = result.area?.name || cfgCache.areaNames?.[areaId] || areaId;
      status(seats.length ? '' : '本区域暂未返回座位，可稍后重新打开。');
    } catch (error) {
      if (current !== generation) return;
      status(error.message);
    } finally { if (current === generation) { loading = false; render(); } }
  }
  el('seatPrefMode').onchange = () => { status(''); render(); };
  el('seatPrefClose').onclick = () => dialog.close();
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => { generation++; });
  el('seatPrefAdd').onclick = () => {
    try {
      const added = AreaSeatPrefs.parse(el('seatPrefNumbers').value, seats);
      added.forEach(no => selected.add(no));
      el('seatPrefNumbers').value = ''; status('已加入所填编号，可继续选择。'); render();
    } catch (error) { status(error.message); }
  };
  el('seatPrefNumbers').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); el('seatPrefAdd').click(); }
  });
  el('seatPrefClear').onclick = () => { selected.clear(); status(''); render(); };
  el('seatPrefSave').onclick = async () => {
    if (saving || loading || !supported) return;
    try {
      if (el('seatPrefMode').value === 'prefer' && el('seatPrefNumbers').value.trim()) {
        AreaSeatPrefs.parse(el('seatPrefNumbers').value, seats).forEach(no => selected.add(no));
      }
      const preference = AreaSeatPrefs.normalize({ mode: el('seatPrefMode').value, seats: [...selected] });
      saving = true; status(''); render();
      const result = await api('/api/area-seat-preferences', { areaId, preference });
      if (!result.ok) throw Error(result.message || '保存失败');
      cfgCache.areaSeatPrefs = result.config.areaSeatPrefs;
      renderGrabList();
      const chosen = (cfgCache.preferAreas || []).map(String).includes(areaId);
      el('planHint').textContent = '已保存该区域座位偏好：' + AreaSeatPrefs.summary(preference)
        + (chosen ? '。保存方案可供下次使用。' : '。请把该区域加入抢选名单后使用。');
      dialog.close();
    } catch (error) { status(error.message); }
    finally { saving = false; render(); }
  };
  el('btnAreaSeatPrefs').onclick = () => {
    const id = el('selArea').value || curArea;
    if (!id) { el('planHint').textContent = '请先选择一个区域'; return; }
    open(id);
  };
  window.AreaSeatPrefsUI = { open };
})();
