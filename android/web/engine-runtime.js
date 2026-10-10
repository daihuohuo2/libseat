/* Android adapter for the unchanged Node reservation engine. No listening TCP port. */
(() => {
  const modules = Object.create(null), cache = Object.create(null);
  window.defineModule = (name, factory) => { modules[name] = factory; };
  window.require = name => {
    name = name.replace(/^node:/, '');
    if (!modules[name] && modules[name + '.js']) name += '.js';
    if (cache[name]) return cache[name].exports;
    if (!modules[name]) throw Error('Unsupported module: ' + name);
    const module = cache[name] = { exports: {} };
    modules[name](module, module.exports, window.require, '/data');
    return module.exports;
  };
  const call = (op, ...args) => {
    const r = JSON.parse(Native.sync(JSON.stringify({ op, args })));
    if (!r.ok) throw Error(r.error);
    return r.value;
  };
  const timers = new Map(); let timerId = 0;
  window.setTimeout = (fn, ms = 0, ...args) => {
    const id = ++timerId; timers.set(id, () => fn(...args));
    Native.timer(id, Math.max(1, Number(ms) || 1)); return id;
  };
  window.clearTimeout = id => { timers.delete(id); Native.cancelTimer(id); };
  window.setInterval = (fn, ms, ...args) => {
    const id = ++timerId;
    timers.set(id, () => { fn(...args); if (timers.has(id)) Native.timer(id, ms); });
    Native.timer(id, ms); return id;
  };
  window.clearInterval = window.clearTimeout;
  window.androidTimer = (id, repeating) => {
    const fn = timers.get(id); if (!fn) return;
    // Interval callbacks reschedule themselves; timeout entries are removed by wrapper below.
    fn();
  };
  const singleTimeout = window.setTimeout;
  window.setTimeout = (fn, ms, ...args) => {
    let id; id = singleTimeout(() => { timers.delete(id); fn(...args); }, ms); return id;
  };
  window.process = { env: Native.isDemo() ? { LIBSEAT_MOCK: './android-demo.js' } : {} };
  window.Buffer = { from(value, encoding) {
    const str = encoding === 'base64' ? call('decode64', value) : String(value);
    return { toString: () => str, value: str };
  } };
  defineModule('path', (m) => { m.exports = {
    join: (...parts) => parts.join('/').replace(/\/+/g, '/'),
    dirname: p => p.slice(0, p.lastIndexOf('/')),
    extname: p => p.slice(p.lastIndexOf('.'))
  }; });
  defineModule('fs', m => { m.exports = {
    existsSync: p => call('exists', p), readFileSync: p => call('read', p),
    writeFileSync: (p, data) => call('write', p, String(data)),
    appendFileSync: (p, data) => call('append', p, String(data)),
    mkdirSync: () => {}, openSync: p => p, fsyncSync: () => {}, closeSync: () => {},
    renameSync: (a, b) => call('rename', a, b)
  }; });
  const cipher = decrypt => (algorithm, key, iv) => ({
    update: data => call('aes', decrypt, key.value, iv.value, data), final: () => ''
  });
  defineModule('crypto', m => { m.exports = {
    createCipheriv: cipher(false), createDecipheriv: cipher(true), randomUUID: () => call('uuid')
  }; });
  let handler;
  defineModule('http', m => { m.exports = { createServer(fn) {
    handler = fn; return { listen(port, host, callback) { callback(); Native.ready(); } };
  } }; });
  const pending = new Map(); let networkId = 0;
  window.fetch = (url, options = {}) => new Promise((resolve, reject) => {
    const id = ++networkId;
    if (options.signal?.aborted) return reject(Error('aborted'));
    const abort = () => { if (pending.delete(id)) { Native.cancelRequest(id); reject(Error('aborted')); } };
    options.signal?.addEventListener('abort', abort, { once: true });
    pending.set(id, { resolve, reject, cleanup: () => options.signal?.removeEventListener('abort', abort) });
    Native.request(id, String(url), JSON.stringify({ method: options.method || 'GET', headers: options.headers || {}, body: options.body }));
  });
  window.androidNetworkResult = (id, r) => {
    const p = pending.get(id); if (!p) return; pending.delete(id); p.cleanup();
    if (r.error) p.reject(Error(r.error));
    else p.resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body });
  };
  window.androidDispatch = async (id, path, method, body) => {
    try {
      if (!/^\/api\/(?:[a-z-]+|renewal\/(?:start|stop|check))$/.test(path)) throw Error('Invalid API path');
      if (Native.isDemo() && path === '/api/demo-signin' && method === 'POST') {
        const result = require('./android-demo.js').signIn();
        Native.apiResult(id, 200, JSON.stringify(result)); return;
      }
      let code = 200;
      const req = { url: path, method, headers: {}, on(event, fn) {
        if (event === 'data') queueMicrotask(() => fn(body || '{}'));
        if (event === 'end') queueMicrotask(fn);
      }, destroy() { throw Error('Request too large'); } };
      await handler(req, { writeHead(c) { code = c; }, end(text) { Native.apiResult(id, code, String(text)); } });
    } catch (e) { Native.apiResult(id, 500, JSON.stringify({ ok: false, message: e.message })); }
  };
  defineModule('./browser-login.js', m => { m.exports = {
    launchBrowser(dir, opts) { Native.loginStart(!!opts.headless); },
    async waitForToken(maxMs, onTick, opts = {}) {
      const started = Date.now();
      while (Date.now() - started < maxMs) {
        opts.signal?.throwIfAborted();
        const r = JSON.parse(Native.loginRead());
        if (r.token) return { ok: true, token: r.token };
        if (r.error) return { ok: false, message: r.error };
        onTick?.({ elapsed: Math.round((Date.now() - started) / 1000), hint: '请在学校登录页面完成登录' });
        await new Promise(r => setTimeout(r, 800));
      }
      return { ok: false, message: '登录超时，请重试' };
    },
    async getAllCookies() { return []; }, async setAllCookies() { return false; },
    async closeBrowser() { Native.loginClose(); }
  }; });
  window.androidCall = (path, body, method) => new Promise((resolve, reject) => {
    let code = 200;
    const req = { url: path, method: method || (body ? 'POST' : 'GET'), headers: {}, on(event, fn) {
      if (event === 'data') queueMicrotask(() => fn(JSON.stringify(body || {})));
      if (event === 'end') queueMicrotask(fn);
    } };
    Promise.resolve(handler(req, { writeHead(c) { code = c; }, end(s) {
      try { resolve(JSON.parse(s)); } catch(e) { reject(e); }
    } })).catch(reject);
  });
  window.startAndroidEngine = () => {
    if (Native.isDemo() && !call('exists', '/data/config.json')) call('write', '/data/config.json', JSON.stringify({
      token: 'android-demo', dateMode: 'today', timeMode: 'now', startTime: '08:00', endTime: '10:00',
      verifyOnly: true, autoRefresh: false, areaIds: ['59','57'], preferAreas: ['59'],
      seatPlans: [{ id: 'demo-plan', name: '五楼安静自习', areas: ['59'], seats: [], mode: 'only' }], activePlanId: 'demo-plan'
    }));
    require('./server.js');
    let checking = false;
    setInterval(async () => {
      if (checking) return; checking = true;
      try {
        const s = await androidCall('/api/status');
        Native.status(JSON.stringify(s));
        if (s.renewal?.notice) Native.renewalNotice(JSON.stringify(s.renewal.notice));
        if (s.success && s.booking && Native.notificationsAllowed()) {
          const result = await androidCall('/api/notification-claim', { id: s.booking.id, channel: 'desktop' });
          if (result.claimed) Native.bookingNotice(JSON.stringify(s.booking));
        }
      } finally { checking = false; }
    }, 1000);
  };
})();
