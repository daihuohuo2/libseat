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
    SITE
  ];
  if (opts && opts.headless) args.unshift('--headless=new');

  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return exe;
}

/** 列出可调试的页面 */
async function listTargets() {
  const r = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list');
  return r.json();
}

/** 在指定页面里执行 JS 表达式并取值 */
function evalInPage(wsUrl, expression, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let ws;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { ws && ws.close(); } catch (e) { /* ignore */ }
      resolve(v);
    };

    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      return finish(undefined);
    }

    const timer = setTimeout(() => finish(undefined), timeoutMs || 6000);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: expression, returnByValue: true, awaitPromise: true }
      }));
    };
    ws.onmessage = (ev) => {
      clearTimeout(timer);
      try {
        const msg = JSON.parse(ev.data);
        if (msg.id === 1) {
          const r = msg.result && msg.result.result;
          finish(r ? r.value : undefined);
        }
      } catch (e) { finish(undefined); }
    };
    ws.onerror = () => { clearTimeout(timer); finish(undefined); };
  });
}

/** 找到座位系统的页面 target */
async function findSiteTarget() {
  try {
    const list = await listTargets();
    return list.find(t =>
      t.type === 'page' && t.url && t.url.indexOf('libzw.csu.edu.cn') !== -1
    ) || null;
  } catch (e) {
    return null;
  }
}

/**
 * 轮询等待 token 出现
 * @param {number} maxMs  最长等待时间
 * @param {function} onTick 每次轮询回调，用于向界面反馈进度
 */
async function waitForToken(maxMs, onTick) {
  const start = Date.now();
  let tickCount = 0;

  while (Date.now() - start < maxMs) {
    tickCount++;
    const target = await findSiteTarget();

    if (target && target.webSocketDebuggerUrl) {
      // 顺便读一下当前页面地址，便于反馈"卡在哪个环节"
      const info = await evalInPage(target.webSocketDebuggerUrl,
        "JSON.stringify({url:location.href, token:sessionStorage.getItem('token')||''})");

      if (info) {
        let obj = null;
        try { obj = JSON.parse(info); } catch (e) { /* ignore */ }

        if (obj && obj.token) {
          return { ok: true, token: obj.token, url: obj.url };
        }
        if (onTick) {
          onTick({
            elapsed: Math.round((Date.now() - start) / 1000),
            url: obj ? obj.url : target.url,
            hint: obj && obj.url.indexOf('ca.csu.edu.cn') !== -1
              ? '等待你在弹出的浏览器窗口中完成登录...'
              : '已进入系统页面，等待登录态就绪...'
          });
        }
      }
    } else if (onTick) {
      onTick({ elapsed: Math.round((Date.now() - start) / 1000), url: '', hint: '浏览器启动中...' });
    }

    await new Promise(r => setTimeout(r, 2000));
  }
  return { ok: false, message: '等待超时，未获取到登录态' };
}

/** 通过 CDP 在浏览器级 target 上执行指令并返回 result */
function cdpCall(wsUrl, method, params, timeoutMs) {
  return new Promise((resolve) => {
    let ws;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { ws && ws.close(); } catch (e) { /* ignore */ }
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs || 8000);
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
  });
}

async function getBrowserWsUrl() {
  try {
    const ver = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/version').then(r => r.json());
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
async function setAllCookies(cookies) {
  if (!cookies || !cookies.length) return false;
  const wsUrl = await getBrowserWsUrl();
  if (!wsUrl) return false;
  const res = await cdpCall(wsUrl, 'Storage.setCookies',
    { cookies: cookies.map(sanitizeCookie) }, 10000);
  return !!res;
}

/** 关闭调试浏览器（只关我们自己启动的那个 profile 的进程） */
async function closeBrowser() {
  try {
    const list = await listTargets();
    if (!list.length) return false;
  } catch (e) {
    return false;
  }
  // 通过 CDP 的 Browser.close 优雅退出
  try {
    const ver = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/version').then(r => r.json());
    if (ver && ver.webSocketDebuggerUrl) {
      await new Promise((resolve) => {
        const ws = new WebSocket(ver.webSocketDebuggerUrl);
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
        ws.onmessage = () => { try { ws.close(); } catch (e) { /* ignore */ } resolve(); };
        ws.onerror = () => resolve();
        setTimeout(resolve, 3000);
      });
      return true;
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
  findSiteTarget,
  getAllCookies,
  setAllCookies
};
