/**
 * Electron 桌面应用主进程
 * ------------------------------------------------------------
 * 思路：复用已有的 server.js（子进程），主进程只负责：
 *   1. 启动后端（无控制台窗口）
 *   2. 等端口就绪后打开应用窗口（无菜单栏、独立图标、无浏览器地址栏）
 *   3. 退出时结束后端进程；后端意外退出时提示
 * 这样后端逻辑一份，网页版/桌面版共用。
 */
'use strict';
const { app, BrowserWindow, shell, dialog, Tray, Menu, nativeImage, Notification } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const bookingNotifications = require('../public/booking-notifications.js');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.LIBSEAT_PORT) || 8848;
const URL = 'http://127.0.0.1:' + PORT + '/';

let serverProc = null;
let win = null;
let tray = null;
let quitting = false;
let notificationTimer = null;
let notificationPending = false;
const activeNotifications = new Set();
const claimedDesktopBookings = new Set();
const seenRenewalNotices = new Set();
let latestStatus = null;
let trayState = '';
let quitPending = false;

async function requestQuit() {
  if (quitPending || quitting) return;
  quitPending = true;
  try {
    const response = await fetch(URL + 'api/stop', { method: 'POST', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw Error('停止请求失败');
    quitting = true;
    app.quit();
  } catch (e) {
    focusWindow();
    dialog.showErrorBox('暂未退出', '无法确认后台已停止，请检查服务连接后重试。');
  } finally { quitPending = false; }
}

function focusWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.flashFrame(false);
}

function showBookingNotification(booking) {
  if (quitting) return;
  if (win) win.flashFrame(true);
  const fallback = () => {
    if (quitting) return;
    focusWindow();
    dialog.showMessageBox(win, {
      type: 'info', title: '抢到座位了！', message: '座位 ' + booking.seat,
      detail: bookingNotifications.message(booking), buttons: ['知道了']
    }).catch(() => {});
  };
  try {
    if (!Notification.isSupported()) { fallback(); return; }
    const notification = new Notification({
      title: '抢到座位了！' + booking.seat,
      body: bookingNotifications.message(booking),
      icon: path.join(ROOT, 'public', 'app.png'), timeoutType: 'never'
    });
    activeNotifications.add(notification);
    notification.on('click', focusWindow);
    notification.on('close', () => activeNotifications.delete(notification));
    notification.on('failed', () => { activeNotifications.delete(notification); fallback(); });
    notification.show();
  } catch (e) { fallback(); }
}

const checkBooking = bookingNotifications.createTracker(showBookingNotification);
async function pollBooking() {
  if (notificationPending || quitting) return;
  notificationPending = true;
  try {
    const response = await fetch(URL + 'api/status', { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const status = await response.json();
      latestStatus = status;
      updateTray(status);
      for (const notice of [status.renewal?.notice, status.seatWatch?.notice]) {
        if (notice && !seenRenewalNotices.has(notice.id)) {
          seenRenewalNotices.add(notice.id);
          if (win) win.flashFrame(true);
          const fallback = () => { focusWindow(); dialog.showMessageBox(win, {
            type: notice.level === 'error' ? 'warning' : 'info', title: notice.title,
            message: notice.message, buttons: ['知道了']
          }).catch(() => {}); };
          try {
            if (!Notification.isSupported()) fallback();
            else {
              const notification = new Notification({ title: notice.title, body: notice.message, timeoutType: 'never' });
              activeNotifications.add(notification);
              notification.on('click', focusWindow);
              notification.on('close', () => activeNotifications.delete(notification));
              notification.on('failed', () => { activeNotifications.delete(notification); fallback(); });
              notification.show();
            }
          } catch (_) { fallback(); }
        }
      }
      if (status.success && status.booking && !claimedDesktopBookings.has(status.booking.id)) {
        const claimResponse = await fetch(URL + 'api/notification-claim', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: status.booking.id, channel: 'desktop' }), signal: AbortSignal.timeout(5000)
        });
        if (!claimResponse.ok) return;
        const claim = await claimResponse.json();
        if (claim.claimed || !claim.ok) checkBooking(status);
        claimedDesktopBookings.add(status.booking.id);
      }
    } else updateTray(null);
  } catch (e) { updateTray(null); }
  finally { notificationPending = false; }
}

/** 端口是否已经有人监听 */
function portReady() {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port: PORT }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
  });
}

async function startServer() {
  if (await portReady()) {
    console.log('[app] 检测到后端已在运行，直接使用');
    return;
  }
  serverProc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1', PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true                       // 不弹黑色控制台窗口
  });
  serverProc.stdout.on('data', d => process.stdout.write('[server] ' + d));
  serverProc.stderr.on('data', d => process.stderr.write('[server] ' + d));
  serverProc.on('exit', code => {
    if (!quitting) {
      dialog.showErrorBox('后端已退出', '座位助手后端进程意外结束（code ' + code + '）。请重启应用。');
      app.quit();
    }
  });

  for (let i = 0; i < 60; i++) {
    if (await portReady()) return;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('后端启动超时');
}

function createWindow() {
  win = new BrowserWindow({
    show: true,
    width: 1180,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    title: '座位助手',
    titleBarStyle: process.platform === 'win32' ? 'hidden' : 'default',
    titleBarOverlay: process.platform === 'win32' ? {
      color: '#f5f3ee', symbolColor: '#53695b', height: 38
    } : false,
    backgroundColor: '#f5f3ee',
    autoHideMenuBar: true,                  // 隐藏菜单栏（Alt 可临时呼出）
    icon: path.join(ROOT, 'public', 'app-book-chair.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  win.setMenuBarVisibility(false);
  win.loadURL(URL);

  // 外链走系统浏览器，不在应用内开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('http://127.0.0.1')) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; });
  win.on('focus', () => { if (win) win.flashFrame(false); });
  win.on('close', event => {
    if (!quitting && tray) { event.preventDefault(); win.hide(); }
  });
}

function updateTray(status) {
  if (!tray) return;
  const label = !status ? '连接中断' : status.pendingBooking ? '预约结果待确认'
    : status.seatWatch?.active ? '盯座中 · ' + status.seatWatch.target?.seat : status.seatWatch?.phase?.includes('unknown') ? '换座结果待核实'
    : status.renewal?.active ? '定时重约中' : status.renewal?.phase?.includes('unknown') ? '重约结果待核实'
    : status.running ? '正在抢座' : status.success ? '已成功 · ' + status.booking?.seat : '已停止';
  if (trayState === label) return;
  trayState = label;
  tray.setToolTip('座位助手 · ' + label);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: label, enabled: false },
    { label: '显示窗口', click: focusWindow },
    { label: '停止所有座位任务', enabled: !!(status?.running || status?.renewal?.active || status?.renewal?.busy || status?.seatWatch?.active || status?.seatWatch?.busy), click: async () => {
      try {
        await fetch(URL + 'api/stop', { method: 'POST', signal: AbortSignal.timeout(5000) });
        await pollBooking();
      } catch (e) { focusWindow(); dialog.showErrorBox('停止失败', '无法连接后端，请在窗口中检查任务状态。'); }
    } },
    { label: '创建桌面快捷方式', click: () => createShortcuts() },
    { type: 'separator' },
    { label: '退出（停止后台运行）', click: requestQuit }
  ]));
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(path.join(ROOT, 'public', 'app.png')).resize({ width: 16, height: 16 });
    tray = new Tray(img);
    updateTray(latestStatus);
    tray.on('double-click', focusWindow);
  } catch (e) { /* 托盘失败不影响使用 */ }
}

/** 在桌面创建快捷方式（用 Electron 自带 API，中文名/图标都稳妥） */
function createShortcuts(silent) {
  try {
    const desk = app.getPath('desktop');
    const icon = path.join(ROOT, 'public', 'app-book-chair.ico');
    const results = [];

    // ① 桌面应用（Electron，独立窗口）
    const r1 = shell.writeShortcutLink(path.join(desk, '座位助手.lnk'), {
      target: process.execPath,
      args: '"' + __dirname + '"',
      cwd: __dirname,
      icon: icon,
      iconIndex: 0,
      description: '图书馆座位预约助手（桌面应用）'
    });
    results.push('· 座位助手.lnk ' + (r1 ? '✓' : '✗'));

    // ② 轻量版：应用模式窗口（零依赖，走本机 Edge/Chrome）
    const vbs = path.join(ROOT, '座位助手.vbs');
    if (require('fs').existsSync(vbs)) {
      const r2 = shell.writeShortcutLink(path.join(desk, '座位助手 轻量版.lnk'), {
        target: vbs,
        cwd: ROOT,
        icon: icon,
        iconIndex: 0,
        description: '图书馆座位预约助手（应用窗口版）'
      });
      results.push('· 座位助手 轻量版.lnk ' + (r2 ? '✓' : '✗'));
    }

    console.log('[app] 快捷方式：' + results.join(' / ') + ' -> ' + desk);
    if (!silent && win) {
      dialog.showMessageBox(win, {
        type: 'info', title: '座位助手', message: '桌面快捷方式已创建',
        detail: results.join('\n') + '\n\n位置：' + desk
      });
    }
    return true;
  } catch (e) {
    console.error('[app] 创建快捷方式失败: ' + (e.message || e));
    if (!silent && win) dialog.showErrorBox('创建快捷方式失败', String(e.message || e));
    return false;
  }
}

app.setAppUserModelId('cn.edu.csu.libseat');

// 面板类界面不需要 GPU 加速；同时规避受限环境/虚拟机/远程桌面里 GPU 进程崩溃的问题
try { app.disableHardwareAcceleration(); } catch (e) { }
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-dev-shm-usage');
// 本应用只加载 127.0.0.1 的本地页面，默认关闭渲染进程沙箱以规避受限环境启动崩溃；
// 想恢复沙箱可设置 LIBSEAT_SANDBOX=1
if (process.env.LIBSEAT_SANDBOX !== '1') app.commandLine.appendSwitch('no-sandbox');
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

  app.whenReady().then(async () => {
    try {
      await startServer();
    } catch (e) {
      dialog.showErrorBox('启动失败', String(e.message || e));
      app.quit();
      return;
    }
    if (process.env.LIBSEAT_SHORTCUT) {
      const ok = createShortcuts(true);
      quitting = true;
      app.exit(ok ? 0 : 1);
      return;
    }

    createWindow();
    createTray();
    pollBooking();
    notificationTimer = setInterval(pollBooking, 1000);
  });

  app.on('window-all-closed', () => { if (!tray || quitting) { quitting = true; app.quit(); } });
  app.on('before-quit', () => {
    quitting = true;
    clearInterval(notificationTimer);
    for (const notification of activeNotifications) notification.close();
    try { if (serverProc) serverProc.kill(); } catch (e) { }
  });
}
