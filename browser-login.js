/**
 * 浏览器登录态自动获取模块
 * ------------------------------------------------------------
 * 原理：
 *   1. 用独立 user-data-dir 启动本机 Edge（与用户日常浏览器互不干扰）
 *   2. 打开座位系统，用户在里面登录一次（CAS）
 *   3. 通过 CDP（Chrome DevTools Protocol）读取页面 sessionStorage 的 token
 *   4. 该 profile 会保留 CAS 的 CASTGC cookie，下次启动往往能免登录直接拿到 token
 *
 * 依赖：仅 Node 内置模块（child_process / fs / fetch / WebSocket）
 * ------------------------------------------------------------
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEBUG_PORT = 9222;
const SITE = 'https://libzw.csu.edu.cn/';

const BROWSER_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
];

function findBrowser() {
  for (const p of BROWSER_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (e) { /* ignore */ }
  }
  return null;
}

/** 启动带调试端口的浏览器（独立 profile，可保留登录态；opts.headless = 无头静默模式） */
function launchBrowser(profileDir, opts) {
  const exe = findBrowser();
  if (!exe) throw new Error('未找到 Edge 或 Chrome，请先安装浏览器');
  fs.mkdirSync(profileDir, { recursive: true });

  const args = [
    '--remote-debugging-port=' + DEBUG_PORT,
    '--user-data-dir=' + profileDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msEdgeSidebarV2',
    opts && opts.startBlank ? 'about:blank' : SITE
  ];
  if (opts && opts.headless) args.unshift('--headless=new');

  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  // Report spawn failures through readiness checks instead of an unhandled event.
  child.on('error', () => {});
  child.unref();
  return exe;
}

/** 列出可调试的页面 */
function requestSignal(signal, ms = 5000) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}
async function listTargets(signal) {
  const r = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list', { signal: requestSignal(signal) });
  if (!r.ok) throw Error('浏览器调试连接失败');
  return r.json();
}

async function waitForReady(signal, maxMs = 12000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try { if ((await listTargets(signal)).some(t => t.type === 'page' && t.webSocketDebuggerUrl)) return; }
    catch (e) { signal?.throwIfAborted(); }
    await delay(200, signal);
  }
  throw Error('登录浏览器未能启动或调试端口 9222 被占用，请关闭座位助手的登录窗口后重试');
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function openSite(signal) {
  const pages = await listTargets(signal);
  const target = pages.find(t => t.type === 'page' && t.url === 'about:blank')
    || pages.find(t => t.type === 'page' && (t.url?.startsWith(SITE) || t.url?.startsWith('https://ca.csu.edu.cn/')));
  if (!target?.webSocketDebuggerUrl) throw Error('找不到座位助手的登录页面');
  const result = await cdpCall(target.webSocketDebuggerUrl, 'Page.navigate', { url: SITE }, 8000, signal);
  signal?.throwIfAborted();
  if (!result || result.errorText) throw Error('无法打开学校登录页：' + (result?.errorText || '浏览器未响应'));
}

async function focusLogin() {
  const target = await findSiteTarget();
  if (target?.webSocketDebuggerUrl) await cdpCall(target.webSocketDebuggerUrl, 'Page.bringToFront', {}, 3000);
}

/** 在指定页面里执行 JS 表达式并取值 */
function evalInPage(wsUrl, expression, timeoutMs, signal) {
  return new Promise((resolve) => {
    let done = false;
    let ws;
    let timer;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      try { ws && ws.close(); } catch (e) { /* ignore */ }
      resolve(v);
    };

    const abort = () => finish(undefined);
    if (signal?.aborted) return finish(undefined);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      return finish(undefined);
    }

    timer = setTimeout(() => finish(undefined), timeoutMs || 6000);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: expression, returnByValue: true, awaitPromise: true }
      }));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.id === 1) {
          const r = msg.result && msg.result.result;
          finish(r ? r.value : undefined);
        }
      } catch (e) { finish(undefined); }
    };
    ws.onerror = () => finish(undefined);
    ws.onclose = () => finish(undefined);
  });
}

/** 找到座位系统的页面 target */
async function findSiteTarget(signal) {
  try {
    const list = await listTargets(signal);
    return list.find(t => t.type === 'page' && t.url && t.url.startsWith(SITE))
      || list.find(t => t.type === 'page' && t.url && t.url.startsWith('https://ca.csu.edu.cn/')) || null;
  } catch (e) {
    return null;
  }
}

/**
 * 轮询等待 token 出现
 * @param {number} maxMs  最长等待时间
 * @param {function} onTick 每次轮询回调，用于向界面反馈进度
 */
async function waitForToken(maxMs, onTick, opts = {}) {
  const start = Date.now();
  const signal = opts.signal;
  let lastHint = '浏览器启动中…';

  while (Date.now() - start < maxMs) {
    signal?.throwIfAborted();
    onTick?.({ elapsed: Math.round((Date.now() - start) / 1000), hint: lastHint });
    const target = await findSiteTarget(signal);

    if (target && target.webSocketDebuggerUrl) {
      // 顺便读一下当前页面地址，便于反馈"卡在哪个环节"
      const info = await evalInPage(target.webSocketDebuggerUrl,
        "JSON.stringify({url:location.href, token:sessionStorage.getItem('token')||'', needsUser:!!document.querySelector('input[type=password]')})",
        Math.min(6000, Math.max(1, maxMs - (Date.now() - start))), signal);
      signal?.throwIfAborted();

      if (info) {
        let obj = null;
        try { obj = JSON.parse(info); } catch (e) { /* ignore */ }

        if (obj && obj.token && String(obj.url).startsWith(SITE)) {
          let expired = false;
          try { const payload = JSON.parse(Buffer.from(obj.token.split('.')[1], 'base64url').toString()); expired = payload.exp && payload.exp * 1000 <= Date.now(); } catch (_) {}
          if (!expired) return { ok: true, token: obj.token, url: obj.url };
          lastHint = '网页中的登录态已过期，请在学校登录页重新认证。';
        }
        const atCAS = String(obj?.url || target.url).startsWith('https://ca.csu.edu.cn/');
        if (opts.headless && atCAS && obj?.needsUser) return { ok: false, needManual: true, message: '学校统一认证已过期，需要打开登录窗口完成认证。' };
        if (!obj?.token) lastHint = atCAS ? (opts.headless ? '学校要求重新认证，可点击“打开登录窗口”。' : '请在已打开的学校登录窗口完成认证。') : '已进入系统页面，等待登录态就绪…';
        if (onTick) {
          onTick({
            elapsed: Math.round((Date.now() - start) / 1000),
            url: obj ? obj.url : target.url,
            hint: lastHint
          });
        }
      } else if (onTick) {
        lastHint = '页面暂未响应，正在重试读取登录状态…';
        onTick({ elapsed: Math.round((Date.now() - start) / 1000), url: target.url, hint: lastHint });
      }
    } else if (onTick) {
      lastHint = '未找到学校页面，请检查登录窗口是否已关闭，或点击“停止等待”后重试。';
      onTick({ elapsed: Math.round((Date.now() - start) / 1000), url: '', hint: lastHint });
    }

    await delay(Math.min(1000, Math.max(1, maxMs - (Date.now() - start))), signal);
  }
  return { ok: false, message: '等待登录超时：' + lastHint };
}

/** 通过 CDP 在浏览器级 target 上执行指令并返回 result */
function cdpCall(wsUrl, method, params, timeoutMs, signal) {
  return new Promise((resolve) => {
    let ws;
    let done = false;
    let timer;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      try { ws && ws.close(); } catch (e) { /* ignore */ }
      resolve(v);
    };
    const abort = () => finish(null);
    if (signal?.aborted) return finish(null);
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(null), timeoutMs || 8000);
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) { clearTimeout(timer); return finish(null); }

    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: method, params: params || {} }));
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.id === 1) { clearTimeout(timer); finish(msg.result || null); }
      } catch (e) { /* ignore */ }
    };
    ws.onerror = () => { clearTimeout(timer); finish(null); };
    ws.onclose = () => finish(null);
  });
}

async function getBrowserWsUrl(signal) {
  try {
    const ver = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/version', { signal: requestSignal(signal) }).then(r => r.json());
    return (ver && ver.webSocketDebuggerUrl) || null;
  } catch (e) { return null; }
}

function sanitizeCookie(c) {
  const out = {
    name: c.name, value: c.value,
    domain: c.domain, path: c.path || '/',
    expires: typeof c.expires === 'number' ? c.expires : -1,
    httpOnly: !!c.httpOnly, secure: !!c.secure
  };
  if (c.sameSite === 'Lax' || c.sameSite === 'Strict' || c.sameSite === 'None') out.sameSite = c.sameSite;
  return out;
}

/** 导出所有 csu.edu.cn 相关 cookie（含 CASTGC 等会话 cookie） */
async function getAllCookies() {
  const wsUrl = await getBrowserWsUrl();
  if (!wsUrl) return [];
  const res = await cdpCall(wsUrl, 'Storage.getCookies', {});
  const all = (res && res.cookies) || [];
  return all.filter(c => c.domain && c.domain.indexOf('csu.edu.cn') !== -1);
}

/** 把之前导出的 cookie 注入当前浏览器（实现跨进程会话 cookie 恢复） */
async function setAllCookies(cookies, signal) {
  if (!cookies || !cookies.length) return false;
  const wsUrl = await getBrowserWsUrl(signal);
  if (!wsUrl) return false;
  const res = await cdpCall(wsUrl, 'Storage.setCookies',
    { cookies: cookies.map(sanitizeCookie) }, 8000, signal);
  return !!res;
}

/** 关闭调试浏览器（只关我们自己启动的那个 profile 的进程） */
async function closeBrowser() {
  try {
    const ver = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/version', { signal: AbortSignal.timeout(1000) }).then(r => r.json());
    if (ver && ver.webSocketDebuggerUrl) {
      await cdpCall(ver.webSocketDebuggerUrl, 'Browser.close', {}, 3000);
      // Do not reopen the same profile until the old debug endpoint has gone away.
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        try { await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/version', { signal: AbortSignal.timeout(500) }); }
        catch (_) { return true; }
        await delay(100);
      }
    }
  } catch (e) { /* ignore */ }
  return false;
}

module.exports = {
  DEBUG_PORT,
  findBrowser,
  launchBrowser,
  waitForToken,
  closeBrowser,
  listTargets,
  waitForReady,
  openSite,
  focusLogin,
  findSiteTarget,
  getAllCookies,
  setAllCookies
};
