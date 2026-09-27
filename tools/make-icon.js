'use strict';
// Apply the approved book-and-chair logo; never redraw it procedurally.
// Source PNGs are size exports of design/logo/seat-assistant-logo.png.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const source = path.join(root, 'design', 'logo');
for (const name of ['app.png', 'app-192.png', 'app-512.png', 'app-180.png']) {
  fs.copyFileSync(path.join(source, 'app-assets', name), path.join(root, 'public', name));
}
for (const name of ['app.ico', 'app-book-chair.ico']) {
  fs.copyFileSync(path.join(source, 'seat-assistant-logo.ico'), path.join(root, 'public', name));
}
console.log('Approved book-and-chair logo applied to PNG and ICO app assets.');
