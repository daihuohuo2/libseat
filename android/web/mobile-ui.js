(() => {
  const demo = Mobile.isDemo();
  document.documentElement.classList.add('android-app');
  const bar = document.createElement('div'); bar.className = 'mobile-mode';
  const label = document.createElement('span'); label.textContent = demo ? '演示模式 · 全部为模拟数据' : '安卓体验版 · 在手机上独立运行';
  const toggle = document.createElement('button'); toggle.className = 'text-button'; toggle.textContent = demo ? '返回真实模式' : '体验演示';
  toggle.onclick = async () => {
    const s = await api('/api/status');
    if (s.running || s.checkingBooking || s.pendingBooking) { alert('请先停止任务并处理待确认预约，再切换模式。'); return; }
    Mobile.switchMode(!demo);
  };
  bar.append(label, toggle); document.querySelector('.hero').before(bar);
  const info = document.createElement('p'); info.className = 'mobile-info';
  info.textContent = demo ? '可体验地图、保存方案和模拟预约；不会向学校提交请求。' : '首次使用请登录学校账号。任务运行时会显示常驻通知；省电或强制停止可能中断任务。';
  bar.after(info);
  const notice = () => {
    $('btnNotifications').hidden = false; $('btnNotifications').textContent = Mobile.notificationsAllowed() ? '通知设置' : '允许手机通知';
    $('notificationHint').textContent = Mobile.notificationsAllowed() ? '成功后会显示手机通知。任务运行中可在通知栏停止。' : '手机通知尚未允许，成功结果仍保存在应用内。';
  };
  $('btnNotifications').onclick = () => Mobile.notificationSettings(); notice();
  window.addEventListener('focus', notice);
  $('btnAuto').textContent = '登录学校账号';
  if (demo) {
    $('bookingTitle').textContent = '演示预约成功';
    $('bookingDialog').querySelector('.booking-card > .hint').textContent = '这是模拟结果，没有向学校提交预约。';
    $('bookingSummary').querySelector('strong').textContent = '演示预约成功';
    $('btnAuto').disabled = true; $('btnVerify').disabled = true;
    $('accountDialog').querySelector('.section-caption').textContent = '当前使用模拟数据，无需登录。切回真实模式后可登录学校账号。';
    $('autoRefresh').disabled = true;
  }
  $('btnPlanExport').onclick = () => {
    if (!plans.length) { $('plansFeedback').textContent = '请先保存一个方案。'; return; }
    Mobile.exportPlans(planExportPayload());
  };
  $('btnPlanImport').onclick = () => Mobile.importPlans();
  const help = document.createElement('button'); help.className = 'text-button'; help.textContent = '后台运行说明';
  help.onclick = () => alert('开始任务后，请允许通知，并在手机系统中允许座位助手后台运行。\n\n锁屏省电、网络切换、系统回收和强制停止都可能中断任务。重新打开后不会自动恢复抢座；若上次提交结果不确定，会先核实，避免重复预约。\n\n本版仍需在你的手机和学校网络下验证登录与真实预约。');
  document.querySelector('.app-footer').append(help);
})();
