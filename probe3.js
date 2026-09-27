/**
 * 侦察官网前端：找出它自己的"当前时段"计算方式与实时接口
 */
'use strict';
const fs = require('fs');
const path = require('path');

const BASE = 'https://libzw.csu.edu.cn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const OUT = path.join(__dirname, '.recon');

async function get(url, opts) {
  const res = await fetch(url, Object.assign({
    headers: { 'User-Agent': UA, 'Accept': '*/*' }
  }, opts || {}));
  return { status: res.status, text: await res.text() };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // 1. 首页
  const idx = await get(BASE + '/');
  console.log('首页 status=' + idx.status + ' len=' + idx.text.length);
  fs.writeFileSync(path.join(OUT, 'index.html'), idx.text);
  const srcs = [...idx.text.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map(m => m[1]);
  const links = [...idx.text.matchAll(/<link[^>]+href=["']([^"']+\.(?:js|css))["']/g)].map(m => m[1]);
  console.log('脚本: ' + JSON.stringify([...new Set(srcs.concat(links))], null, 1));

  // 2. 抓 JS
  const all = [...new Set(srcs.concat(links))].filter(u => /\.js/.test(u));
  const joined = [];
  for (const u of all) {
    const full = u.startsWith('http') ? u : (BASE + (u.startsWith('/') ? u : '/' + u));
    try {
      const r = await get(full);
      const name = 'js_' + path.basename(full.split('?')[0]);
      fs.writeFileSync(path.join(OUT, name), r.text);
      joined.push({ name: name, url: full, len: r.text.length });
      console.log('  下载 ' + name + ' (' + r.text.length + 'B)');
    } catch (e) { console.log('  失败 ' + u + ': ' + e.message); }
  }
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(joined, null, 2));

  // 3. 在 JS 里找 API 路径
  const paths = new Set();
  for (const j of joined) {
    const t = fs.readFileSync(path.join(OUT, j.name), 'utf8');
    [...t.matchAll(/["'`](\/v\d[a-zA-Z0-9_\/\-]*)["'`]/g)].forEach(m => paths.add(m[1]));
    [...t.matchAll(/["'`](\/(?:space|Space|area|seat|index|user)[a-zA-Z0-9_\/\-]*)["'`]/g)].forEach(m => paths.add(m[1]));
  }
  console.log('\n===== JS 中出现的接口路径 =====');
  [...paths].sort().forEach(p => console.log(' ' + p));

  // 4. 找时段关键词
  console.log('\n===== 关键词命中 =====');
  const kws = ['start_time', 'segment', 'nowSegment', 'getSegment', '当前时段', '使用中', '临时离开', '实时'];
  for (const j of joined) {
    const t = fs.readFileSync(path.join(OUT, j.name), 'utf8');
    for (const k of kws) {
      const i = t.indexOf(k);
      if (i >= 0) {
        const ctx = t.slice(Math.max(0, i - 120), i + 160).replace(/\s+/g, ' ');
        console.log('[' + j.name + '] ' + k + ' => ...' + ctx + '...');
      }
    }
  }
  process.exit(0);
})();
