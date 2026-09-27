'use strict';
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('seatAssistant', {
  nativeNotifications: true,
  desktopUI: true,
  customTitlebar: process.platform === 'win32'
});
window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.classList.add('desktop-app');
  if (process.platform === 'win32') document.documentElement.classList.add('custom-titlebar');
});
