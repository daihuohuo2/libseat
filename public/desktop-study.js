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
  const tagline = document.createElement('span'); tagline.className = 'desktop-title-note'; tagline.textContent = '专注的时光，更好的自己';
  titlebar.append(logo, title, tagline);

  const sidebar = document.createElement('aside');
  sidebar.className = 'desktop-sidebar';
  sidebar.setAttribute('aria-label', '应用导航');
  const brand = document.createElement('div'); brand.className = 'desktop-brand';
  const name = document.createElement('strong'); name.textContent = '座位助手';
  const sub = document.createElement('span'); sub.textContent = '中南大学图书馆';
  brand.append(name, sub);
  const tabs = document.querySelector('.tabs');
  tabs.setAttribute('aria-orientation', 'vertical');
  const preview = document.getElementById('previewBadge');
  const quote = document.createElement('p'); quote.className = 'desktop-sidebar-note'; quote.textContent = '在图书馆，\n与更好的自己相遇。';
  const account = document.querySelector('.account');
  sidebar.append(brand, tabs, quote, account, preview);

  const statusbar = document.createElement('footer'); statusbar.className = 'desktop-statusbar';
  const status = document.createElement('span'); status.id = 'desktopStatus';
  const hint = document.createElement('span'); hint.textContent = '关闭窗口后仍在托盘运行';
  statusbar.append(status, hint);
  document.body.prepend(titlebar, sidebar);
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
