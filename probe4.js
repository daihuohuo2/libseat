/**
 * 下载座位相关的前端 chunk，并搜索实时可用性接口与"当前时段"逻辑
 */
'use strict';
const fs = require('fs');
const path = require('path');

const BASE = 'https://libzw.csu.edu.cn/h5/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const OUT = path.join(__dirname, '.recon');

const TARGETS = [
  'assets/SeatAreaList.1787201907183.js',
  'assets/SpaceSeatMap.1787201907183.js',
  'assets/SpaceMap.1787201907183.js',
  'assets/seat-map.1787201907183.js',
  'assets/seatArea.1787201907183.js',
  'assets/seatSelected.1787201907183.js',
  'assets/seat.1787201907183.js',
  'assets/seat.17872019071832.js',
  'assets/space.1787201907183.js',
  'assets/space.17872019071832.js',
  'assets/space.17872019071833.js',
  'assets/space.17872019071834.js',
  'assets/space.17872019071835.js',
  'assets/BookAreaList.1787201907183.js',
  'assets/BookFilterCom.1787201907183.js',
  'assets/SpaceChooseSpaceFilter.1787201907183.js',
  'assets/clearSeat.1787201907183.js',
  'assets/clearSeatArea.1787201907183.js'
];

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  return await res.text();
}

(async () => {
  const saved = [];
  for (const t of TARGETS) {
    try {
      const txt = await get(BASE + t);
      const name = 'c_' + path.basename(t);
      fs.writeFileSync(path.join(OUT, name), txt);
      saved.push(name);
      console.log('OK ' + name + ' (' + txt.length + 'B)');
    } catch (e) { console.log('FAIL ' + t + ': ' + e.message); }
  }

  console.log('\n===== 搜索 start_time / end_time / 接口 / 时段 =====');
  for (const name of saved) {
    const t = fs.readFileSync(path.join(OUT, name), 'utf8');
    const hits = [];
    const pats = [
      /["'`](\/v4\/[A-Za-z0-9_\/]+)["'`]/g,
      /start_time\s*:\s*[^,}]{0,80}/g,
      /end_time\s*:\s*[^,}]{0,80}/g,
      /day\s*:\s*[^,}]{0,60}/g,
      /["'`](0[6-9]|1[0-9]|2[0-2]):[0-5][0-9]["'`]/g,
      /segment[^,;{}]{0,60}/g
    ];
    for (const p of pats) [...t.matchAll(p)].forEach(m => hits.push(m[0].replace(/\s+/g, ' ')));
    if (hits.length) {
      console.log('\n--- ' + name + ' ---');
      [...new Set(hits)].slice(0, 30).forEach(h => console.log('  ' + h.slice(0, 150)));
    }
  }
  process.exit(0);
})();
