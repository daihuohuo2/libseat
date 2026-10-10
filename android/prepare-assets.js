const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const out = path.join(__dirname, 'build', 'assets');
fs.mkdirSync(out, { recursive: true });
// Explicit allowlist: never package desktop config, cookies, browser profiles, or logs.
const assets = ['index.html','warm-study.css','warm-study.js','study-font.css','study-sans-0.ttf','study-sans-1.ttf','booking-notifications.js','booking-celebration.css','booking-celebration.js','app-192.png','app-512.png','app.png'];
assets.push('seat-map.css', 'seat-map.js');
assets.push('booking-management.css', 'booking-management-ui.js', 'renewal.css', 'renewal-ui.js');
assets.push('compact-ui.css');
assets.push('area-seat-prefs.js', 'area-seat-prefs-ui.js', 'area-seat-prefs.css');
for (const name of assets) fs.copyFileSync(path.join(root, 'public', name), path.join(out, name));
for (const name of ['engine-runtime.js','mobile-bridge.js','mobile-ui.js','mobile.css']) fs.copyFileSync(path.join(__dirname,'web',name),path.join(out,name));
let html = fs.readFileSync(path.join(out,'index.html'),'utf8');
html = html.replace('<head>', '<head>\n<script src="/mobile-bridge.js"></script>\n<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\' \'unsafe-inline\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' https: data:; connect-src \'self\'; frame-src \'none\'; object-src \'none\'; base-uri \'none\'">');
html = html.replace(/<link[^>]+(?:manifest|apple-touch-icon|app-book-chair|desktop-study)[^>]*>\s*/g,'').replace(/<script src="\/desktop-study\.js(?:\?[^"<>]*)?"><\/script>/g,'');
html = html.replace('</head>','<link rel="stylesheet" href="/mobile.css">\n</head>').replace('</body>','<script src="/mobile-ui.js"></script>\n</body>');
html = html.replace("if('serviceWorker' in navigator && location.protocol.startsWith('http'))",'if(false)');
fs.writeFileSync(path.join(out,'index.html'),html);
let bundle = '';
for (const name of ['public/area-seat-prefs.js','seat-prefs.js','booking-store.js','booking-management.js','renewal.js','booking-window.js','booking-protocol.js','reservation-records.js','server.js','android-demo.js']) {
  const file = name === 'android-demo.js' ? path.join(__dirname,'web',name) : path.join(root,name);
  const src = fs.readFileSync(file,'utf8').replace(/^#!.*\r?\n/,'');
  bundle += `defineModule(${JSON.stringify('./'+name)}, function(module, exports, require, __dirname) {\n${src}\n});\n`;
}
bundle += 'startAndroidEngine();\n';
fs.writeFileSync(path.join(out,'engine-bundle.js'),bundle);
fs.writeFileSync(path.join(out,'engine.html'),'<!doctype html><meta charset="utf-8"><script src="/engine-runtime.js"></script><script src="/engine-bundle.js"></script>');
fs.mkdirSync(path.join(__dirname,'res','drawable'),{recursive:true});
fs.copyFileSync(path.join(root,'public','app-192.png'),path.join(__dirname,'res','drawable','app_icon.png'));
console.log('Prepared Android assets (no account data).');
