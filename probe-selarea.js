'use strict';
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const PORT = 9227;
const PROFILE = path.join(os.tmpdir(), 'libseat-probe-profile');
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function cdp(wsUrl, method, params) {
  const s = new WebSocket(wsUrl);
  await new Promise((res, rej) => { s.onopen = res; s.onerror = rej; });
  return new Promise(resolve => {
    const t = setTimeout(() => { try { s.close(); } catch (e) { } resolve(null); }, 20000);
    s.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id === 1) { clearTimeout(t); try { s.close(); } catch (e) { } resolve(m.result); } };
    s.send(JSON.stringify({ id: 1, method, params: params || {} }));
  });
}
const ev = async (ws, e) => { const r = await cdp(ws, 'Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r && r.result ? r.result.value : undefined; };

(async () => {
  await fetch('http://127.0.0.1:8848/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preferAreas: [], seatPrefs: [] }) });
  const child = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE, '--no-first-run', '--window-size=1200,1400', 'http://127.0.0.1:8848/'], { detached: true, stdio: 'ignore' });
  child.unref();
  let ws = null;
  for (let i = 0; i < 20 && !ws; i++) {
    await sleep(1000);
    try { const l = await fetch('http://127.0.0.1:' + PORT + '/json/list').then(r => r.json()); const t = l.find(x => x.type === 'page' && x.url.includes('8848')); if (t) ws = t.webSocketDebuggerUrl; } catch (e) { }
  }
  if (!ws) { console.log('no ws'); process.exit(1); }
  for (let i = 0; i < 16; i++) {
    await sleep(2000);
    const n = await ev(ws, "document.getElementById('selArea').options.length");
    const v = await ev(ws, "document.getElementById('selArea').value");
    const seats = await ev(ws, "document.querySelectorAll('#mapSeats .seat').length");
    console.log('t=' + ((i + 1) * 2) + 's selArea选项=' + n + ' 值=' + v + ' 座位=' + seats
      + ' curArea=' + await ev(ws, 'String(curArea)') + ' curStorey=' + await ev(ws, 'String(curStorey)'));
    if (i === 1) {
      console.log('  tree接口: ' + await ev(ws, "(async()=>{try{const r=await api('/api/tree',{});return JSON.stringify({ok:r.ok,msg:r.message,n:(r.tree||[]).length});}catch(e){return 'ERR '+e.message;}})()"));
      console.log('  areas接口: ' + await ev(ws, "(async()=>{try{const r=await api('/api/areas-of-storey',{premiseId:curPremise,storeyId:curStorey});return JSON.stringify({ok:r.ok,msg:r.message,n:(r.areas||[]).length,pid:curPremise,sid:curStorey});}catch(e){return 'ERR '+e.message;}})()"));
      console.log('  手动init: ' + await ev(ws, "(async()=>{try{await initMapBrowser();return 'ok, 座位='+document.querySelectorAll('#mapSeats .seat').length+' 选项='+document.getElementById('selArea').options.length;}catch(e){return 'ERR '+e.message;}})()"));
    }
    if (i === 4) {
      console.log('  -> 设为 options[1]: ' + await ev(ws, "(function(){var s=document.getElementById('selArea');if(s.options.length<2)return 'no-opt';var v=s.options[1].value;s.value=v;s.dispatchEvent(new Event('change'));return 'set ' + v;})()"));
    }
  }
  await fetch('http://127.0.0.1:8848/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preferAreas: [] }) });
  process.exit(0);
})();
