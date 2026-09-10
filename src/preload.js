'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chaogu', {
  isDesktop: true,

  // 手动检查更新：只有界面点了「检查更新」才会触发
  updates: {
    getState: () => ipcRenderer.invoke('update:state'),
    check: () => ipcRenderer.invoke('update:check'),
    downloadAndInstall: () => ipcRenderer.invoke('update:install'),
    openReleasePage: () => ipcRenderer.invoke('update:open-page'),
    onStatus: (cb) => {
      const handler = (_event, status) => cb(status);
      ipcRenderer.on('update:status', handler);
      return () => ipcRenderer.removeListener('update:status', handler);
    },
  },
});
