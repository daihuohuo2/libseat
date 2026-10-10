'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../browser-login.js'), 'utf8');
test('unrelated CDP event does not disable evaluation timeout', async () => {
  let closed = false;
  class Socket {
    constructor() { setTimeout(() => this.onopen(), 0); }
    send() { setTimeout(() => this.onmessage({ data: JSON.stringify({ method: 'Runtime.executionContextCreated' }) }), 0); }
    close() { closed = true; }
  }
  const context = vm.createContext({ require, module: { exports: {} }, setTimeout, clearTimeout, WebSocket: Socket });
  vm.runInContext(source, context);
  const result = await vm.runInContext('evalInPage("ws://test", "1", 30)', context);
  assert.equal(result, undefined); assert.equal(closed, true);
});
test('login target matches exact official origin and supports the CAS redirect', async () => {
  let hasTimeout = false;
  const context = vm.createContext({ require, module: { exports: {} }, AbortSignal,
    fetch: async (_, opts) => { hasTimeout = !!opts.signal; return { ok: true, json: async () => [
      { type: 'page', url: 'https://evil.example/?libzw.csu.edu.cn' },
      { type: 'page', url: 'https://ca.csu.edu.cn/authserver/login' }
    ] }; } });
  vm.runInContext(source, context);
  const target = await vm.runInContext('findSiteTarget()', context);
  assert.equal(target.url, 'https://ca.csu.edu.cn/authserver/login'); assert.equal(hasTimeout, true);
});

function browserContext(info) {
  class Socket {
    constructor() { setTimeout(() => this.onopen(), 0); }
    send() { setTimeout(() => this.onmessage({ data: JSON.stringify({ id: 1, result: { result: { value: JSON.stringify(info) } } }) }), 0); }
    close() {}
  }
  const context = vm.createContext({ require, module: { exports: {} }, setTimeout, clearTimeout, AbortSignal, AbortController, Buffer, WebSocket: Socket,
    fetch: async () => ({ ok: true, json: async () => [{ type: 'page', url: info.url, webSocketDebuggerUrl: 'ws://test' }] }) });
  vm.runInContext(source, context);
  return context;
}
test('hidden CAS login form exits immediately with manual-login reason', async () => {
  const context = browserContext({ url: 'https://ca.csu.edu.cn/authserver/login', token: '', needsUser: true });
  const r = await vm.runInContext('waitForToken(45000, () => {}, {headless:true})', context);
  assert.equal(r.ok, false); assert.equal(r.needManual, true); assert.match(r.message, /统一认证已过期/);
});
test('visible login waiting is abortable and does not accept expired credentials', async () => {
  const expired = 'header.' + Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url') + '.signature';
  const context = browserContext({ url: 'https://libzw.csu.edu.cn/', token: expired });
  const waiting = vm.runInContext('const controller=new AbortController(); waitForToken(300000, () => {}, {signal:controller.signal})', context);
  setTimeout(() => vm.runInContext('controller.abort(Error("停止等待"))', context), 30);
  await assert.rejects(waiting, /停止等待/);
});
test('browser never becomes ready: bounded error and external cancellation', async () => {
  const context = browserContext({ url: 'about:blank' });
  context.fetch = async () => { throw Error('not started'); };
  await assert.rejects(vm.runInContext('waitForReady(undefined, 10)', context), /浏览器未能启动/);
  await assert.rejects(vm.runInContext('waitForReady(AbortSignal.abort(Error("cancelled")))', context), /cancelled/);
});
