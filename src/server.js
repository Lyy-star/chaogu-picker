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
const shortTermEngine = require('./engine/shortterm');
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
 * 候选池 = 今日推荐里的票 + 成交额靠前的主板活跃股 + 名字带生肖字的票，
 * 对它们取近 10 年月线，算"这个自然月历史上平均涨多少、几年上涨"，
 * 再和当前选股评分加权排序。结果缓存 6 小时。
 */
async function apiMonthly() {
  return cached('monthly_rank', 12 * 60 * 60 * 1000, async () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const nextMonth = month === 12 ? 1 : month + 1;

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
    [...rows].sort((a, b) => (b.amount || 0) - (a.amount || 0)).slice(0, 24).forEach(add);

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

    // 往年生肖（近 3 年）：拿来统计"炒在哪几个月"和"龙头长什么样"
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

    const fetchMonthly = async (c) => {
      const k = await em.monthlyKline(c.code, 120).catch(() => null);
      return { ...c, bars: k && k.bars ? k.bars : null };
    };

    const histTasks = pastSets.flatMap((p) =>
      p.rows.map((r) => ({ ...r, year: p.year, animal: p.animal, kind: 'history' })));
    const poolTasks = [...pool.values()].slice(0, 20).map((c) => ({ ...c, kind: 'pool' }));

    const fetched = await mapLimit([...histTasks, ...poolTasks], 4, fetchMonthly);
    const histSamples = fetched.filter((x) => x.kind === 'history');
    const usable = fetched.filter((x) => x.bars && x.bars.length);

    const hypeWindow = seasonalEngine.hypeWindow(histSamples);
    const leaderProfile = seasonalEngine.leaderProfile(histSamples);
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

    // 12 个月的排名一次算完（候选只有二三十只，计算本身很便宜），
    // 这样前端切换月份是秒切，不用再请求一次
    const months = {};
    for (let m = 1; m <= 12; m += 1) {
      months[m] = seasonalEngine.rankForMonth(usable, m, { limit: 12 });
    }

    return {
      at: Date.now(),
      year,
      month,
      nextMonth,
      monthName,
      nextMonthName: nextName,
      candidates: poolTasks.length,
      barsAvailable: usable.length,
      months,
      thisMonth: months[month],
      next: months[nextMonth],
      zodiac: {
        year,
        yearNext: year + 1,
        thisAnimal,
        nextAnimal,
        mainCount: mainRows.length,
        homophoneChars,
        pastYears: pastSets.map((p) => ({ year: p.year, animal: p.animal, sample: p.rows.length })),
        window: hypeWindow,
        profile: leaderProfile,
        ambush,
      },
      notes: [
        `做法：候选股取近 10 年月线，统计它们在 ${monthName} 的历史平均涨跌和上涨年份占比，再和当前选股评分加权排序（季节性 65% + 当前评分 35%）。`,
        '样本不足 3 年的票不会列出来——样本太短的“规律”基本都是巧合。',
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
