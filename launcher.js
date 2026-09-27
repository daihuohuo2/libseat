/**
 * 座位助手 —— 桌面启动器
 * ------------------------------------------------------------
 * 双击「座位助手.vbs」时由它隐式调用本脚本：
 *   1. 若后端没在跑，就静默启动 server.js（无控制台窗口）
 *   2. 用 Edge/Chrome 的【应用模式】打开一个独立窗口（无地址栏、无标签页、独立图标）
 *   3. 关闭该窗口后，自动结束后端进程
 *
 * 参数：
 *   --check     只做环境检查与预演，不打开窗口（用于自检）
 *   --port=N    指定端口（默认 8848）
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const ROOT = __dirname;
const arg = k => (process.argv.find(a => a.startsWith('--' + k + '=')) || '').split('=')[1];
const PORT = Number(arg('port') || process.env.LIBSEAT_PORT) || 8848;
const URL = 'http://127.0.0.1:' + PORT + '/';
const CHECK_ONLY = process.argv.includes('--check');
const APP_PROFILE = path.join(ROOT, '.app-profile');

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function portReady() {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port: PORT }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
  });
}

function fail(msg) {
  console.error('✗ ' + msg);
  try { fs.writeFileSync(path.join(ROOT, '启动错误.log'), new Date().toLocaleString('zh-CN') + '  ' + msg + '\n', 'utf8'); } catch (e) { }
  process.exit(1);
}

(async () => {
  const exe = BROWSERS.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
  if (!exe) return fail('未找到 Edge 或 Chrome，请先安装浏览器');

  let serverChild = null;
  let owned = false;

  if (await portReady()) {
    console.log('· 后端已在运行，直接打开应用窗口');
  } else {
    console.log('· 正在启动后端服务...');
    if (CHECK_ONLY) {
      console.log('  （预演模式：不实际启动）');
    } else {
      fs.mkdirSync(ROOT, { recursive: true });
      serverChild = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
        cwd: ROOT, stdio: 'ignore', windowsHide: true, detached: false,
        env: Object.assign({}, process.env, { PORT: String(PORT) })
      });
      owned = true;
      serverChild.on('exit', (c, sig) => {
        if (owned && !sig) console.log('· 后端进程已退出（code ' + c + '）');
      });

      let up = false;
      for (let i = 0; i < 80; i++) {
        if (await portReady()) { up = true; break; }
        await sleep(250);
      }
      if (!up) return fail('后端启动超时（端口 ' + PORT + ' 无响应）');
      console.log('· 后端已就绪 ' + URL);
    }
  }

  if (CHECK_ONLY) {
    console.log('✓ 环境检查通过');
    console.log('  浏览器: ' + exe);
    console.log('  后端: ' + (await portReady() ? '运行中' : '未运行（正式启动时会自动拉起）'));
    if (serverChild) serverChild.kill();
    process.exit(0);
  }

  console.log('· 正在打开应用窗口（关闭窗口即结束）');
  const app = spawn(exe, [
    '--app=' + URL,
    '--user-data-dir=' + APP_PROFILE,   // 独立配置目录：这样能拿到我们自己的进程，关窗即可收工
    '--window-size=1180,880',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msEdgeSidebarV2'
  ], { stdio: 'ignore', windowsHide: false });

  app.on('exit', () => {
    if (owned && serverChild) {
      try { serverChild.kill(); } catch (e) { }
      console.log('· 窗口已关闭，后端服务已结束');
    } else {
      console.log('· 窗口已关闭（后端由其它方式启动，保持运行）');
    }
    process.exit(0);
  });
})();
