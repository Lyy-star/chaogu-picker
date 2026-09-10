'use strict';

/**
 * Electron 主进程：启动本地服务并开一个应用窗口。
 * 没有 Electron 时可以用 npm run web 走浏览器外壳（见 src/web-shell.js）。
 */

const path = require('path');

let electron;
try {
  // eslint-disable-next-line global-require, import/no-extraneous-dependencies
  electron = require('electron');
} catch (_) {
  console.error('未安装 Electron，请先执行: npm install\n或者改用: npm run web');
  process.exit(1);
}

const { app, BrowserWindow, shell, ipcMain } = electron;
const cfg = require('./config');
const { start } = require('./server');

const APP_ID = 'com.lyy.chaogupicker';
const ICON_FILE = path.join(__dirname, '..', 'assets', 'chaogu.ico');

let mainWindow = null;
let server = null;

async function bootstrap() {
  server = await start(cfg.PORT);
  const { port } = server.address();
  return `http://127.0.0.1:${port}/`;
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#0f1115',
    title: 'lyy创意选股',
    icon: ICON_FILE,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadURL(url);

  // 外部链接（公告原文等）用系统浏览器打开，不在应用内跳走
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Windows 上让任务栏图标/通知归到同一个 AppUserModelID
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

app.whenReady().then(async () => {
  try {
    const url = await bootstrap();
    createWindow(url);
  } catch (err) {
    console.error('启动失败:', err.message);
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && server) {
      createWindow(`http://127.0.0.1:${cfg.PORT}/`);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (server) server.close();
});

ipcMain.handle('app-info', () => ({ version: app.getVersion(), port: cfg.PORT }));
