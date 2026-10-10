'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const flow = server.slice(server.indexOf('function runLoginFlow(opts)'), server.indexOf('/** 校验当前 token'));
function fixture() {
  const calls = [], saved = [], logs = [];
  const browser = {
    closeBrowser: async () => { calls.push('close'); },
    launchBrowser: (_, opts) => { calls.push(opts.headless ? 'launch-silent' : 'launch-visible'); assert.equal(opts.startBlank, true); },
    waitForReady: async () => { calls.push('ready'); },
    setAllCookies: async () => { calls.push('restore'); return true; },
    openSite: async () => { calls.push('navigate'); },
    waitForToken: async () => ({ ok: true, token: 'mock-token' })
  };
  const context = vm.createContext({ AbortController, Date, Error, setTimeout, clearTimeout, browserLogin: browser,
    PROFILE_DIR: 'test-profile', loadSavedCookies: () => [{ name: 'mock' }], loadConfig: () => ({}), saveConfig: cfg => saved.push(cfg),
    saveCookiesSnapshot: async () => { calls.push('save-cookies'); }, log: text => logs.push(text) });
  vm.runInContext('const loginState = {}; let loginController, loginTask;' + flow, context);
  return { browser, calls, saved, logs, context, run: opts => { context.opts = opts; return vm.runInContext('runLoginFlow(opts)', context); },
    state: () => vm.runInContext('({...loginState})', context) };
}
test('login waits for browser, restores cookies before navigation, and unlocks on success', async () => {
  const f = fixture();
  assert.equal((await f.run({ headlessFirst: false })).ok, true);
  assert.deepEqual(f.calls, ['close', 'launch-visible', 'ready', 'restore', 'navigate', 'save-cookies', 'close']);
  assert.equal(f.state().active, false); assert.equal(f.state().tokenOk, true); assert.equal(f.saved.length, 1);
});
test('background CAS failure is explicit; no invented credential expiry on network failure', async () => {
  const f = fixture();
  f.browser.waitForToken = async () => ({ ok: false, needManual: true, message: '学校统一认证已过期' });
  const r = await f.run({ headlessFirst: true, allowHeaded: false });
  assert.equal(r.needManual, true); assert.equal(f.state().active, false); assert.match(f.state().error, /统一认证/);
  f.browser.waitForReady = async () => { throw Error('浏览器调试端口不可连接'); };
  await f.run({ headlessFirst: true, allowHeaded: false });
  assert.match(f.state().error, /端口/); assert.doesNotMatch(f.state().error, /过期/);
});
test('abort frees login lock so manual login can start; duplicate calls share one operation', async () => {
  const f = fixture();
  f.browser.waitForToken = async (_, tick, { signal }) => new Promise((resolve, reject) => {
    tick({ hint: 'waiting' }); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const first = f.run({ headlessFirst: true, allowHeaded: false });
  await new Promise(r => setTimeout(r, 5));
  const second = f.run({ headlessFirst: true }); assert.equal(first, second);
  vm.runInContext('loginController.abort(Error("已切换到手动登录"))', f.context);
  await first; assert.equal(f.state().active, false);
  f.browser.waitForToken = async () => ({ ok: true, token: 'new-token' });
  await f.run({ headlessFirst: false });
  assert.equal(f.state().tokenOk, true); assert.equal(f.saved.length, 1);
});
test('browser startup and cleanup exceptions always release active state', async () => {
  const f = fixture(); f.browser.closeBrowser = async () => { throw Error('关闭失败'); };
  assert.equal((await f.run({ headlessFirst: false })).ok, false);
  assert.equal(f.state().active, false); assert.match(f.state().error, /关闭失败/);
});
