/* Warm study presentation; reservation requests stay in the existing application. */
(() => {
  // Keep reservation history with the other records while preserving its handlers.
  if ($('bookingHistory')) $('logsPanel').insertBefore($('bookingHistory'), $('logs'));
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function showPanel(id, focus = false) {
    tabs.forEach(tab => {
      const active = tab.dataset.panel === id;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      document.getElementById(tab.dataset.panel).hidden = !active;
      if (active && focus) tab.focus();
    });
    if (id === 'plansPanel') renderSavedPlans();
    if (id === 'bookingPanel' && lastMapData) requestAnimationFrame(() => renderSeatMap(lastMapData));
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => showPanel(tab.dataset.panel));
    tab.addEventListener('keydown', e => {
      let next;
      if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
      if (e.key === 'ArrowLeft') next = (i + tabs.length - 1) % tabs.length;
      if (e.key === 'Home') next = 0;
      if (e.key === 'End') next = tabs.length - 1;
      if (next !== undefined) { e.preventDefault(); showPanel(tabs[next].dataset.panel, true); }
    });
  });
  $('btnDetails').onclick = () => {
    const open = $('detailsPanel').hidden;
    $('detailsPanel').hidden = !open;
    $('btnDetails').setAttribute('aria-expanded', String(open));
    $('btnDetails').textContent = open ? '收起配置' : '详细配置';
  };
  $('btnAccount').onclick = () => $('accountDialog').showModal();
  $('btnCloseAccount').onclick = () => $('accountDialog').close();
  $('todayLabel').textContent = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  $('todayLabel').dateTime = new Date().toLocaleDateString('en-CA');
  const syncMode = () => {
    if ($('runState').textContent !== '运行中') $('btnStart').textContent = $('verifyOnly').checked ? '开始观察空位' : '开始抢座';
  };
  $('verifyOnly').addEventListener('change', syncMode);
  $('interval').addEventListener('change', async () => {
    const value = Math.min(120, Math.max(3, Number($('interval').value) || 6));
    $('interval').value = value;
    try { await api('/api/config', { interval: value }); }
    catch (e) { $('planHint').textContent = '配置保存失败：' + e.message; }
  });
  function renderSavedPlans() {
    const box = $('savedPlans');
    box.replaceChildren();
    if (!plans.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-plans';
      empty.textContent = '还没有保存的方案。选好常去的区域，就可以保存下来。';
      const button = document.createElement('button');
      button.textContent = '去选择区域';
      button.onclick = () => showPanel('bookingPanel');
      empty.append(button); box.append(empty); return;
    }
    plans.forEach(plan => {
      const row = document.createElement('div'); row.className = 'saved-plan';
      const text = document.createElement('div');
      const title = document.createElement('h3'); title.textContent = plan.name || '未命名方案';
      const description = document.createElement('p');
      description.textContent = (plan.areas || []).map(id => (cfgCache.areaNames || {})[id] || id).join('、') || '尚未设置区域';
      text.append(title, description);
      const button = document.createElement('button');
      button.className = 'outline'; button.textContent = String(plan.id) === String(activePlanId) ? '已使用 · 查看预约' : '使用方案';
      button.onclick = async () => {
        button.disabled = true;
        try { await applyPlan(String(plan.id)); showPanel('bookingPanel'); }
        catch (e) { $('plansFeedback').textContent = '套用失败：' + e.message; }
        finally { button.disabled = false; }
      };
      row.append(text, button); box.append(row);
    });
  }
  new MutationObserver(() => { if (!$('plansPanel').hidden) renderSavedPlans(); }).observe($('planSelect'), { childList: true, subtree: true });
  new MutationObserver(() => { $('plansFeedback').textContent = $('planHint').textContent; }).observe($('planHint'), { childList: true, subtree: true, characterData: true });
  let resizeFrame;
  new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      if (lastMapData && !$('bookingPanel').hidden) renderSeatMap(lastMapData);
    });
  }).observe($('mapWrap'));
  syncMode();
})();
