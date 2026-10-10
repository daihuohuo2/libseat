require('electron').contextBridge.exposeInMainWorld('seatAssistant', { desktopUI: true, customTitlebar: true, nativeNotifications: true });
