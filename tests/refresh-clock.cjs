'use strict';
// Isolated child process only: adjustable clock and a login double with no browser/network.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const OriginalDate = Date;
const now = () => OriginalDate.parse(fs.readFileSync(path.join(process.env.LIBSEAT_TEST_DIR, 'now.txt'), 'utf8'));
global.Date = class extends OriginalDate {
  constructor(...args) { super(...(args.length ? args : [now()])); }
  static now() { return now(); }
};
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === './browser-login.js') return {
    launchBrowser() {}, async closeBrowser() {}, async getAllCookies() { return []; },
    async waitForToken() { return { ok: true, token: 'refreshed-test-token' }; }
  };
  return originalLoad.call(this, name, ...args);
};
