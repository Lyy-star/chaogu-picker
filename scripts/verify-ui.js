'use strict';

/**
 * 界面自检（不需要人眼看图）：
 *  - 捕获渲染进程的 JS 错误与 console.error
 *  - 检查布局是否有横向溢出、行列是否对齐
 *  - 检查 canvas 是否真的画出了内容（统计非背景像素）
 *  - 检查关键文案是否渲染出来
 * 用法: npx electron scripts/verify-ui.js
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const cfg = require('../src/config');
const { start } = require('../src/server');

app.disableHardwareAcceleration();
// 自检用的 Chromium 缓存放进项目内，不污染用户目录，受限环境也写得进去
app.setPath('userData', path.join(cfg.ROOT, '.cache', 'electron-profile'));

const logs = [];

async function waitFor(win, expr, timeoutMs, label) {
  const ok = await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        let v = false;
        try { v = (${expr}); } catch (e) { v = false; }
        if (v) { clearInterval(timer); resolve(true); }
        else if (Date.now() - t0 > ${timeoutMs}) { clearInterval(timer); resolve(false); }
      }, 400);
    })
  `);
  console.log(`${ok ? 'OK  ' : 'FAIL'} 等待 ${label}`);
  return ok;
}

async function shot(win, name) {
  const img = await win.webContents.capturePage();
  const file = path.join(cfg.ROOT, '.cache', `ui-${name}.png`);
  fs.writeFileSync(file, img.toPNG());
  return file;
}

async function run() {
  const server = await start(cfg.PORT);
  const port = server.address().port;
  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    show: false,
    backgroundColor: '#0f1115',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  win.webContents.on('console-message', (_e, level, message) => {
    logs.push(`[console:${level}] ${message}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    logs.push(`[render-gone] ${JSON.stringify(details)}`);
  });

  await win.loadURL(`http://127.0.0.1:${port}/`);
  await waitFor(win, "document.querySelectorAll('.row').length > 0 && !document.querySelector('.loading')", 120000, '今日推荐列表渲染');

  const layout = await win.webContents.executeJavaScript(`
    (() => {
      const head = document.querySelector('.list-head');
      const row = document.querySelector('.row');
      const cols = (node) => node ? [...node.children].map(c => Math.round(c.getBoundingClientRect().width)) : [];
      return {
        rows: document.querySelectorAll('.row').length,
        headCols: cols(head),
        rowCols: cols(row),
        bodyScrollW: document.body.scrollWidth,
        innerW: window.innerWidth,
        status: document.querySelector('#statusText').textContent,
        headline: document.querySelector('#catHeadline').textContent,
        marketIdx: document.querySelectorAll('.idx').length,
        firstRowText: row ? row.innerText.replace(/\\n/g, ' | ') : '',
      };
    })()
  `);
  console.log('\n--- 布局 ---');
  console.log(`列表行数: ${layout.rows}`);
  console.log(`表头列宽: ${layout.headCols.join(', ')}`);
  console.log(`数据行列宽: ${layout.rowCols.join(', ')}`);
  console.log(`列数一致: ${layout.headCols.length === layout.rowCols.length ? 'OK' : 'FAIL'}`);
  console.log(`横向溢出: ${layout.bodyScrollW > layout.innerW ? 'FAIL ' + layout.bodyScrollW + ' > ' + layout.innerW : 'OK'}`);
  console.log(`顶部行情项: ${layout.marketIdx}`);
  console.log(`状态文本: ${layout.status}`);
  console.log(`标题: ${layout.headline}`);
  console.log(`首行: ${layout.firstRowText}`);
  await shot(win, 'list');

  /* 打开详情页 */
  await win.webContents.executeJavaScript("document.querySelector('.row').click(); true");
  await waitFor(win, "document.querySelector('#kCanvas') && document.querySelector('#trendCanvas')", 30000, '详情抽屉');
  await waitFor(win, "!document.querySelector('#detail .loading')", 40000, '详情数据加载');
  await new Promise((r) => setTimeout(r, 1200));

  const detail = await win.webContents.executeJavaScript(`
    (() => {
      const pixels = (id) => {
        const c = document.querySelector(id);
        if (!c) return null;
        const ctx = c.getContext('2d');
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let painted = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted += 1;
        return { w: c.width, h: c.height, painted, ratio: +(painted / (c.width * c.height)).toFixed(4) };
      };
      return {
        cards: document.querySelectorAll('#detail .card').length,
        planCells: document.querySelectorAll('#detail .plan-cell').length,
        sellRules: document.querySelectorAll('#detail .card ul.plain li').length,
        evidence: document.querySelectorAll('#detail .evi').length,
        title: document.querySelector('#detail h2') ? document.querySelector('#detail h2').textContent : '',
        price: document.querySelector('#detail .detail-price') ? document.querySelector('#detail .detail-price').innerText.replace(/\\n/g,' ') : '',
        trend: pixels('#trendCanvas'),
        kline: pixels('#kCanvas'),
        detailScrollW: document.querySelector('#detailInner').scrollWidth,
        detailClientW: document.querySelector('#detailInner').clientWidth,
      };
    })()
  `);
  console.log('\n--- 详情页 ---');
  console.log(`标题: ${detail.title} | ${detail.price}`);
  console.log(`卡片数: ${detail.cards} 计划格: ${detail.planCells} 卖出纪律条数: ${detail.sellRules} 消息条数: ${detail.evidence}`);
  console.log(`分时 canvas: ${JSON.stringify(detail.trend)}`);
  console.log(`日线 canvas: ${JSON.stringify(detail.kline)}`);
  console.log(`详情横向溢出: ${detail.detailScrollW > detail.detailClientW ? 'FAIL' : 'OK'}`);
  await shot(win, 'detail');

  /* 事件日历 */
  await win.webContents.executeJavaScript("document.querySelector('.close-btn').click(); document.querySelector('.tab[data-tab=\"calendar\"]').click(); true");
  await waitFor(win, "document.querySelectorAll('.ev-card').length > 0", 60000, '事件日历');
  const cal = await win.webContents.executeJavaScript(`
    (() => ({
      cards: document.querySelectorAll('.ev-card').length,
      first: document.querySelector('.ev-card') ? document.querySelector('.ev-card').innerText.replace(/\\n/g, ' | ') : '',
      badges: document.querySelectorAll('.ev-card .badge').length,
    }))()
  `);
  console.log('\n--- 事件日历 ---');
  console.log(`事件卡片: ${cal.cards} 标签: ${cal.badges}`);
  console.log(`第一个事件: ${cal.first}`);
  await shot(win, 'calendar');

  /* 消息类 & 情绪类 & 基本面类 */
  for (const tab of ['news', 'event', 'sentiment', 'fundamental']) {
    await win.webContents.executeJavaScript(`document.querySelector('.tab[data-tab="${tab}"]').click(); true`);
    await new Promise((r) => setTimeout(r, 700));
    const info = await win.webContents.executeJavaScript(`
      (() => {
        const row = document.querySelector('.row');
        return {
          rows: document.querySelectorAll('.row').length,
          first: row ? row.innerText.replace(/\\n/g, ' | ') : '',
          headline: document.querySelector('#catHeadline').textContent,
        };
      })()
    `);
    console.log(`\n--- ${tab} ---`);
    console.log(`行数 ${info.rows}`);
    console.log(`标题 ${info.headline}`);
    console.log(`首行 ${info.first.slice(0, 200)}`);
    await shot(win, tab);
  }

  /* 基本面类详情（看公司基本面卡片有没有渲染出来） */
  await win.webContents.executeJavaScript("document.querySelector('.tab[data-tab=\"fundamental\"]').click(); true");
  await new Promise((r) => setTimeout(r, 500));
  await win.webContents.executeJavaScript("document.querySelector('.row').click(); true");
  await waitFor(win, "document.querySelector('#detail .kv') !== null && !document.querySelector('#detail .loading')", 40000, '基本面详情');
  const fund = await win.webContents.executeJavaScript(`
    (() => {
      const cards = [...document.querySelectorAll('#detail .card')];
      const card = cards.find((c) => c.innerText.includes('公司基本面'));
      return {
        found: !!card,
        title: card ? card.querySelector('h3').innerText.replace(/\\n/g, ' ') : '',
        kvs: card ? card.querySelectorAll('.kv').length : 0,
        text: card ? card.innerText.replace(/\\n/g, ' | ').slice(0, 420) : '',
      };
    })()
  `);
  console.log('\n--- 基本面卡片 ---');
  console.log(`存在: ${fund.found ? 'OK' : 'FAIL'} | ${fund.title} | 指标数 ${fund.kvs}`);
  console.log(`内容: ${fund.text}`);
  await shot(win, 'fundamental-detail');

  /* 自选 */
  await win.webContents.executeJavaScript("document.querySelector('.tab[data-tab=\"watch\"]').click(); true");
  await new Promise((r) => setTimeout(r, 800));
  const watch = await win.webContents.executeJavaScript("document.querySelector('#list').innerText.split('\\n')[0]");
  console.log(`\n--- 自选 ---\n${watch}`);

  /* 我的模拟盘 */
  await win.webContents.executeJavaScript("document.querySelector('.tab[data-tab=\"portfolio\"]').click(); true");
  await waitFor(win, "document.querySelector('.pf-stats') !== null", 90000, '模拟盘页面');
  await new Promise((r) => setTimeout(r, 900));
  const pf = await win.webContents.executeJavaScript(`
    (() => {
      const c = document.querySelector('#equityCanvas');
      let painted = null;
      if (c) {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n += 1;
        painted = { w: c.width, h: c.height, painted: n, ratio: +(n / (c.width * c.height)).toFixed(4) };
      }
      const txt = (sel, len) => {
        const n = document.querySelector(sel);
        return n ? n.innerText.replace(/\\n/g, ' | ').slice(0, len || 300) : '';
      };
      const content = document.querySelector('.content');
      return {
        stats: document.querySelectorAll('.pf-stat').length,
        statText: [...document.querySelectorAll('.pf-stat')].map((n) => n.innerText.replace(/\\n/g, ' ')).join(' | '),
        headline: txt('.pf-headline', 300),
        days: document.querySelectorAll('.pf-day').length,
        daySummaries: [...document.querySelectorAll('.pf-day summary')].map((n) => n.innerText.replace(/\\n/g, ' ')).join(' || '),
        tables: document.querySelectorAll('.pf-table').length,
        tradeRows: document.querySelectorAll('.pf-trade').length,
        heldRows: document.querySelectorAll('.pf-row').length,
        cands: document.querySelectorAll('.pf-cand').length,
        today: txt('.pf-today', 900),
        equity: painted,
        contentScrollW: content.scrollWidth,
        contentClientW: content.clientWidth,
      };
    })()
  `);
  console.log('\n--- 我的模拟盘 ---');
  console.log(`指标卡: ${pf.stats}`);
  console.log(`关键数字: ${pf.statText}`);
  console.log(`今日结论: ${pf.headline}`);
  console.log(`记录天数: ${pf.days}`);
  console.log(`每日摘要: ${pf.daySummaries}`);
  console.log(`表格数: ${pf.tables} 成交行: ${pf.tradeRows} 持仓行: ${pf.heldRows} 候选: ${pf.cands}`);
  console.log(`今日记录: ${pf.today.slice(0, 700)}`);
  console.log(`净值 canvas: ${JSON.stringify(pf.equity)}`);
  console.log(`内容区横向溢出: ${pf.contentScrollW > pf.contentClientW ? 'FAIL ' + pf.contentScrollW + ' > ' + pf.contentClientW : 'OK'}`);
  await shot(win, 'portfolio');

  console.log('\n--- 控制台输出 ---');
  if (!logs.length) console.log('（无错误）');
  else logs.slice(0, 40).forEach((l) => console.log(l));

  server.close();
  app.quit();
}

app.whenReady().then(() =>
  run().catch((err) => {
    console.error('自检失败:', err);
    if (logs.length) logs.forEach((l) => console.log(l));
    app.quit();
  }),
);
