'use strict';

/**
 * 用 Electron 离屏截图做视觉验收。
 * 用法: npx electron scripts/screenshot.js [tab]
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const cfg = require('../src/config');
const { start } = require('../src/server');

const tab = process.argv[2] || 'top';
const outDir = path.join(cfg.ROOT, '.cache');

app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();
// 截图用的 Chromium 缓存放进项目内，不污染用户目录
app.setPath('userData', path.join(cfg.ROOT, '.cache', 'electron-profile'));

async function shoot() {
  const server = await start(cfg.PORT);
  const port = server.address().port;
  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    show: false,
    backgroundColor: '#0f1115',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  await win.loadURL(`http://127.0.0.1:${port}/`);

  // 等选股结果回来（最多 90 秒）
  await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        const rows = document.querySelectorAll('.row').length;
        const cards = document.querySelectorAll('.ev-card').length;
        if ((rows > 0 && !document.querySelector('.loading')) || cards > 0) {
          clearInterval(timer);
          resolve('ok');
        } else if (Date.now() - t0 > 90000) {
          clearInterval(timer);
          resolve('timeout');
        }
      }, 500);
    })
  `);

  if (tab !== 'top') {
    await win.webContents.executeJavaScript(`
      (() => {
        const btn = document.querySelector('.tab[data-tab="${tab}"]');
        if (btn) btn.click();
        return true;
      })()
    `);
    await new Promise((r) => setTimeout(r, tab === 'calendar' ? 4000 : 2500));
  }

  // 详情页截图
  if (tab === 'detail') {
    await win.webContents.executeJavaScript(`
      (() => {
        const row = document.querySelector('.row');
        if (row) row.click();
        return !!row;
      })()
    `);
    await new Promise((r) => setTimeout(r, 6000));
  }

  const img = await win.webContents.capturePage();
  const file = path.join(outDir, `shot-${tab}.png`);
  fs.writeFileSync(file, img.toPNG());
  console.log(`截图已保存: ${file}`);

  const errors = await win.webContents.executeJavaScript('window.__errors || []');
  if (errors && errors.length) console.log('页面错误:', JSON.stringify(errors));

  server.close();
  app.quit();
}

app.whenReady().then(() =>
  shoot().catch((err) => {
    console.error('截图失败:', err);
    app.quit();
  }),
);
