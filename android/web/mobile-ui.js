(() => {
  const demo = Mobile.isDemo();
  document.documentElement.classList.add('android-app');
  const preferences = document.querySelector('.preferences');
  const fold = document.createElement('details'); fold.className='mobile-selection'; fold.open=true;
  const summary = document.createElement('summary'); summary.textContent='选座设置';
  const foldState = document.createElement('span'); summary.append(foldState);
  preferences.querySelector('h2').remove();
  while (preferences.firstChild) fold.append(preferences.firstChild);
  fold.prepend(summary); preferences.append(fold);
  fold.ontoggle = () => { foldState.textContent=fold.open?'收起':'展开'; };
  let bookingView;
  window.MobileUI = { render(s) {
    const key=s.success?s.booking?.id:'';
    if (key!==bookingView) { fold.open=!key; bookingView=key; }
  } };
  const bar = document.createElement('div'); bar.className = 'mobile-mode';
  const label = document.createElement('span'); label.textContent = demo ? '演示模式 · 模拟数据' : '手机版';
  const toggle = document.createElement('button'); toggle.className = 'text-button'; toggle.textContent = demo ? '返回真实模式' : '体验演示';
  toggle.onclick = async () => {
    const s = await api('/api/status');
    if (s.running || s.checkingBooking || s.pendingBooking || s.renewal?.active || s.renewal?.busy
      || ['cancel-unknown','booking-unknown'].includes(s.renewal?.phase) || s.bookingManagement?.busy
      || s.bookingManagement?.checking || s.bookingManagement?.pendingAction || s.seatWatch?.active || s.seatWatch?.busy
      || s.seatWatch?.phase?.endsWith('unknown')) { alert('请先停止任务并处理待确认预约，再切换模式。'); return; }
    Mobile.switchMode(!demo);
  };
  bar.append(label, toggle); document.querySelector('.app-shell').prepend(bar);
  const helpText = document.createElement('p');
  helpText.textContent = '手机独立运行。请允许通知和后台运行；锁屏省电、断网或强制停止可能中断任务。通知栏可停止抢座与重约，重新打开后请核实状态。';
  document.getElementById('helpDialog').append(helpText);
  const notice = () => {
    $('btnNotifications').hidden = false; $('btnNotifications').textContent = Mobile.notificationsAllowed() ? '通知设置' : '允许手机通知';
    $('notificationHint').textContent = Mobile.notificationsAllowed() ? '成功后会显示手机通知。任务运行中可在通知栏停止。' : '手机通知尚未允许，成功结果仍保存在应用内。';
  };
  $('btnNotifications').onclick = () => Mobile.notificationSettings(); notice();
  window.addEventListener('focus', notice);
  $('btnAuto').textContent = '登录学校账号';
  if (demo) {
    const sign = document.createElement('button'); sign.id='btnDemoSignIn'; sign.className='text-button'; sign.textContent='模拟到馆签到';
    sign.onclick = async () => {
      const r = await api('/api/demo-signin', {});
      if (!r.ok) { alert(r.message); return; }
      await api('/api/booking-state', {}); await tick();
    };
    bar.append(sign);
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
})();
