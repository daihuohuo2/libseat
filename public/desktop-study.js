/* Desktop presentation only. Native window controls remain owned by Electron. */
(() => {
  if (!window.seatAssistant?.desktopUI) return;
  const root = document.documentElement;
  root.classList.add('desktop-app');
  if (window.seatAssistant.customTitlebar) root.classList.add('custom-titlebar');

  const titlebar = document.createElement('header');
  titlebar.className = 'desktop-titlebar';
  titlebar.setAttribute('aria-label', '窗口标题栏');
  const title = document.createElement('span'); title.textContent = '座位助手';
  const logo = document.createElement('img');
  logo.src = '/app-192.png'; logo.alt = ''; logo.className = 'desktop-app-logo';
  titlebar.append(logo, title);
  const tabs = document.querySelector('.tabs');
  tabs.setAttribute('aria-orientation', 'horizontal');

  const statusbar = document.createElement('footer'); statusbar.className = 'desktop-statusbar';
  const status = document.createElement('span'); status.id = 'desktopStatus';
  const hint = document.createElement('span'); hint.textContent = '关闭窗口后仍在托盘运行';
  statusbar.append(status, hint);
  document.body.prepend(titlebar);
  document.body.append(statusbar);

  const syncStatus = () => {
    status.textContent = document.getElementById('runState').textContent + '  ·  ' + document.getElementById('prefState').textContent;
  };
  ['runState','prefState'].forEach(id => new MutationObserver(syncStatus).observe(document.getElementById(id), {childList:true,subtree:true,characterData:true}));
  syncStatus();

  const buttons = [...tabs.querySelectorAll('[role="tab"]')];
  buttons.forEach((button, index) => button.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const next = buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length];
    next.click(); next.focus();
  }));
})();
