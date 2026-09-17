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
const verdictEngine = require('./engine/verdict');
const holdingEngine = require('./engine/holding');
const insightEngine = require('./engine/insight');
const seasonalEngine = require('./engine/seasonal');
const themesEngine = require('./engine/themes');
const shortTermEngine = require('./engine/shortterm');
const hotStockEngine = require('./engine/hotstock');
const reviewEngine = require('./engine/review');
const portfolio = require('./engine/portfolio');
const mirror = require('./lib/mirror');
const { cached, invalidate } = require('./lib/cache');
const { mapLimit } = require('./lib/http');
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
  const [quote, trends, k, flow, anns, news, fundamentals, listRow] = await Promise.all([
    em.quote(code).catch(() => null),
    em.minuteTrends(code, 1).catch(() => null),
    em.kline(code, { limit: 160 }).catch(() => null),
    em.stockFlow(code, { limit: 10 }).catch(() => []),
    em.announcements(1, 20, code).catch(() => []),
    em.stockNews(code, 8).catch(() => []),
    fundamentalsEngine.fundamentalDetail(code).catch(() => null),
    // 列表型快照里带主力净流入 / 占比，用它给资金面打分
    em
      .quotesBatch([code])
      .then((m) => m.get(String(code).padStart(6, '0')) || null)
      .catch(() => null),
  ]);
  const bars = k && k.bars ? mergeLiveBar(k.bars, quote || {}) : null;
  const ctx = bars ? buildContext(bars, quote && quote.price) : null;
  const flowLast = Array.isArray(flow) && flow.length ? flow[flow.length - 1] : null;
  const verdict = verdictEngine.buildVerdict({
    ctx,
    quote,
    mainNetIn: listRow ? listRow.mainNetIn : flowLast && flowLast.mainNetIn,
    mainNetInPct: listRow ? listRow.mainNetInPct : null,
  });
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
    verdict,
    // 给详情页一个"通用交易计划"（按情绪类风格，用户在详情页可切换视角）
    plan: ctx && quote
      ? buildPlan({ quote, ctx, category: 'sentiment', score: 65, extra: {} })
      : null,
    at: Date.now(),
  };
}

/** 搜股票：代码 / 名称 / 拼音首字母，返回带实时价和主板标记的结果 */
async function apiSearch(keyword) {
  const q = String(keyword || '').trim();
  if (!q) return { q, items: [] };

  const found = await em.searchStocks(q).catch(() => []);
  const items = found.slice(0, 12);
  if (!items.length) return { q, items: [] };

  const quotes = await em.quotesBatch(items.map((x) => x.code)).catch(() => new Map());
  return {
    q,
    items: items.map((x) => {
      const row = quotes.get(x.code) || {};
      return {
        code: x.code,
        name: x.name || row.name || '',
        pinyin: x.pinyin,
        secTypeName: x.secTypeName,
        mainBoard: picker.isMainBoard(x.code),
        price: Number.isFinite(row.price) ? row.price : null,
        changePct: Number.isFinite(row.changePct) ? row.changePct : null,
        turnoverRate: Number.isFinite(row.turnoverRate) ? row.turnoverRate : null,
        amount: Number.isFinite(row.amount) ? row.amount : null,
      };
    }),
  };
}

/**
 * 持仓批量建议：一次把用户所有持仓的"现在该做什么"算出来。
 * 前端每隔一分钟拿它做提醒，所以这里尽量走缓存、批量报价。
 */
async function apiHoldingsAdvice(body = {}) {
  const rawItems = Array.isArray(body.items) ? body.items : [];
  const cash = Number(body.cash) || 0;
  const addRatio = Number(body.addRatio) || 0.3;
  const items = rawItems
    .filter((x) => x && /^\d{6}$/.test(String(x.code)))
    .slice(0, 30)
    .map((x) => ({
      code: String(x.code),
      shares: Math.max(0, Math.round(Number(x.shares) || 0)),
      cost: Number(x.cost) > 0 ? Number(x.cost) : null,
    }));

  if (!items.length) return { at: Date.now(), cash, items: [] };

  const quotes = await em.quotesBatch(items.map((x) => x.code)).catch(() => new Map());

  const out = await mapLimit(items, 3, async (item) => {
    const [quote, k, trends, listRow] = await Promise.all([
      em.quote(item.code).catch(() => null),
      em.kline(item.code, { limit: 160 }).catch(() => null),
      em.minuteTrends(item.code, 1).catch(() => null),
      Promise.resolve(quotes.get(item.code) || null),
    ]);
    const q = quote || listRow || null;
    const bars = k && k.bars ? mergeLiveBar(k.bars, q || {}) : null;
    const ctx = bars ? buildContext(bars, q && q.price) : null;
    const plan = ctx && q ? buildPlan({ quote: q, ctx, category: 'sentiment', score: 65, extra: {} }) : null;
    const verdict = verdictEngine.buildVerdict({
      ctx,
      quote: q,
      mainNetIn: listRow ? listRow.mainNetIn : null,
      mainNetInPct: listRow ? listRow.mainNetInPct : null,
    });
    const advice = holdingEngine.buildAdvice({
      quote: q,
      ctx,
      plan,
      verdict,
      trends,
      shares: item.shares,
      cost: item.cost,
      cash,
      addRatio,
    });
    return {
      code: item.code,
      name: (q && q.name) || (k && k.name) || '',
      shares: item.shares,
      cost: item.cost,
      quote: q,
      tech: ctx,
      plan,
      verdict,
      advice,
    };
  });

  return { at: Date.now(), cash, items: out };
}

/* -------- 短线推荐的权重（会被每日复盘微调，存在本机） -------- */

function stWeightsFile() {
  return path.join(cfg.USER_DIR, 'shortterm-weights.json');
}

function stSnapshotFile() {
  return path.join(cfg.USER_DIR, 'shortterm-snapshot.json');
}

function loadStState() {
  try {
    const j = JSON.parse(fs.readFileSync(stWeightsFile(), 'utf8'));
    if (j && j.weights && Object.keys(j.weights).length) return { history: [], ...j };
  } catch (_) {
    /* 第一次运行没有这个文件 */
  }
  return { weights: { ...shortTermEngine.DEFAULT_WEIGHTS }, updatedAt: null, history: [] };
}

function saveStState(state) {
  try {
    fs.mkdirSync(path.dirname(stWeightsFile()), { recursive: true });
    fs.writeFileSync(stWeightsFile(), JSON.stringify(state, null, 2));
  } catch (_) {
    /* 写不进去也不能影响推荐 */
  }
}

/** 每天留下一份推荐快照，复盘时用来对账 */
function saveStSnapshot(items) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    fs.mkdirSync(path.dirname(stSnapshotFile()), { recursive: true });
    fs.writeFileSync(
      stSnapshotFile(),
      JSON.stringify({
        date: today,
        at: Date.now(),
        top: (items || []).slice(0, 12).map((x) => ({
          code: x.code, name: x.name, score: x.score, verdict: x.verdict, price: x.price,
        })),
      }, null, 2),
    );
  } catch (_) {
    /* 忽略 */
  }
}

function loadStSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(stSnapshotFile(), 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * 每日复盘：用最近十几个交易日的龙虎榜做回测（当时可见信息 → 打分 → 真实 D1/D5），
 * 统计分档表现与因子表现，然后小幅调整权重，下一次推荐就会用新权重。
 */
async function apiShortTermReview() {
  return cached('shortterm_review', 60 * 60 * 1000, async () => {
    const now = new Date();
    const [board, seats] = await Promise.all([
      em.lhbBoard(shortTermEngine.dayBefore(120, now)).catch(() => []),
      em.lhbBuySeats(shortTermEngine.dayBefore(14, now)).catch(() => []),
    ]);

    const state = loadStState();
    const entries = reviewEngine.backtest({ boardRows: board, seatRows: seats, weights: state.weights, days: 12 });
    const summary = reviewEngine.summarize(entries);
    const suggestion = reviewEngine.suggestWeights(state.weights, summary.factors, {});

    let applied = false;
    if (suggestion.changed) {
      saveStState({
        weights: suggestion.weights,
        updatedAt: Date.now(),
        history: [...(state.history || []).slice(-19), {
          at: Date.now(),
          from: state.weights,
          to: suggestion.weights,
          delta: suggestion.delta,
          moved: suggestion.moved,
        }],
      });
      applied = true;
    }

    const snapshot = loadStSnapshot();
    return {
      at: Date.now(),
      period: { days: 12, total: summary.total, evaluated: summary.evaluated },
      buckets: summary.buckets,
      factors: summary.factors,
      weights: {
        current: state.weights,
        next: suggestion.weights,
        delta: suggestion.delta || {},
        moved: suggestion.moved || [],
        changed: applied,
        reason: suggestion.reason,
        updatedAt: state.updatedAt,
      },
      snapshot: snapshot ? { date: snapshot.date, top: (snapshot.top || []).slice(0, 6) } : null,
      notes: [
        '复盘口径：用「当时能看到的信息」（该日之前的龙虎榜历史 + 当日席位）按当前权重给每个上榜个股打分，再用东方财富记录的 D1 / D5 真实收益检验。',
        '分档表告诉你"高分档是不是真的比低分档好"；因子表告诉你"这次是哪条逻辑起了作用、哪条失灵了"。',
        '权重调整是小步（最多 ±25% 再归一化）并且限制在 10%~45% 之间，样本少于 40 条就不调——单日样本太小，避免被偶然结果带偏。',
        '这是启发式的自我校准，不是机器学习，也不保证越调越准；它只能让"你相信的逻辑"和"实际赚钱的逻辑"慢慢靠近。',
      ],
    };
  }, { allowStale: true });
}

/**
 * 短线推荐：以龙虎榜为核心，做席位追踪 + 个股历史胜率。
 *
 * 数据来源是东方财富数据中心：
 *   - 近一周的龙虎榜详情（候选）与买卖席位（追踪游资）
 *   - 近 4 个月的历史龙虎榜（算每只票上榜后 5 日的胜率）
 * 第一轮先用龙虎榜数据打分，第二轮只给前 12 只补日线技术位置。
 */
async function apiShortTerm() {
  return cached('shortterm', 30 * 60 * 1000, async () => {
    const now = new Date();
    const stState = loadStState();
    const recentFrom = shortTermEngine.dayBefore(7, now);
    const historyFrom = shortTermEngine.dayBefore(120, now);

    const [recent, seats, sells, history] = await Promise.all([
      em.lhbBoard(recentFrom).catch(() => []),
      em.lhbBuySeats(recentFrom).catch(() => []),
      em.lhbSellSeats(recentFrom).catch(() => []),
      em.lhbBoard(historyFrom).catch(() => []),
    ]);

    const built = shortTermEngine.buildCandidates({
      boardRows: recent,
      seatRows: seats,
      sellRows: sells,
      // 历史拉不到就退化成"只用近一周"，胜率会标样本不足
      historyRows: history.length ? history : recent,
      maxCandidates: 12,
      weights: stState.weights,
    });

    const items = await mapLimit(built.list, 4, async (c) => {
      const k = await em.kline(c.code, { limit: 120 }).catch(() => null);
      const bars = k && k.bars ? mergeLiveBar(k.bars, { price: c.price }) : null;
      const tech = bars ? buildContext(bars, c.price) : null;
      const final = shortTermEngine.scoreFinal(c.base, { tech });
      return {
        code: c.code,
        name: c.name,
        date: c.date,
        price: c.price,
        changePct: c.changePct,
        turnoverRate: c.turnoverRate,
        floatCap: c.floatCap,
        dealRatio: c.dealRatio,
        netBuy: c.netBuy,
        explain: c.explain,
        explanation: c.explanation,
        winRate: c.winRate,
        seat: {
          count: c.seat.count,
          instCount: c.seat.instCount,
          activeCount: c.seat.activeCount,
          activeNames: c.seat.activeNames,
          topProb: c.seat.topProb,
          topNames: c.seat.topNames,
        },
        tech: tech
          ? {
              ma5: tech.ma5,
              ma10: tech.ma10,
              ma20: tech.ma20,
              position: tech.position,
              atrPct: tech.atrPct,
              chg5Pct: tech.chg5Pct,
              bullStack: tech.bullStack,
            }
          : null,
        score: final.score,
        verdict: final.verdict,
        reasons: final.reasons,
        risks: final.risks,
      };
    });
    // 第二轮的最终分才是排序依据
    items.sort((a, b) => b.score - a.score);
    saveStSnapshot(items);

    return {
      at: Date.now(),
      from: recentFrom,
      counts: {
        board: recent.length,
        seats: seats.length,
        history: history.length,
        candidates: built.total,
      },
      items,
      weights: stState.weights,
      hotSeats: shortTermEngine.hotSeats(seats, { days: 5, limit: 10, base: now }),
      notes: [
        `候选来自最近一周登过龙虎榜的主板个股（剔除 ST），共 ${built.total} 只，按龙虎榜数据先排一轮，再给前 12 只补日线技术位置。`,
        '胜率 = 这只票过去每次上榜后 5 个交易日的涨跌统计（数据来自东方财富的 D5 收益字段），样本不足 4 次的会标注"样本有限"。',
        '席位追踪 = 买入席位里近 3 个月上榜次数≥30 的算活跃游资；「近 3 日上涨概率」是东方财富按该席位历史战绩给出的。',
        '短线是概率游戏：这里给的是历史统计和资金痕迹，不是明天会涨的保证，务必自己控制仓位和止损。',
      ],
    };
  }, { allowStale: true });
}

/**
 * 热门票：全市场快照里「现在最热」的主板个股。
 *
 * 和短线推荐（龙虎榜）互补——那个回答"谁被资金选中了"，这个回答"眼球和钱现在在哪"。
 * 热度只看五个东西：成交额（全市场分位）、换手率、量比、当日强度、主力资金。
 * 前 12 只再补一次日线，用来看 5 日涨幅和连板高度，只加风险提示，不参与排序。
 */
// 「昨日连板」「机构重仓」这类派生板块不是题材，不往强势概念里放
const BOARD_NOISE =
  /昨日|连板|涨停|打板|触板|一字|次新|ST|退市|重仓|持仓|标普|罗素|MSCI|富时|转债|B股|AH股|百元股|低价股|高价股|破净|送转|壳资源|融资融券|股通/;

async function apiHotStocks() {
  return cached('hotstocks', 5 * 60 * 1000, async () => {
    const now = new Date();
    const [snap, boards, lhb] = await Promise.all([
      em.marketSnapshot(),
      em.boardRank('concept', 'change', 40).catch(() => []),
      em.lhbBoard(shortTermEngine.dayBefore(3, now)).catch(() => []),
    ]);

    const lhbCodes = new Set((lhb || []).map((r) => String(r.SECURITY_CODE || '')));
    const boardLeaders = new Map();
    // 东方财富的「昨日连板 / 昨日涨停 / 机构重仓」这类是派生板块，不是题材，先剔掉
    const themeBoards = (boards || []).filter((b) => !BOARD_NOISE.test(String(b.name || '')));
    for (const b of themeBoards) {
      if (b.leaderCode) boardLeaders.set(String(b.leaderCode), b.name);
    }

    const built = hotStockEngine.buildHotList(snap.rows, { limit: 12, lhbCodes, boardLeaders });

    const items = await mapLimit(built.list, 4, async (c) => {
      const k = await em.kline(c.code, { limit: 40 }).catch(() => null);
      // 必须把当日涨跌幅一起带上：少了它，合成出来的今天这根 K 线没有 changePct，
      // 连板天数就永远数成 0
      const bars = k && k.bars ? mergeLiveBar(k.bars, { price: c.price, changePct: c.changePct }) : null;
      const tech = bars ? buildContext(bars, c.price) : null;
      return hotStockEngine.finalize(c, { tech, streak: hotStockEngine.limitUpStreak(bars) });
    });
    items.sort((a, b) => b.score - a.score);

    return {
      at: Date.now(),
      counts: {
        universe: snap.rows.length,
        candidates: built.total,
        partial: !!snap.partial,
      },
      items,
      boards: themeBoards.slice(0, 6).map((b) => ({
        code: b.code,
        name: b.name,
        changePct: b.changePct,
        mainNetIn: b.mainNetIn,
        leaderName: b.leaderName,
        leaderCode: b.leaderCode,
        leaderChangePct: b.leaderChangePct,
      })),
      notes: [
        '热门票的口径是「眼球和资金现在集中在哪」：成交额按全市场分位给分（前 1% 才拿高分），换手率以 12% 为中心两头递减，再叠加量比、当日强度和主力净流入占比。',
        '成交额大、换手高、涨停、主力净流入，都是「热」的证据，但热不等于能买——涨停当天根本买不进，换手过高往往是高位分歧。',
        '所以看这个榜的正确姿势是：先用它找到今天钱在哪，再回到上面的龙虎榜推荐看谁在买、历史胜率如何。',
      ],
    };
  }, { allowStale: true });
}

/** 历史规律（详情页的"我的看法"）：用长周期日线做季节性统计 */
async function apiInsight(code) {
  return cached(`insight_${code}`, 12 * 60 * 60 * 1000, async () => {
    const [k, quote] = await Promise.all([
      em.kline(code, { klt: 101, limit: 1800 }).catch(() => null),
      em.quote(code).catch(() => null),
    ]);
    const result = insightEngine.analyze(k && k.bars, {
      name: (k && k.name) || (quote && quote.name) || '',
      price: quote && quote.price,
    });
    return { code, klineSource: (k && k.source) || null, bars: k && k.bars ? k.bars.length : 0, ...result };
  }, { allowStale: true });
}

/**
 * 月度推荐 + 生肖股。
 *
 * 候选池 = 今日推荐里的票 + 成交额靠前的主板活跃股 + 上市三年内的次新 + 名字带生肖字的票，
 * 对它们取近 10 年月线，算"这个自然月历史上平均涨多少、几年上涨"，
 * 再和"当前分"加权排序，取前 100 只（前端每页 20 只分页看）。结果缓存 12 小时。
 */
/** 上市日期形如 20150312；返回上市至今的年数（拿不到日期返回 null） */
function listingAgeYears(listDate, now) {
  const s = String(listDate || '');
  if (s.length < 8) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  if (!y || !m || !d) return null;
  const listed = new Date(y, m - 1, d).getTime();
  if (!Number.isFinite(listed) || listed > now.getTime()) return null;
  return (now.getTime() - listed) / (365.25 * 24 * 3600 * 1000);
}

/** 距离下一个自然月 1 号 0 点还有多少毫秒（季节统计的缓存寿命） */
function msUntilNextMonth(now = new Date()) {
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
  return Math.max(0, next.getTime() - now.getTime());
}

// 月线拉失败过的代码（本进程内冷却，避免每 5 分钟重建榜单时反复重试）
const seasonFailUntil = new Map();
const SEASON_FAIL_COOLDOWN = 30 * 60 * 1000;

/**
 * 单只票 12 个自然月的历史季节性，按 (代码, 年月) 落盘缓存。
 * "历史上 9 月平均涨多少"这个月内不会变，所以一个月只拉一次月线；
 * 候选股和题材成分股共用这份缓存，重叠的票不会重复拉。
 *
 * 注意：网络失败**不写缓存**——否则一次抖动会把这只票踢出整个月；
 * 真的没有月线（次新、长期停牌）才缓存 null。
 */
function monthlySeasonStats(code, monthKey, ttl) {
  return cached(
    // 键里带 2：统计口径从"只看月末收盘"扩到"含月内最高（脉冲识别）"，旧缓存作废
    `mseason2_${code}_${monthKey}`,
    ttl,
    async () => {
      if ((seasonFailUntil.get(code) || 0) > Date.now()) throw new Error('这只票的月线暂时拉不到，先跳过');
      const k = await em.monthlyKline(code, 120).catch((err) => {
        seasonFailUntil.set(code, Date.now() + SEASON_FAIL_COOLDOWN);
        throw err;
      });
      if (!k || !k.bars || !k.bars.length) return null;
      seasonFailUntil.delete(code);
      const byMonth = {};
      for (let m = 1; m <= 12; m += 1) {
        const s = seasonalEngine.monthStatsWithPeak(k.bars, m);
        if (s && s.total) byMonth[m] = s;
      }
      return Object.keys(byMonth).length ? byMonth : null;
    },
    { disk: true },
  );
}

/**
 * 单只票的"月内峰值时点"（12 个月各一份），按 (代码, 年月) 落盘缓存。
 *
 * 月线看不出冲高在哪几天，得用日线。日线本身只放内存（disk:false）——
 * 两百多只票的日线落盘每月要多占几十兆，而真正要留的只是算出来的那点时点信息。
 */
function stockTiming(code, monthKey, ttl, now) {
  return cached(
    `stock_timing_${code}_${monthKey}`,
    ttl,
    async () => {
      const k = await em
        .kline(code, { limit: cfg.SELECT.stockTimingLimit }, { disk: false })
        .catch(() => null);
      if (!k || !k.bars || !k.bars.length) return null;
      const byMonth = {};
      for (let m = 1; m <= 12; m += 1) byMonth[m] = themesEngine.peakTiming([k.bars], m, { now });
      return Object.values(byMonth).some(Boolean) ? byMonth : null;
    },
    { disk: true },
  );
}

async function apiMonthly() {
  // 榜单本身只缓存 5 分钟：价格、涨跌幅、主力资金这些"日常数据"每次都用最新快照重算。
  // 真正重的月线统计在下面按自然月缓存，一个月只算一次。
  return cached('monthly_rank', 5 * 60 * 1000, async () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const nextMonth = month === 12 ? 1 : month + 1;
    const monthKey = `${year}-${String(month).padStart(2, '0')}`;
    // 季节统计活到下个月初：跨月以后 key 变了，自然重算
    const seasonTtl = msUntilNextMonth(now) + 24 * 3600 * 1000;

    const [picks, snapshot] = await Promise.all([
      getPicks(false).catch(() => null),
      em.marketSnapshot().catch(() => null),
    ]);

    const rows = (snapshot && snapshot.rows) || [];
    const pool = new Map();
    const add = (x) => {
      if (x && /^\d{6}$/.test(String(x.code)) && !pool.has(x.code)) pool.set(x.code, x);
    };

    if (picks) {
      for (const key of ['sentiment', 'news', 'event', 'fundamental']) {
        for (const it of (picks[key] && picks[key].items) || []) add(it);
      }
      for (const it of picks.top || []) add(it);
    }
    // 月度榜要排到 100 只，候选池就得够大：按成交额取前面这批最活跃的主板股补进来
    [...rows]
      .sort((a, b) => (b.amount || 0) - (a.amount || 0))
      .slice(0, cfg.SELECT.monthlyPool)
      .forEach(add);
    // 上市 2~4 年的次新再单独给一批名额：它们月线样本只有两三年，"近两年"这一档正是从它们身上来的。
    // 光按成交额排，池子里全是十年老股，样本门槛降到 2 年也看不出效果；
    // 上市不足 2 年的不拉——样本必然凑不够 2 年，白等一次请求。
    [...rows]
      .filter((r) => {
        const age = listingAgeYears(r.listDate, now);
        return age !== null && age >= 2 && age <= 4;
      })
      .sort((a, b) => (b.amount || 0) - (a.amount || 0))
      .slice(0, cfg.SELECT.monthlyYoung)
      .forEach(add);

    /* ---- 重活：月线 -> 12 个月的历史季节性，按 (代码, 年月) 缓存到磁盘 ----
       "历史上 9 月平均涨多少"这个月内不会变，所以一个月只拉一次月线；
       日常刷新只重算下面的价格 / 涨跌 / 当前分。 */
    const withStats = await mapLimit([...pool.values()], 6, async (c) => ({
      ...c,
      seasonByMonth: await monthlySeasonStats(c.code, monthKey, seasonTtl).catch(() => null),
    }));

    /* 个股的月内峰值时点：同样按月缓存，日线只走内存。
       只给"至少有一个月是脉冲型"的票算——其它票的时点界面上根本不显示，
       两百多只票全拉一遍日线要多花一两分钟，不值当。 */
    const timingPool = withStats.filter(
      (x) => x.seasonByMonth && Object.values(x.seasonByMonth).some((s) => s && s.pulse),
    );
    const timed = await mapLimit(timingPool, 6, async (c) => ({
      code: c.code,
      timingByMonth: await stockTiming(c.code, monthKey, seasonTtl, now).catch(() => null),
    }));
    const timingByCode = new Map(
      timed.filter((x) => x.timingByMonth).map((x) => [x.code, x.timingByMonth]),
    );
    const usable = withStats
      .filter((x) => x.seasonByMonth)
      .map((c) => ({ ...c, timingByMonth: timingByCode.get(c.code) || null }));

    /* ---- 季节性题材：冰雪经济 / 天然气 / 白酒… 同样是按月缓存 ----
       题材本身也是用"成分股的月线"算出来的：把成分股各自的季节统计平均一下，
       够强的月份才算这个题材的旺季，窗口不写死。 */
    // 题材汇总只缓存 1 小时：成分股的季节统计是按月缓存的，汇总重算很便宜，
    // 但这样"这次没拉到的成分股"过一会儿能补上，而不是整月缺一块
    const themeData = await cached(
      `monthly_themes2_${monthKey}`,
      60 * 60 * 1000,
      async () => {
        const out = [];
        for (const t of themesEngine.SEASONAL_THEMES) {
          const members = (await em.boardMembers(t.code, { size: 100 }).catch(() => []))
            .filter((m) => shortTermEngine.isMainBoard(m.code))
            .slice(0, cfg.SELECT.themeMembers);
          const stats = await mapLimit(members, 6, (m) =>
            monthlySeasonStats(m.code, monthKey, seasonTtl).catch(() => null));
          const season = themesEngine.themeSeason(stats);
          // 月内峰值时点：月线看不出"冲高在哪几天"，得用日线算。
          // 单独按月缓存，免得题材汇总每小时重算时反复拉日线。
          const timing = await cached(
            `theme_timing_${t.code}_${monthKey}`,
            seasonTtl,
            async () => {
          const bars = await mapLimit(
                members.slice(0, cfg.SELECT.themeTimingMembers),
                4,
                (m) => em.kline(m.code, { limit: cfg.SELECT.themeTimingLimit }, { disk: false })
                  .then((k) => (k && k.bars) || null)
                  .catch(() => null),
              );
              const byMonth = {};
              for (let m = 1; m <= 12; m += 1) byMonth[m] = themesEngine.peakTiming(bars, m, { now });
              return byMonth;
            },
            { disk: true },
          );
          out.push({
            code: t.code,
            name: t.name,
            hint: t.hint,
            months: season.months,
            active: season.active,
            pulse: season.pulse,
            timing,
            members: members.map((m) => ({ code: m.code, name: m.name })),
          });
        }
        return out;
      },
      { disk: true },
    );

    // 每个月有哪些题材在旺季（价格用最新快照补，所以不会跟着冻一个月）
    const snapByCode = new Map(rows.map((r) => [r.code, r]));
    const themeBoard = {};
    for (let m = 1; m <= 12; m += 1) themeBoard[m] = [];
    const themeOfStock = new Map();
    for (const t of themeData) {
      // 旺季月份 + 脉冲月份都列出来：脉冲型不给加分，但必须让用户看见
      for (const m of [...new Set([...t.active, ...t.pulse])]) {
        themeBoard[m].push({
          code: t.code,
          name: t.name,
          hint: t.hint,
          stats: t.months[m],
          pulse: !!t.months[m].pulse,
          timing: (t.timing && t.timing[m]) || null,
          // 脉冲型（冲几天就还回去）不给加分，只在界面上标注出来
          bonus: t.months[m].pulse ? 0 : themesEngine.THEME_BONUS,
          memberCount: t.members.length,
          stocks: t.members.slice(0, 6).map((mem) => {
            const q = snapByCode.get(mem.code) || {};
            return {
              code: mem.code,
              name: mem.name,
              price: q.price,
              changePct: q.changePct,
              change60Pct: q.change60Pct,
            };
          }),
        });
      }
      for (const mem of t.members) {
        if (!themeOfStock.has(mem.code)) themeOfStock.set(mem.code, {});
        const byMonth = themeOfStock.get(mem.code);
        for (const m of t.active) {
          if (t.months[m].pulse) continue; // 脉冲型不算"顺风"，不给加分
          if (!byMonth[m]) byMonth[m] = [];
          byMonth[m].push(t.name);
        }
      }
    }
    for (let m = 1; m <= 12; m += 1) {
      // 趋势型排前面，脉冲型垫后
      themeBoard[m].sort((a, b) => (a.pulse ? 1 : 0) - (b.pulse ? 1 : 0)
        || (b.stats.avgPct || 0) - (a.stats.avgPct || 0));
    }

    // 把"踩在旺季题材上"的月份挂到候选股上，排序时会加分
    const rankedPool = usable.map((c) => ({
      ...c,
      themeNamesByMonth: themeOfStock.get(c.code) || null,
    }));

    const thisAnimal = seasonalEngine.zodiacOf(year);
    const nextAnimal = seasonalEngine.zodiacOf(year + 1);

    // 市场炒作的是"明年的生肖"，所以主线放在 nextAnimal 上：
    // 正主字全部收进来，另外补一批谐音字（小市值优先，方便埋伏）
    // 生肖是情绪票，但 ST 还是要排除（退市风险不是情绪问题）
    const investable = rows.filter((r) => !/ST|退/.test(String(r.name || '')));
    const mainRows = seasonalEngine.matchZodiac(investable, [nextAnimal]);
    const homophoneChars = seasonalEngine.zodiacChars(nextAnimal).filter((c) => c !== nextAnimal);
    const homoRows = seasonalEngine
      .matchZodiac(investable, homophoneChars)
      .filter((r) => !mainRows.some((m) => m.code === r.code))
      .sort((a, b) => (a.floatCap || Infinity) - (b.floatCap || Infinity))
      .slice(0, 8);
    // 今年生肖的尾部行情（窗口到次年春节前），列几只当参考
    const currentRows = seasonalEngine
      .matchZodiac(investable, [thisAnimal])
      .filter((r) => !mainRows.some((m) => m.code === r.code)
        && !homoRows.some((m) => m.code === r.code))
      .sort((a, b) => (b.amount || 0) - (a.amount || 0))
      .slice(0, 5);

    /* ---- 重活：往年生肖股的月线 -> 炒作窗口 + 龙头画像，同样按月缓存 ----
       这块只影响"生肖备注"，但同样要拉几十只票的月线，没必要天天算。 */
    const zodiacHist = await cached(
      `zodiac_hist_${monthKey}`,
      seasonTtl,
      async () => {
        // 往年生肖（近 3 年）：统计"炒在哪几个月"和"龙头长什么样"
        const pastSets = [1, 2, 3].map((i) => {
          const y = year - i;
          const animal = seasonalEngine.zodiacOf(y);
          return {
            year: y,
            animal,
            rows: seasonalEngine
              .matchZodiac(investable, [animal])
              .sort((a, b) => (b.amount || 0) - (a.amount || 0))
              .slice(0, 5),
          };
        });
        const tasks = pastSets.flatMap((p) =>
          p.rows.map((r) => ({ ...r, year: p.year, animal: p.animal })));
        const fetched = await mapLimit(tasks, 4, async (c) => {
          const k = await em.monthlyKline(c.code, 120).catch(() => null);
          return { ...c, bars: k && k.bars ? k.bars : null };
        });
        const samples = fetched.filter((x) => x.bars && x.bars.length);
        return {
          window: seasonalEngine.hypeWindow(samples),
          profile: seasonalEngine.leaderProfile(samples),
          pastYears: pastSets.map((p) => ({ year: p.year, animal: p.animal, sample: p.rows.length })),
        };
      },
      { disk: true },
    );
    const hypeWindow = zodiacHist.window;
    const leaderProfile = zodiacHist.profile;
    // 生肖候选直接用行情快照打分：快照自带 60 日涨跌幅和流通市值，
    // 足够判断"低价 / 小市值 / 还没启动 / 盘面安静"，不用再为它们拉月线。
    const ambush = [
      ...mainRows.slice(0, 8).map((r) => ({ ...r, zType: 'main', animal: nextAnimal })),
      ...homoRows.map((r) => ({ ...r, zType: 'homophone', animal: nextAnimal })),
      ...currentRows.map((r) => ({ ...r, zType: 'current', animal: thisAnimal })),
    ]
      .map((x) => {
        const scored = seasonalEngine.ambushScore(x, leaderProfile, { type: x.zType });
        return {
          code: x.code,
          name: x.name,
          zodiacChar: x.zodiacChar,
          type: x.zType,
          animal: x.animal,
          price: x.price,
          changePct: x.changePct,
          amount: x.amount,
          floatCap: x.floatCap,
          turnoverRate: x.turnoverRate,
          change60Pct: x.change60Pct,
          score: scored.score,
          reasons: scored.reasons,
          risks: scored.risks,
        };
      })
      .sort((a, b) => b.score - a.score);

    const monthName = seasonalEngine.MONTH_CN[month - 1];
    const nextName = seasonalEngine.MONTH_CN[nextMonth - 1];

    // 12 个月的排名一次算完，前端切月是秒切，不用再请求一次
    const months = {};
    for (let m = 1; m <= 12; m += 1) {
      months[m] = seasonalEngine.rankForMonth(rankedPool, m, {
        limit: 100,
        minYears: 2,
        themeBonus: themesEngine.THEME_BONUS,
      });
    }

    return {
      at: Date.now(),
      year,
      month,
      nextMonth,
      monthName,
      nextMonthName: nextName,
      candidates: withStats.length,
      barsAvailable: usable.length,
      months,
      themes: themeBoard,
      themeRule: themesEngine.ACTIVE_RULE,
      themeBonus: themesEngine.THEME_BONUS,
      thisMonth: months[month],
      next: months[nextMonth],
      zodiac: {
        year,
        yearNext: year + 1,
        thisAnimal,
        nextAnimal,
        mainCount: mainRows.length,
        homophoneChars,
        pastYears: zodiacHist.pastYears,
        window: hypeWindow,
        profile: leaderProfile,
        ambush,
      },
      notes: [
        `做法：候选股取近 10 年月线，统计它们在 ${monthName} 的历史平均涨跌和上涨年份占比，再和「当前分」加权排序（季节性 65% + 当前 35%），取前 100 只分页展示。`,
        '月线统计按月缓存：同一只票、同一个自然月的季节规律，一个月只拉一次月线；榜单每 5 分钟用最新行情重算一次，所以列表里的现价、涨跌幅、主力资金是新的，只有"历史规律"那部分要等下个月才更新。',
        `候选池 = 选股结果 + 成交额最大的 ${cfg.SELECT.monthlyPool} 只主板股 + 成交额靠前的 ${cfg.SELECT.monthlyYoung} 只「上市 2~4 年」次新（比如 2024 年上市的，月线就只有近两年）。`,
        '样本不足 2 年的票不参与排名（上市太短）；每行都标了样本年数，2 年的规律本来就比 10 年的更容易是巧合，看到综合分高但样本只有两三年的，自己留个心眼。',
        '「当前分」统一用行情快照重算（相对强度 + 主力资金 + 量能），没有用日线技术分——榜上有上百只票，必须用同一把尺子量。',
        '季节性题材（冰雪经济、天然气、白酒、啤酒、影视院线…）是额外的一层：题材名单是人工挑的，但"哪几个月是旺季"是拿成分股的月线算出来的——' +
          `成分股在这个月的历史平均涨幅 ≥ ${themesEngine.ACTIVE_RULE.minAvgPct}%、上涨占比 ≥ ${themesEngine.ACTIVE_RULE.minWinRate}% 才算旺季。` +
          `踩在旺季题材上的票，综合分额外加 ${themesEngine.THEME_BONUS} 分并在标签里标出来。`,
        `生肖只是月份里的备注，而且注意：市场炒的是"明年的生肖"（现在这个时间是 ${year + 1} 年 ${nextAnimal} 年）。
         我先用近三年生肖股的月度表现统计出炒作窗口，再从往年龙头反推"适合埋伏的票"长什么样——
         纯情绪票，不看业绩，只看低价、小市值、还没启动、盘面安静这几条。`,
        '全部是历史统计，不构成投资建议；真要买，仍按交易计划的买入区间和止损执行。',
      ],
    };
  }, { allowStale: true });
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
      if (p === '/api/search') {
        return sendJSON(res, { ok: true, data: await apiSearch(url.searchParams.get('q')) });
      }
      if (p === '/api/holdings/advice') {
        const body = req.method === 'POST' ? await readBody(req) : {};
        return sendJSON(res, { ok: true, data: await apiHoldingsAdvice(body) });
      }
      const insightMatch = p.match(/^\/api\/insight\/(\d{6})$/);
      if (insightMatch) {
        return sendJSON(res, { ok: true, data: await apiInsight(insightMatch[1]) });
      }
      if (p === '/api/monthly') {
        return sendJSON(res, { ok: true, data: await apiMonthly() });
      }
      if (p === '/api/shortterm') {
        return sendJSON(res, { ok: true, data: await apiShortTerm() });
      }
      if (p === '/api/shortterm/review') {
        return sendJSON(res, { ok: true, data: await apiShortTermReview() });
      }
      if (p === '/api/hotstocks') {
        return sendJSON(res, { ok: true, data: await apiHotStocks() });
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
  // 月度推荐要拉几十只票的月线，比较慢，等首页稳定后再预热，用户点进去通常已经是热的
  setTimeout(() => {
    apiMonthly().catch(() => {});
  }, 90 * 1000);
  // 短线推荐要拉龙虎榜 + 席位，也放到后台预热
  setTimeout(() => {
    apiShortTerm().catch(() => {});
  }, 150 * 1000);
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
