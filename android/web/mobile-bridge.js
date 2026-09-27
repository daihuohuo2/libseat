(() => {
  const pending = new Map(); let id = 0;
  window.seatAssistant = { nativeNotifications: true };
  const originalFetch = window.fetch.bind(window);
  window.fetch = (path, opts = {}) => {
    if (!String(path).startsWith('/api/')) return originalFetch(path, opts);
    return new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => { pending.delete(key); reject(Error('本地引擎响应超时，请重新打开应用')); }, 45000);
      pending.set(key, { resolve, reject, timer });
      Mobile.api(key, path, opts.method || 'GET', opts.body || '{}');
    });
  };
  window.mobileResult = (key, status, body) => {
    const p = pending.get(key); if (!p) return;
    clearTimeout(p.timer); pending.delete(key);
    p.resolve(new Response(body, { status, headers: { 'Content-Type': 'application/json' } }));
  };
  window.mobileBack = () => {
    const dialog = document.querySelector('dialog[open]');
    if (dialog) { dialog.close(); return true; }
    if (document.querySelector('#tab-booking')?.getAttribute('aria-selected') !== 'true') {
      document.querySelector('#tab-booking').click(); return true;
    }
    return false;
  };
})();
