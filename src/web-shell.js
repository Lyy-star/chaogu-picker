'use strict';

/**
 * 无 Electron 时的桌面外壳：
 * 启动本地服务，并用 Edge/Chrome 的 --app 模式开一个无地址栏的独立窗口，
 * 观感上接近桌面应用（没有 Electron 依赖）。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const cfg = require('./config');
const { start } = require('./server');

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function findBrowser() {
  return BROWSERS.find((p) => fs.existsSync(p));
}

(async () => {
  const server = await start(cfg.PORT);
  const url = `http://127.0.0.1:${server.address().port}/`;
  console.log(`服务已启动: ${url}`);

  const browser = findBrowser();
  if (browser) {
    const dir = require('path').join(cfg.USER_DIR, 'browser-profile');
    const child = spawn(
      browser,
      [`--app=${url}`, `--user-data-dir=${dir}`, '--window-size=1440,920', '--no-first-run'],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    console.log(`已用 ${require('path').basename(browser)} 打开应用窗口`);
  } else {
    console.log(`没找到 Edge/Chrome，请手动打开: ${url}`);
  }
})();
