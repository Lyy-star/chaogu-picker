'use strict';

/**
 * 手动检查更新。
 *
 * 设计原则：
 * - 只有用户在界面上点「检查更新」才联网，不做后台自动检查、不主动弹窗。
 * - 查到新版本后可以一键下载安装包并启动安装（NSIS 安装包会覆盖旧版本）。
 * - 走 Electron 的网络栈（net.fetch），会自动跟随系统代理，国内网络也能用。
 * - 不依赖 electron-updater，少一个依赖，也避开它的代理和限流坑。
 */

const fs = require('fs');
const path = require('path');
const { once } = require('events');
const { app, shell, ipcMain, BrowserWindow, net } = require('electron');

const pkg = require('../package.json');

const CHECK_TIMEOUT_MS = 15 * 1000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

/** 发布仓库信息：优先用 build.publish，退回到 repository 字段 */
function repoInfo() {
  const pub = (pkg.build && Array.isArray(pkg.build.publish) && pkg.build.publish[0]) || {};
  let owner = pub.owner || '';
  let repo = pub.repo || '';
  const url = (pkg.repository && pkg.repository.url) || '';
  if ((!owner || !repo) && url) {
    const m = /github\.com[/:]([^/]+)\/([^/.#?]+)/.exec(url);
    if (m) {
      owner = owner || m[1];
      repo = repo || m[2].replace(/\.git$/, '');
    }
  }
  return { owner, repo };
}

const state = {
  status: 'idle', // idle | checking | available | not-available | downloading | downloaded | error
  current: app.getVersion(),
  latest: '',
  hasUpdate: false,
  notes: '',
  releaseUrl: '',
  assetName: '',
  assetUrl: '',
  file: '',
  progress: 0,
  received: 0,
  total: 0,
  message: '还没有检查过',
  error: '',
  checkedAt: null,
};

function snapshot() {
  return JSON.parse(JSON.stringify(state));
}

function broadcast() {
  const payload = snapshot();
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send('update:status', payload);
    } catch (_) {
      /* 窗口正在关闭，忽略 */
    }
  }
}

function patch(next) {
  Object.assign(state, next);
  broadcast();
  return snapshot();
}

function cmp(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function friendlyError(err) {
  const raw = (err && err.message) || String(err);
  if (/timeout|timed out|aborted/i.test(raw)) return '连接超时，检查一下网络或代理再试';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|fetch failed|net::ERR/i.test(raw)) {
    return '连不上 GitHub（国内网络常见），挂上代理再点一次';
  }
  return raw;
}

/** 用 releases/latest 的跳转拿最新 tag，不吃 API 限流 */
async function fetchLatestTag(owner, repo) {
  const res = await net.fetch(`https://github.com/${owner}/${repo}/releases/latest`, {
    redirect: 'follow',
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  const m = /\/releases\/tag\/([^/?#]+)/.exec(res.url || '');
  return m ? decodeURIComponent(m[1]) : '';
}

/** 拿 Release 详情（更新说明、资产列表），失败不影响主流程 */
async function fetchRelease(owner, repo, tag) {
  try {
    const res = await net.fetch(
      `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`,
      {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'chaogu-picker' },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

/** API 拿不到资产列表时，按打包配置里的命名规则拼下载地址 */
function assetUrlFromTemplate(owner, repo, tag) {
  const b = pkg.build || {};
  const tpl = (b.nsis && b.nsis.artifactName) || '';
  if (!tpl) return { name: '', url: '' };
  const version = String(tag).replace(/^v/, '');
  const name = tpl.replace(/\$\{version\}/g, version).replace(/\$\{ext\}/g, 'exe');
  return { name, url: `https://github.com/${owner}/${repo}/releases/download/${tag}/${name}` };
}

async function check() {
  const { owner, repo } = repoInfo();
  if (!owner || !repo) {
    return patch({ status: 'error', error: '没有配置发布仓库信息', message: '检查失败' });
  }

  patch({ status: 'checking', error: '', message: '正在检查更新…', progress: 0, file: '' });

  try {
    const tag = await fetchLatestTag(owner, repo);
    if (!tag) {
      return patch({
        status: 'not-available',
        latest: '',
        hasUpdate: false,
        message: '线上还没有发布过版本',
        checkedAt: Date.now(),
      });
    }

    const latest = tag.replace(/^v/, '');
    const hasUpdate = cmp(latest, state.current) > 0;
    const rel = await fetchRelease(owner, repo, tag);
    const assets = (rel && rel.assets) || [];
    const setup =
      assets.find((a) => /setup\.exe$/i.test(a.name)) ||
      assets.find((a) => /\.exe$/i.test(a.name)) ||
      null;
    const fallback = assetUrlFromTemplate(owner, repo, tag);

    return patch({
      status: hasUpdate ? 'available' : 'not-available',
      latest,
      hasUpdate,
      notes: (rel && rel.body) || '',
      releaseUrl: (rel && rel.html_url) || `https://github.com/${owner}/${repo}/releases/tag/${tag}`,
      assetName: setup ? setup.name : fallback.name,
      assetUrl: setup ? setup.browser_download_url : fallback.url,
      message: hasUpdate ? `发现新版本 v${latest}` : `已经是最新版本（v${latest}）`,
      error: '',
      checkedAt: Date.now(),
    });
  } catch (err) {
    return patch({ status: 'error', error: friendlyError(err), message: '检查失败' });
  }
}

async function download(url) {
  const dir = path.join(app.getPath('temp'), 'chaogu-picker-update');
  fs.mkdirSync(dir, { recursive: true });
  const name = path.basename(new URL(url).pathname) || 'chaogu-picker-setup.exe';
  const file = path.join(dir, name);

  const res = await net.fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  if (!res.body) throw new Error('下载失败：没有数据返回');

  const total = Number(res.headers.get('content-length')) || 0;
  patch({ status: 'downloading', progress: 0, received: 0, total, message: '正在下载新版本…' });

  const out = fs.createWriteStream(file);
  const reader = res.body.getReader();
  let received = 0;
  let lastTick = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (!out.write(Buffer.from(value))) await once(out, 'drain');
      if (Date.now() - lastTick > 300) {
        lastTick = Date.now();
        patch({
          progress: total ? Math.min(100, Math.round((received / total) * 100)) : 0,
          received,
        });
      }
    }
  } finally {
    out.end();
    await once(out, 'finish');
  }

  if (!fs.existsSync(file) || fs.statSync(file).size < 1024 * 1024) {
    throw new Error('下载的文件不完整，请重试');
  }
  return file;
}

/** 下载安装包 → 启动它 → 退出自己，让安装程序覆盖旧版本 */
async function downloadAndInstall() {
  try {
    const url = state.assetUrl || assetUrlFromTemplate(repoInfo().owner, repoInfo().repo, `v${state.latest}`).url;
    if (!url) throw new Error('没有找到安装包地址');

    const file = await download(url);
    patch({ status: 'downloaded', file, progress: 100, message: '下载完成，正在启动安装程序…' });

    const err = await shell.openPath(file);
    if (err) throw new Error(`打不开安装包：${err}`);

    setTimeout(() => app.quit(), 1500);
    return snapshot();
  } catch (err) {
    return patch({ status: 'error', error: friendlyError(err), message: '更新失败' });
  }
}

function openReleasePage() {
  const { owner, repo } = repoInfo();
  const url = state.releaseUrl || (owner && repo ? `https://github.com/${owner}/${repo}/releases/latest` : '');
  if (url) shell.openExternal(url);
  return Boolean(url);
}

function init() {
  ipcMain.handle('update:state', () => snapshot());
  ipcMain.handle('update:check', () => check());
  ipcMain.handle('update:install', () => downloadAndInstall());
  ipcMain.handle('update:open-page', () => openReleasePage());
}

module.exports = { init, snapshot };
