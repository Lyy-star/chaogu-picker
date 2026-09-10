'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chaogu', {
  isDesktop: true,
  appInfo: () => ipcRenderer.invoke('app-info'),
});
