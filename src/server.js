'use strict';

/**
 * 本地 HTTP 服务：给 Electron / 浏览器外壳提供接口和静态页面。
 * 只用 Node 内置模块，无第三方依赖。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const em = require('./data/eastmoney');
const picker = require('./engine/picker');
const eventsEngine = require('./engine/events');
const fundamentalsEngine = require('./engine/fundamentals');
const portfolio = require('./engine/portfolio');
const mirror = require('./lib/mirror');
const { cached, invalidate } = require('./lib/cache');
const { buildContext, mergeLiveBar } = require('./engine/indicators');
const { buildPlan } = require('./engine/strategy');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJSON(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, err, status = 500) {
  sendJSON(res, { ok: false, error: err && err.message ? err.message : String(err) }, status);
}

/* ------------------------------------------------------------------ */
/* 业务接口                                                            */
/* ------------------------------------------------------------------ */

/** 选股结果：服务端缓存 90 秒，避免频繁触发上游限流 */
function getPicks(force) {
  return cached('picks', 90 * 1000, () => picker.pickAll({ force: false }), {
    force,
    disk: false,
    allowStale: true,
  });
}

/**
 * 模拟盘：跑一遍"每日流程"，把今天的买卖/持有记进日志。
 * 选股结果复用上面的缓存，所以除了第一次抓全市场，之后都很轻。
 */
async function getPortfolio(force = false) {
  const picks = await getPicks(false).catch(() => null);
  return cached(
    'portfolio_snapshot',
    45 * 1000,
    () => portfolio.run({ picks, force }),
    { force, disk: false, allowStale: true },
  );
}

async function apiOverview() {
  const [overview, breadth, sentiment] = await Promise.all([
    em.marketOverview().catch(() => ({ indexes: [] })),
    em.marketBreadth().catch(() => null),
    em.sentimentGauge().catch(() => null),
  ]);
  return { ...overview, breadth, sentiment, mirror: mirror.status() };
}

async function apiStock(code) {
  const [quote, trends, k, flow, anns, news, fundamentals] = await Promise.all([
    em.quote(code).catch(() => null),
    em.minuteTrends(code, 1).catch(() => null),
    em.kline(code, { limit: 160 }).catch(() => null),
    em.stockFlow(code, { limit: 10 }).catch(() => []),
    em.announcements(1, 20, code).catch(() => []),
    em.stockNews(code, 8).catch(() => []),
    fundamentalsEngine.fundamentalDetail(code).catch(() => null),
  ]);
  const bars = k && k.bars ? mergeLiveBar(k.bars, quote || {}) : null;
  const ctx = bars ? buildContext(bars, quote && quote.price) : null;
  return {
    code,
    quote,
    trends,
    kline: k ? { name: k.name, source: k.source, bars } : null,
    tech: ctx,
    flow,
    announcements: anns,
    news,
    fundamentals,
    // 给详情页一个"通用交易计划"（按情绪类风格，用户在详情页可切换视角）
    plan: ctx && quote
      ? buildPlan({ quote, ctx, category: 'sentiment', score: 65, extra: {} })
      : null,
    at: Date.now(),
  };
}

function apiEvents() {
  return cached('events_list', 5 * 60 * 1000, async () => {
    const [news, boardsChange, boardsFlow] = await Promise.all([
      em.newsFlash(1, 50).catch(() => []),
      em.boardRank('concept', 'change', 100).catch(() => []),
      em.boardRank('concept', 'flow', 100).catch(() => []),
    ]);
    const boardMap = new Map();
    for (const b of boardsChange) boardMap.set(b.code, b);
    for (const b of boardsFlow) boardMap.set(b.code, { ...(boardMap.get(b.code) || {}), ...b });
    const boards = [...boardMap.values()];
    const events = eventsEngine
      .upcoming(news, { windowDays: cfg.EVENT_WINDOW_DAYS })
      .map((e) => ({
        ...e,
        matchedBoards: eventsEngine.matchBoards(e, boards).slice(0, 4).map((b) => ({
          code: b.code,
          name: b.name,
          changePct: b.changePct,
        })),
      }));
    return { events, at: Date.now() };
  }, { allowStale: true });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* 静态文件                                                            */
/* ------------------------------------------------------------------ */

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(cfg.WEB_DIR, rel);
  // 防目录穿越
  if (!filePath.startsWith(cfg.WEB_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const p = url.pathname;

  if (p.startsWith('/api/')) {
    try {
      if (p === '/api/health') {
        return sendJSON(res, { ok: true, at: Date.now(), port: cfg.PORT, mirror: mirror.status() });
      }
      if (p === '/api/overview') {
        return sendJSON(res, { ok: true, data: await apiOverview() });
      }
      if (p === '/api/picks') {
        const force = url.searchParams.get('force') === '1';
        const data = await getPicks(force);
        return sendJSON(res, { ok: true, data });
      }
      if (p === '/api/portfolio') {
        if (req.method === 'GET') {
          const force = url.searchParams.get('force') === '1';
          return sendJSON(res, { ok: true, data: await getPortfolio(force) });
        }
        if (req.method === 'POST') {
          // 手动触发一次记录（相当于"今天也来看看盘"）
          return sendJSON(res, { ok: true, data: await getPortfolio(true) });
        }
      }
      if (p === '/api/portfolio/reset' && req.method === 'POST') {
        invalidate('portfolio_snapshot');
        const out = portfolio.reset();
        return sendJSON(res, { ok: true, data: out });
      }
      if (p === '/api/events') {
        if (req.method === 'GET') {
          return sendJSON(res, { ok: true, data: await apiEvents() });
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          const list = eventsEngine.loadCustom();
          const item = {
            id: body.id || `custom-${Date.now()}`,
            name: body.name,
            date: body.date,
            endDate: body.endDate || body.date,
            category: body.category || '自定义事件',
            level: Number(body.level) || 3,
            themes: body.themes || [],
            impact: body.impact || '',
            verify: false,
            source: '自定义',
          };
          if (!item.name || !item.date) return sendError(res, new Error('name 与 date 必填'), 400);
          const next = [...list.filter((x) => x.id !== item.id), item];
          eventsEngine.saveCustom(next);
          return sendJSON(res, { ok: true, data: item });
        }
        if (req.method === 'DELETE') {
          const id = url.searchParams.get('id');
          const list = eventsEngine.loadCustom().filter((x) => x.id !== id);
          eventsEngine.saveCustom(list);
          return sendJSON(res, { ok: true });
        }
      }
      const stockMatch = p.match(/^\/api\/stock\/(\d{6})$/);
      if (stockMatch) {
        return sendJSON(res, { ok: true, data: await apiStock(stockMatch[1]) });
      }
      return sendError(res, new Error('接口不存在'), 404);
    } catch (err) {
      return sendError(res, err);
    }
  }

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
  res.writeHead(405);
  res.end('method not allowed');
}

function createServer() {
  return http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    handle(req, res).catch((err) => sendError(res, err));
  });
}

/** 启动后预热缓存，让用户打开窗口时尽量已有结果 */
function warmup() {
  setTimeout(() => {
    getPicks(false).catch(() => {});
    apiEvents().catch(() => {});
    getPortfolio(false).catch(() => {});
  }, 400);
  // 模拟盘每天要续写一条记录：应用开着的时候每 10 分钟检查一次，
  // 遇到新的交易日或盘中价格变化就更新，不会重复成交（成交价一旦落定就锁定）。
  setInterval(() => {
    getPortfolio(false).catch(() => {});
  }, 10 * 60 * 1000);
}

function start(port = cfg.PORT) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    // 只监听本机，避免把行情接口暴露到局域网
    server.listen(port, '127.0.0.1', () => {
      warmup();
      resolve(server);
    });
  });
}

if (require.main === module) {
  start()
    .then((server) => {
      const { port } = server.address();
      console.log(`lyy创意选股服务已启动: http://127.0.0.1:${port}`);
      console.log('按 Ctrl+C 退出');
    })
    .catch((err) => {
      console.error('启动失败:', err.message);
      process.exit(1);
    });
}

module.exports = { start, createServer };
