'use strict';
const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const dir=process.env.LIBSEAT_TEST_DIR;
app.setPath('userData',path.join(dir,'ui'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,width:1180,height:960,webPreferences:{offscreen:true,backgroundThrottling:false}});
  const js=expr=>win.webContents.executeJavaScript(expr,true);
  async function wait(expr){for(let i=0;i<160;i++){if(await js(expr))return;await new Promise(r=>setTimeout(r,60));}throw Error('Timeout: '+expr);}
  try{
    await win.loadURL(process.env.LIBSEAT_TEST_URL);await wait('mapReady && !mapLoading && !fullRefreshPromise');
    await js("document.getElementById('watchChoose').click();document.getElementById('watchSeatInput').value='001,048';document.getElementById('watchSave').click()");
    assert.match(await js("document.getElementById('watchInputError').textContent"),/一个/);
    await js("document.getElementById('watchSeatInput').value='048';document.getElementById('watchSave').click()");
    assert.equal(await js("document.querySelector('#mapSeats .seat-watch-target').dataset.no"),'XF5A048');
    await wait("!document.getElementById('watchStart').disabled");await js("document.getElementById('watchStart').click()");
    await wait("document.getElementById('watchMessage').textContent.includes('暂不可约')");
    assert.equal(await js("document.getElementById('btnStart').disabled && document.getElementById('btnRenewalStart').disabled"),true);
    assert.equal(await js("document.getElementById('watchChoose').disabled"),true);
    const file=path.join(dir,'watch-school.json'),data=JSON.parse(fs.readFileSync(file));data.available=true;fs.writeFileSync(file,JSON.stringify(data));
    fs.writeFileSync(path.join(dir,'now.txt'),'2026-10-26T10:00:03+08:00');
    await wait("document.getElementById('watchState').textContent==='已完成' && document.getElementById('bookingSeat').textContent==='XF5A048'");
    await wait("document.querySelector('#mapSeats .seat-mine')?.dataset.no==='XF5A048'");
    assert.match(await js("document.getElementById('watchMessage').textContent"),/重新签到/);
    await js("document.querySelectorAll('dialog[open]').forEach(d=>d.close())");win.setSize(390,844);
    await new Promise(r=>setTimeout(r,150));assert.equal(await js('document.documentElement.scrollWidth<=innerWidth+1'),true);
    console.log('PASS: exact-seat dialog, occupied target, task locks, checkout then target reservation, own-seat marker, narrow UI');app.exit(0);
  }catch(e){console.error(e);app.exit(1);}
});
