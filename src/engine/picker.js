'use strict';

/**
 * 选股引擎：情绪类 / 消息类 / 大事件类。
 *
 * 三条主线共用一套"打分 -> 排序 -> 生成交易计划"的流程：
 *   1. 先按上游信号筛出候选（板块热度 / 资金流 / 公告 / 事件）
 *   2. 过滤：只留主板、剔除 ST、剔除买不进的涨停、剔除流动性不足
 *   3. 用实时行情 + 日线指标 + 资金流补全，逐项打分并给出中文理由
 *   4. 按"胜率 x 盈亏比"的期望值排序，并生成动态买卖计划
 */

const cfg = require('../config');
const em = require('../data/eastmoney');
const { buildContext, mergeLiveBar, round } = require('./indicators');
const { buildPlan } = require('./strategy');
const kw = require('./keywords');
const eventsEngine = require('./events');
const fundamentalsEngine = require('./fundamentals');
const { mapLimit } = require('../lib/http');

/* ------------------------------------------------------------------ */
/* 基础过滤                                                            */
/* ------------------------------------------------------------------ */

function isMainBoard(code) {
  const c = String(code);
  if (cfg.BOARD.excludePattern.test(c)) return false;
  return cfg.BOARD.mainBoardPattern.test(c);
}

function isST(name) {
  return /ST|退/.test(String(name || ''));
}

function passesBaseFilter(row) {
  if (!row || !row.code) return false;
  if (!isMainBoard(row.code)) return false;
  if (cfg.SELECT.excludeST && isST(row.name)) return false;
  if (!Number.isFinite(row.price) || row.price <= 0) return false;
  if (cfg.SELECT.excludeLimitUp && Number.isFinite(row.changePct) && row.changePct >= 9.7) return false;
  if (Number.isFinite(row.amount) && row.amount < cfg.SELECT.minTurnover * 10000) return false;
  if (Number.isFinite(row.price) && row.price < 2) return false;
  return true;
}

/** 归一化到 0-100 */
function norm(value, min, max) {
  if (!Number.isFinite(value)) return 50;
  if (max === min) return 50;
  return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
}

function fmtYi(v) {
  if (!Number.isFinite(v)) return '-';
  return `${(v / 1e8).toFixed(2)}亿`;
}

/**
 * 最终排序分：综合评分（基本面/消息/资金/技术）为主，
 * 叠加"期望收益"（胜率 x 赔率）作为赔率修正，避免只选高分但没空间的票。
 */
function rankScore(score, expectedPct) {
  const expPart = Math.max(0, Math.min(100, ((expectedPct ?? 0) + 5) / 17 * 100));
  return round(0.65 * (score || 0) + 0.35 * expPart, 2);
}

function sortByRank(a, b) {
  return rankScore(b.score, b.plan?.expectedPct) - rankScore(a.score, a.plan?.expectedPct);
}

/* ------------------------------------------------------------------ */
/* 候选补全：日线指标 + 交易计划                                        */
/* ------------------------------------------------------------------ */

function prune(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

async function enrichCandidates(candidates, { category, sentiment, extraByCode = {}, barsLimit = 150 } = {}) {
  const codes = candidates.map((c) => c.code);
  const liveQuotes = await em.quotesBatch(codes).catch(() => new Map());

  const enriched = await mapLimit(candidates.slice(0, 40), 6, async (cand) => {
    const baseQuote = liveQuotes.get(cand.code) || {};
    const quote = { ...cand, ...prune(baseQuote) };
    const k = await em.kline(cand.code, { limit: barsLimit }).catch(() => null);
    if (!k || !k.bars || k.bars.length < 20) return null;
    const bars = mergeLiveBar(k.bars, quote);
    const ctx = buildContext(bars, quote.price);
    if (!ctx) return null;
    const plan = buildPlan({
      quote,
      ctx,
      category,
      score: cand.score,
      extra: { sentimentLevel: sentiment && sentiment.level, ...(extraByCode[cand.code] || {}) },
    });
    return { ...cand, quote, ctx, plan, dailyBars: bars, dataSource: k.source || '东方财富' };
  });

  return enriched.filter(Boolean);
}

/** 技术面得分（0-100），三类共用 */
function technicalScore(ctx) {
  let s = 50;
  if (ctx.bullStack) s += 12;
  if (Number.isFinite(ctx.priceVsMa5Pct)) {
    if (ctx.priceVsMa5Pct > 12) s -= 18;
    else if (ctx.priceVsMa5Pct > 6) s -= 8;
    else if (ctx.priceVsMa5Pct > 0) s += 10;
    else if (ctx.priceVsMa5Pct > -3) s += 2;
    else s -= 8;
  }
  if (Number.isFinite(ctx.position)) {
    if (ctx.position > 0.95) s -= 6;
    else if (ctx.position > 0.7) s += 6;
    else if (ctx.position < 0.25) s -= 4;
  }
  if (Number.isFinite(ctx.volRatio5)) {
    if (ctx.volRatio5 > 3) s -= 6;
    else if (ctx.volRatio5 > 1.2) s += 10;
    else if (ctx.volRatio5 < 0.6) s -= 8;
  }
  if (Number.isFinite(ctx.atrPct)) {
    if (ctx.atrPct > 7) s -= 10;
    else if (ctx.atrPct > 4) s -= 3;
    else if (ctx.atrPct < 2.5) s += 6;
  }
  return Math.max(0, Math.min(100, s));
}

function fundScore(row) {
  let s = 50;
  const pct = Number(row.mainNetInPct);
  if (Number.isFinite(pct)) {
    if (pct > 12) s += 28;
    else if (pct > 6) s += 20;
    else if (pct > 2) s += 12;
    else if (pct > 0) s += 5;
    else if (pct > -5) s -= 8;
    else s -= 18;
  }
  const net = Number(row.mainNetIn);
  if (Number.isFinite(net)) {
    if (net > 2e8) s += 12;
    else if (net > 5e7) s += 8;
    else if (net < -1e8) s -= 15;
    else if (net < 0) s -= 6;
  }
  return Math.max(0, Math.min(100, s));
}

/* ------------------------------------------------------------------ */
/* 一、情绪类：热点板块 + 资金热点                                       */
/* ------------------------------------------------------------------ */

async function pickSentiment({ perCategory = cfg.SELECT.perCategory, force = false } = {}) {
  const [boardsHot, boardsFlow, flowRank, snapshot, sentiment] = await Promise.all([
    em.boardRank('concept', 'change', 60, { force }),
    em.boardRank('concept', 'flow', 60, { force }),
    em.moneyFlowRank(100, cfg.EM_MAIN_BOARD_FS, { force }),
    em.marketSnapshot({ force }),
    em.sentimentGauge({ force }),
  ]);

  const byCode = new Map();
  for (const b of boardsHot) byCode.set(b.code, { ...(byCode.get(b.code) || {}), ...b });
  for (const b of boardsFlow) byCode.set(b.code, { ...(byCode.get(b.code) || {}), flowNet: b.mainNetIn });
  const boards = [...byCode.values()];

  const changeRank = new Map(boardsHot.map((b, i) => [b.code, i]));
  const flowRankIdx = new Map(boardsFlow.map((b, i) => [b.code, i]));
  for (const b of boards) {
    const cr = changeRank.has(b.code) ? changeRank.get(b.code) : 59;
    const fr = flowRankIdx.has(b.code) ? flowRankIdx.get(b.code) : 59;
    const upRatio = Number.isFinite(b.upCount) && Number.isFinite(b.downCount) && b.upCount + b.downCount > 0
      ? b.upCount / (b.upCount + b.downCount)
      : 0.5;
    b.heat = round(
      0.38 * (100 - norm(cr, 0, 59)) +
      0.37 * (100 - norm(fr, 0, 59)) +
      0.25 * (upRatio * 100),
      1,
    );
  }
  boards.sort((a, b) => b.heat - a.heat);
  const hotBoards = boards.slice(0, cfg.SELECT.hotBoardCount);

  const stockMap = new Map();
  await mapLimit(hotBoards, 4, async (board) => {
    const stocks = await em.boardStocks(board.code, cfg.SELECT.boardStockTop, { force }).catch(() => []);
    for (const s of stocks) {
      if (!passesBaseFilter(s)) continue;
      const prev = stockMap.get(s.code);
      const entry = {
        ...s,
        boards: [...new Set([...(prev ? prev.boards : []), board.name])],
        boardHeat: Math.max(prev ? prev.boardHeat : 0, board.heat),
        boardName: board.name,
        boardChangePct: board.changePct,
        boardMainNetIn: board.mainNetIn,
        boardLeader: board.leaderName,
        source: '板块热点',
      };
      stockMap.set(s.code, entry);
    }
  });

  const snapshotByCode = new Map(snapshot.rows.map((r) => [r.code, r]));
  for (const f of flowRank) {
    const snap = snapshotByCode.get(f.code) || {};
    const row = { ...snap, ...f };
    if (!passesBaseFilter(row)) continue;
    const prev = stockMap.get(f.code);
    if (prev) {
      prev.source = `${prev.source} + 资金排行`;
      continue;
    }
    stockMap.set(f.code, {
      ...row,
      boards: ['资金净流入榜'],
      boardHeat: 62,
      boardName: '资金关注（未归类热点板块）',
      source: '资金热点',
    });
  }

  const candidates = [...stockMap.values()];
  for (const c of candidates) {
    const heat = Number.isFinite(c.boardHeat) ? c.boardHeat : 55;
    const relStrength = Number.isFinite(c.boardChangePct)
      ? norm(c.changePct - c.boardChangePct, -3, 5)
      : norm(c.changePct, -2, 8);
    const turnover = Number.isFinite(c.turnoverRate) ? norm(c.turnoverRate, 0.5, 20) : 50;
    const vr = Number.isFinite(c.volumeRatio) ? norm(c.volumeRatio, 0.5, 3) : 50;

    c.score = round(
      0.30 * heat +
      0.24 * fundScore(c) +
      0.20 * relStrength +
      0.14 * (0.6 * turnover + 0.4 * vr) +
      0.12 * norm(c.amount, 1e8, 5e9),
      1,
    );
    const boardDesc = Number.isFinite(c.boardChangePct)
      ? `所属热点板块「${c.boardName}」热度分 ${round(heat, 1)}，板块今日 ${round(c.boardChangePct, 2)}%，板块主力净流入 ${fmtYi(c.boardMainNetIn)}`
      : `不属于当日热门板块，但登上「主力资金净流入榜」，属于资金先动的品种`;
    c.reasonParts = [
      boardDesc,
      Number.isFinite(c.mainNetIn) || Number.isFinite(c.mainNetInPct)
        ? `个股主力净流入 ${fmtYi(c.mainNetIn)}（占成交 ${round(c.mainNetInPct ?? 0, 1)}%）`
        : '',
      `今日涨幅 ${round(c.changePct ?? 0, 2)}%，换手 ${round(c.turnoverRate ?? 0, 2)}%，成交额 ${fmtYi(c.amount)}`,
    ].filter(Boolean);
  }

  const top = candidates.sort((a, b) => b.score - a.score).slice(0, perCategory + 4);
  const enriched = await enrichCandidates(top, { category: 'sentiment', sentiment });

  for (const item of enriched) {
    item.techScore = technicalScore(item.ctx);
    item.score = round(0.78 * item.score + 0.22 * item.techScore, 1);
    item.reasonParts.push(
      `技术面：${item.ctx.bullStack ? '均线多头排列' : '均线尚未多头'}，距 5 日线 ${item.ctx.priceVsMa5Pct}%，` +
      `成交量为 5 日均量 ${item.ctx.volRatio5 ?? '-'} 倍，ATR 波动 ${item.ctx.atrPct}%`,
    );
    if (Number.isFinite(item.ctx.position)) {
      item.reasonParts.push(`位于近 60 日区间 ${Math.round(item.ctx.position * 100)}% 位置（0=区间最低，100=最高）`);
    }
  }

  enriched.sort(sortByRank);
  const items = enriched.slice(0, perCategory).map((i) => finalizeItem(i, 'sentiment', sentiment));

  return {
    category: 'sentiment',
    categoryName: '情绪类（热点板块 + 资金流向）',
    headline: `${sentiment.level}行情：涨停 ${sentiment.limitUp} 家 / 跌停 ${sentiment.limitDown} 家 / 最高连板 ${sentiment.maxStreak} 板`,
    methodology:
      '先算概念板块热度（涨幅排名 + 主力净流入排名 + 上涨家数占比），再取板块内主板个股，' +
      '叠加个股主力资金、相对强度、量能与均线结构打分。情绪温度低时自动下调建议仓位。',
    boards: hotBoards.map((b) => ({
      code: b.code, name: b.name, heat: b.heat, changePct: b.changePct, mainNetIn: b.mainNetIn, leaderName: b.leaderName,
    })),
    items,
  };
}

/* ------------------------------------------------------------------ */
/* 二、消息类：重组 / 资本运作线索                                       */
/* ------------------------------------------------------------------ */

function classifyAnnouncement(title, columnNames = []) {
  const text = `${title} ${columnNames.join(' ')}`;
  // 程序性文件（督导意见、法律意见书、评估报告等）本身不含新增信息
  if (/(持续督导|督导意见|法律意见书|核查意见|专项核查|独立财务顾问|评估报告|审计报告|验资报告)/.test(text)) {
    return null;
  }
  const a = kw.matchAny(text, kw.RESTRUCTURE_A);
  const b = kw.matchAny(text, kw.RESTRUCTURE_B);
  const weak = kw.matchAny(text, kw.RESTRUCTURE_WEAK);
  // "已完成/已过户"类公告代表事件已经落地，催化作用远小于"筹划中"
  const done = /(已完成|完成|已过户|过户完成|实施完毕|办理完毕|终止|失败)/.test(text);
  if (a.length) {
    return {
      level: 'A',
      label: done ? '公告明确（事件已完成，催化基本落地）' : '公告明确（重组/资本运作）',
      hits: a,
      layer: done ? 2 : 1,
      done,
    };
  }
  if (b.length) {
    return {
      level: 'B',
      label: done ? '公告涉及（事项已完成）' : '公告涉及（并购/股权变动）',
      hits: b,
      layer: done ? 3 : 2,
      done,
    };
  }
  if (weak.length) {
    return {
      level: 'C',
      label: '公告涉及（程序性/小额事项，信号偏弱）',
      hits: weak,
      layer: 4,
      done,
    };
  }
  return null;
}

async function pickNews({ perCategory = cfg.SELECT.perCategory, force = false } = {}) {
  const [snapshot, announcementsPages, newsPages] = await Promise.all([
    em.marketSnapshot({ force }),
    mapLimit(
      Array.from({ length: cfg.SELECT.announcementPages }, (_, i) => i + 1),
      3,
      (p) => em.announcements(p, 100).catch(() => []),
    ),
    mapLimit(
      Array.from({ length: cfg.SELECT.newsPages }, (_, i) => i + 1),
      2,
      (p) => em.newsFlash(p, 50).catch(() => []),
    ),
  ]);
  const announcements = announcementsPages.flat();
  const news = newsPages.flat();

  const snapshotByCode = new Map(snapshot.rows.map((r) => [r.code, r]));
  const nameIndex = new Map();
  for (const r of snapshot.rows) {
    if (r.name && r.name.length >= 3) nameIndex.set(r.name, r.code);
  }

  const stockMap = new Map();
  const today = new Date();

  const push = (code, patch) => {
    if (!isMainBoard(code)) return;
    const prev = stockMap.get(code) || { code, evidences: [], newsHits: [], negHits: [], keywords: new Set(), sources: [] };
    prev.evidences.push(...(patch.evidences || []));
    prev.newsHits.push(...(patch.newsHits || []));
    prev.negHits.push(...(patch.negHits || []));
    for (const k of patch.keywords || []) prev.keywords.add(k);
    prev.bestLayer = Math.min(prev.bestLayer || 9, patch.layer || 9);
    prev.sources = [...new Set([...prev.sources, ...(patch.sources || [])])];
    stockMap.set(code, prev);
  };

  for (const ann of announcements) {
    const hit = classifyAnnouncement(ann.title, ann.columns);
    if (!hit) continue;
    const daysOld = eventsEngine.daysBetween(ann.date, eventsEngine.toDateStr(today));
    if (daysOld > 3) continue; // 超过 3 天的旧公告不再作为线索
    for (const c of ann.codes) {
      push(c.code, {
        layer: hit.layer + (daysOld <= 1 ? 0 : 1),
        evidences: [{
          title: ann.title,
          date: ann.date,
          url: ann.url,
          level: hit.level,
          label: hit.label,
          source: '交易所公告',
          done: !!hit.done,
        }],
        keywords: hit.hits,
        negHits: kw.matchAny(ann.title, kw.NEGATIVE_WORDS),
        sources: ['交易所公告'],
      });
    }
  }

  for (const n of news) {
    const text = `${n.title} ${n.summary}`;
    const a = kw.matchAny(text, kw.RESTRUCTURE_A);
    const b = kw.matchAny(text, kw.RESTRUCTURE_B);
    const c = kw.matchAny(text, kw.RESTRUCTURE_C);
    if (!a.length && !b.length) continue;
    const neg = kw.matchAny(text, kw.NEGATIVE_WORDS);
    const codes = new Set([
      ...n.stocks.map((s) => s.code).filter(Boolean),
      ...[...nameIndex.entries()].filter(([name]) => text.includes(name)).map(([, code]) => code),
    ]);
    for (const code of codes) {
      push(code, {
        layer: a.length ? 2 : 3,
        newsHits: [{
          title: n.title, time: n.time, url: n.url,
          level: a.length ? 'A(媒体)' : 'C(传闻)',
          label: a.length ? '媒体报道的重组类表述' : '传闻/推测性表述（未证实）',
          source: n.source,
        }],
        keywords: [...a, ...b, ...c],
        negHits: neg,
        sources: ['7x24 快讯'],
      });
    }
  }

  const candidates = [];
  for (const entry of stockMap.values()) {
    const snap = snapshotByCode.get(entry.code);
    if (!snap) continue;
    if (!passesBaseFilter({ ...snap, changePct: Math.min(snap.changePct ?? 0, 9.6) })) continue;

    const negPenalty = entry.negHits.length * 12;
    const layerScore = { 1: 95, 2: 78, 3: 62 }[entry.bestLayer] || 55;
    const evidenceBoost = Math.min(12, Math.max(0, (entry.evidences.length + entry.newsHits.length - 1) * 4));
    const keywords = [...entry.keywords];
    const strength = Math.min(15, keywords.length * 3);
    const score = Math.max(0, Math.min(100, layerScore + evidenceBoost + strength - negPenalty));

    candidates.push({
      ...snap,
      score: round(score, 1),
      evidences: entry.evidences,
      newsHits: entry.newsHits,
      negHits: entry.negHits,
      keywords,
      sources: entry.sources,
      bestLayer: entry.bestLayer,
    });
  }

  const top = candidates.sort((a, b) => b.score - a.score).slice(0, perCategory + 4);
  const enriched = await enrichCandidates(top, {
    category: 'news',
    sentiment: null,
    extraByCode: Object.fromEntries(
      top.map((t) => [t.code, { evidenceLevel: t.bestLayer === 1 ? 'A' : t.bestLayer === 2 ? 'B' : 'C' }]),
    ),
  });

  for (const item of enriched) {
    item.techScore = technicalScore(item.ctx);
    item.score = round(0.7 * item.score + 0.3 * item.techScore, 1);
    item.reasonParts = [
      item.evidences.length
        ? `公告线索：${item.evidences.map((e) => `《${e.title}》(${e.date})`).join('；')}`
        : `快讯线索：${item.newsHits.map((e) => `《${e.title}》(${e.time})`).join('；')}`,
      `命中关键词：${item.keywords.slice(0, 6).join('、')}`,
      `资金面：主力净流入 ${fmtYi(item.mainNetIn)}（占成交 ${round(item.mainNetInPct ?? 0, 1)}%），换手 ${round(item.turnoverRate ?? 0, 2)}%`,
      `技术面：${item.ctx.bullStack ? '均线多头排列' : '均线尚未多头'}，距 5 日线 ${item.ctx.priceVsMa5Pct}%，` +
        `60 日区间位置 ${Number.isFinite(item.ctx.position) ? `${Math.round(item.ctx.position * 100)}%` : '-'}`,
    ];
    if (item.evidences.some((e) => e.done)) {
      item.risks = [
        ...(item.risks || []),
        '相关事项公告中已出现"完成/已过户"等表述，属于事件落地而非"预期阶段"，追高性价比低，建议等回踩',
      ];
    }
    if (item.negHits.length) {
      item.risks = [...(item.risks || []), ...item.negHits.map((w) => `出现负面词「${w}」，注意澄清、终止或问询风险`)];
    }
  }

  enriched.sort(sortByRank);
  const items = enriched.slice(0, perCategory).map((i) => finalizeItem(i, 'news', null));

  return {
    category: 'news',
    categoryName: '消息类（重组 / 资本运作线索）',
    headline: `扫描最近 ${announcements.length} 条公告 + ${news.length} 条快讯，命中重组/资本运作线索 ${candidates.length} 只（主板）`,
    methodology:
      '只从"公开公告 + 公开快讯"里找线索，按证据等级分三类：A=公告明确提及重大资产重组/发行股份购买资产/控制权变更；' +
      'B=公告涉及收购、股权转让、资产注入等；C=媒体报道的传闻（未证实，界面会标注）。命中澄清、终止、问询函等负面词会扣分。' +
      '所有结论都附原文标题与链接，涉及重组的判断请一律以公司公告为准。',
    items,
  };
}

/* ------------------------------------------------------------------ */
/* 三、大事件类                                                        */
/* ------------------------------------------------------------------ */

async function pickEvent({ perCategory = cfg.SELECT.perCategory, force = false } = {}) {
  const [snapshot, newsPages, boardsChange, boardsFlow, sentiment] = await Promise.all([
    em.marketSnapshot({ force }),
    mapLimit(Array.from({ length: 3 }, (_, i) => i + 1), 2, (p) => em.newsFlash(p, 50).catch(() => [])),
    em.boardRank('concept', 'change', 100, { force }),
    em.boardRank('concept', 'flow', 100, { force }),
    em.sentimentGauge({ force }),
  ]);
  const news = newsPages.flat();

  const boardMap = new Map();
  for (const b of boardsChange) boardMap.set(b.code, { ...b, heat: 50 });
  for (const b of boardsFlow) {
    const prev = boardMap.get(b.code) || {};
    boardMap.set(b.code, { ...prev, ...b, flowNet: b.mainNetIn, heat: (prev.heat || 50) + 10 });
  }
  const boards = [...boardMap.values()];

  const upcomingEvents = eventsEngine
    .upcoming(news, { windowDays: cfg.EVENT_WINDOW_DAYS })
    .sort((a, b) => (b.level || 3) * eventsEngine.timingScore(b.daysUntil) - (a.level || 3) * eventsEngine.timingScore(a.daysUntil))
    .slice(0, 8);

  const snapshotByCode = new Map(snapshot.rows.map((r) => [r.code, r]));
  const stockMap = new Map();
  const eventInfo = [];

  for (const ev of upcomingEvents) {
    const matched = eventsEngine.matchBoards(ev, boards);
    eventInfo.push({ ...ev, matchedBoards: matched.slice(0, 3).map((b) => ({ code: b.code, name: b.name, changePct: b.changePct })) });
    if (!matched.length) continue;

    const timing = eventsEngine.timingScore(ev.daysUntil);
    const usedBoards = matched.slice(0, 3);
    await mapLimit(usedBoards, 3, async (board) => {
      const stocks = await em.boardStocks(board.code, 30, { force }).catch(() => []);
      for (const s of stocks) {
        const snap = snapshotByCode.get(s.code);
        if (!snap) continue;
        // 用全市场快照的真实涨跌幅/成交额做过滤（板块成分股接口字段可能滞后）
        if (!passesBaseFilter({ ...s, ...snap })) continue;
        const prev = stockMap.get(s.code);
        stockMap.set(s.code, {
          ...snap,
          ...prune(s),
          events: [...new Set([...(prev ? prev.events : []), ev.name])],
          eventDetails: [
            ...(prev ? prev.eventDetails : []),
            {
              name: ev.name, date: ev.date, daysUntil: ev.daysUntil, level: ev.level,
              verify: ev.verify, source: ev.source, sourceUrl: ev.sourceUrl, impact: ev.impact,
            },
          ],
          matchedBoards: [...new Set([...(prev ? prev.matchedBoards : []), board.name])],
          timing: Math.max(prev ? prev.timing : 0, timing),
          eventLevel: Math.max(prev ? prev.eventLevel : 0, ev.level || 3),
        });
      }
    });
  }

  const candidates = [...stockMap.values()].map((c) => ({
    ...c,
    score: round(
      0.34 * c.timing +
      0.20 * ((c.eventLevel / 5) * 100) +
      0.20 * fundScore(c) +
      0.14 * norm(c.boardChangePct, -2, 6) +
      0.12 * norm(c.amount, 1e8, 5e9),
      1,
    ),
    reasonParts: [
      `主事件：「${c.events[0]}」${c.eventDetails[0]?.verify ? '（日期按周期规律推算，需先核实官方日程）' : ''}` +
        (c.events.length > 1 ? `；同时受益于另外 ${c.events.length - 1} 个事件窗口` : ''),
      `受益链条：${c.events.join(' / ')} → 概念板块「${c.matchedBoards.join('、')}」`,
      `时间窗口：${c.eventDetails[0]?.daysUntil >= 0 ? `距事件还有 ${c.eventDetails[0].daysUntil} 天` : '事件进行中'}，处于"买预期"阶段`,
      `资金面：主力净流入 ${fmtYi(c.mainNetIn)}（占成交 ${round(c.mainNetInPct ?? 0, 1)}%），成交额 ${fmtYi(c.amount)}`,
    ],
  }));

  const top = candidates.sort((a, b) => b.score - a.score).slice(0, perCategory + 4);
  const extraByCode = Object.fromEntries(
    top.map((t) => [t.code, { eventDate: t.eventDetails[0]?.date, eventName: t.eventDetails[0]?.name }]),
  );
  const enriched = await enrichCandidates(top, { category: 'event', sentiment, extraByCode });

  for (const item of enriched) {
    item.techScore = technicalScore(item.ctx);
    item.score = round(0.75 * item.score + 0.25 * item.techScore, 1);
    item.reasonParts.push(
      `技术面：${item.ctx.bullStack ? '均线多头排列' : '均线尚未多头'}，距 5 日线 ${item.ctx.priceVsMa5Pct}%，` +
      `60 日区间位置 ${Number.isFinite(item.ctx.position) ? `${Math.round(item.ctx.position * 100)}%` : '-'}，ATR ${item.ctx.atrPct}%`,
    );
    const d0 = item.eventDetails && item.eventDetails[0];
    if (d0 && d0.daysUntil >= 0 && d0.daysUntil <= 3) {
      item.risks = [...(item.risks || []), '事件已非常临近，进入兑现窗口，注意"利好出尽"，不宜追高'];
    }
  }

  enriched.sort(sortByRank);
  const items = enriched.slice(0, perCategory).map((i) => finalizeItem(i, 'event', sentiment));

  return {
    category: 'event',
    categoryName: '大事件类（会议 / 大会 / 发布会）',
    headline: `未来 ${cfg.EVENT_WINDOW_DAYS} 天内有 ${upcomingEvents.length} 个事件进入窗口，已映射到主板个股`,
    methodology:
      '事件来源三部分：①内置周期规律事件库（进博会、珠海航展、三季报窗口等，日期按往年规律推算并标注"待核实"）；' +
      '②从 7x24 快讯里实时抽取的、带明确时间的大会/发布会；③你自己添加的事件。' +
      '事件按主题映射到概念板块，再在板块内按资金流与股价位置选票，并强制给出"事件前减仓"的卖出纪律。',
    events: eventInfo,
    items,
  };
}

/* ------------------------------------------------------------------ */
/* 汇总输出                                                            */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 四、基本面类：公司经营 + 股东结构 + 估值分位                          */
/* ------------------------------------------------------------------ */

async function pickFundamental({ perCategory = cfg.SELECT.perCategory, force = false } = {}) {
  const [snapshot, sentiment, data] = await Promise.all([
    em.marketSnapshot({ force }),
    em.sentimentGauge({ force }).catch(() => null),
    fundamentalsEngine.loadFundamentalData({ force }),
  ]);

  const rows = snapshot.rows.filter((r) => passesBaseFilter(r));
  const candidates = fundamentalsEngine.buildCandidates({ snapshot: { ...snapshot, rows }, data });

  const top = candidates.sort((a, b) => b.score - a.score).slice(0, perCategory + 8);
  const enriched = await enrichCandidates(top, { category: 'fundamental', sentiment });

  for (const item of enriched) {
    item.techScore = technicalScore(item.ctx);
    item.score = round(0.74 * item.score + 0.26 * item.techScore, 1);

    const price = item.quote?.price ?? item.price;
    const t2 = item.plan?.targets?.[1]?.price;
    const t1 = item.plan?.targets?.[0]?.price;
    item.upsidePct = Number.isFinite(price) && Number.isFinite(t2) && price > 0
      ? round(((t2 - price) / price) * 100, 1)
      : null;
    item.upside1Pct = Number.isFinite(price) && Number.isFinite(t1) && price > 0
      ? round(((t1 - price) / price) * 100, 1)
      : null;

    const pos = item.ctx?.position;
    item.reasonParts.push(
      `上涨空间：第一目标 ${t1 ?? '-'}（${item.upside1Pct ?? '-'}%）、第二目标 ${t2 ?? '-'}（${item.upsidePct ?? '-'}%），` +
        `现价位于近 60 日区间 ${Number.isFinite(pos) ? `${Math.round(pos * 100)}%` : '-'} 位置，` +
        `技术面${item.ctx?.bullStack ? '均线多头排列' : '均线尚未多头'}、距 5 日线 ${item.ctx?.priceVsMa5Pct ?? '-'}%`,
    );
    item.reasonParts.push(
      `筛选逻辑：基本面分 ${item.fundScore}（成长/质量/估值/筹码/机构五维加权）` +
        `与技术面分 ${item.techScore} 合成 ${item.score}，再用"评分 + 期望收益"排序，优先选基本面改善、股价还没兑现的品种`,
    );

    if (Number.isFinite(pos) && pos > 0.85) {
      item.risks = [...(item.risks || []), '股价已处于近 60 日区间高位，基本面再好也属于"追高位置"，建议等回踩再买'];
    }
    if (Number.isFinite(item.upsidePct) && item.upsidePct < 8) {
      item.risks = [...(item.risks || []), '按当前波动率测算，向上空间不足 8%，性价比一般，可等更低的买点'];
    }

    item.boards = [item.fundamental?.industry, item.fundamental?.orgLabel].filter(Boolean);
  }

  enriched.sort(sortByRank);

  // "上涨空间"筛选：目标空间不足的先剔除；若剩得太少再放开，避免出现空列表
  const minUpside = cfg.SELECT.fundamentalMinUpside;
  const withSpace = enriched.filter((i) => (i.upsidePct ?? 0) >= minUpside);
  const finalPool = withSpace.length >= Math.min(perCategory, 4) ? withSpace : enriched;
  const items = finalPool.slice(0, perCategory).map((i) => finalizeItem(i, 'fundamental', null));

  const counts = data.counts;
  return {
    category: 'fundamental',
    categoryName: '基本面类（公司经营 + 股东结构 + 估值分位）',
    headline:
      `财报期 ${data.reportPeriod || '-'} · 估值日 ${data.valuationDate || '-'}：` +
      `业绩 ${counts.perf} 条 / 股东户数 ${counts.holders} 条 / 机构持仓 ${counts.orgs} 条 / ` +
      `估值 ${counts.vals} 条，主板达标 ${candidates.length} 只，按上涨空间筛出 ${items.length} 只`,
    methodology:
      '五个维度加权打分：①成长（营收/净利同比）②质量（ROE、毛利率、每股经营现金流、资产负债率、ROIC）' +
      '③估值（PE、PB 在所属行业内的分位，越低越便宜；亏损股直接扣分）' +
      '④筹码（股东户数环比变化，户数减少=筹码集中；户均持股市值越高说明大户占比越高）' +
      '⑤机构（机构家数环比变化、机构持股占流通股比例、"机构新进/增持/减持"标签）。' +
      '基本面分与技术位置合成后，再用"评分 + 期望收益"排序，并优先保留目标空间足够的品种。' +
      '银行、保险等金融股的资产负债率天然偏高，程序会自动切换成 ROE/ROIC 口径，不做负债率扣分。',
    stats: {
      reportPeriod: data.reportPeriod,
      valuationDate: data.valuationDate,
      counts,
      candidates: candidates.length,
      minUpside,
    },
    items,
  };
}

function finalizeItem(item, category, sentiment) {
  const plan = item.plan || null;
  const risks = [...(item.risks || [])];
  if (category === 'sentiment' && sentiment && (sentiment.level === '冰点' || sentiment.level === '偏冷')) {
    risks.push(`当前市场情绪处于「${sentiment.level}」，题材股容易一日游，建议降低仓位、缩短持股周期`);
  }
  if (category === 'news' && (item.newsHits || []).length && !(item.evidences || []).length) {
    risks.push('线索来自媒体报道，未经公司公告确认，存在证伪风险，务必以公告为准');
  }
  if (category === 'news' && item.bestLayer >= 4) {
    risks.push('命中的是"增资扩股/一致行动/员工持股"这类程序性事项，与重组重估的关联度较弱，只宜作为线索观察');
  }
  if (category === 'event') {
    risks.push('事件驱动行情通常"买在预期、卖在事实"，临近事件反而要逐步兑现');
  }
  if (Number.isFinite(item.ctx?.atrPct) && item.ctx.atrPct > 6) {
    risks.push(`该股日常波动（ATR）达 ${item.ctx.atrPct}%，属高波动品种，建议按建议仓位打折执行`);
  }
  if (Number.isFinite(item.mainNetIn) && item.mainNetIn < 0) {
    risks.push(`当日主力资金净流出 ${fmtYi(Math.abs(item.mainNetIn))}，上涨并非主力资金驱动，注意持续性`);
  }
  // 盈亏比不足 1 的机会：赢的空间比亏的空间还小，必须等更低的买点，排序上也要扣一点分
  let adjustedScore = item.score;
  if (plan && Number.isFinite(plan.riskReward) && plan.riskReward < 1) {
    risks.push(
      `盈亏比只有 ${plan.riskReward}（目标空间小于止损空间），属于"胜率高但赔率差"的形态，` +
        '只适合在买入区间下沿低吸，或干脆放弃等更好的价格',
    );
    adjustedScore = round(adjustedScore * 0.94, 1);
  }

  return {
    code: item.code,
    name: item.name,
    price: item.quote?.price ?? item.price,
    changePct: item.quote?.changePct ?? item.changePct,
    turnoverRate: item.quote?.turnoverRate ?? item.turnoverRate,
    amount: item.quote?.amount ?? item.amount,
    volumeRatio: item.quote?.volumeRatio ?? item.volumeRatio,
    mainNetIn: item.mainNetIn,
    mainNetInPct: item.mainNetInPct,
    floatCap: item.floatCap,
    category,
    categoryName: {
      sentiment: '情绪类',
      news: '消息类',
      event: '大事件类',
      fundamental: '基本面类',
    }[category] || '选股',
    score: adjustedScore,
    fundScore: item.fundScore ?? null,
    techScore: item.techScore,
    winRate: plan?.winRate ?? null,
    expectedPct: plan?.expectedPct ?? null,
    upsidePct: item.upsidePct ?? null,
    boardNames: item.boards || item.matchedBoards || [],
    badges: item.badges || [],
    fundamental: item.fundamental || null,
    events: item.events || [],
    keywords: item.keywords || [],
    sources: item.sources || [],
    reasons: item.reasonParts || [],
    risks,
    evidence: [...(item.evidences || []), ...(item.newsHits || [])].slice(0, 8),
    plan,
    tech: item.ctx,
    dataSource: item.dataSource,
  };
}

async function pickAll(options = {}) {
  const started = Date.now();
  const [sentiment, news, event, fundamental] = await Promise.all([
    pickSentiment(options).catch((e) => ({ category: 'sentiment', categoryName: '情绪类', error: e.message, items: [] })),
    pickNews(options).catch((e) => ({ category: 'news', categoryName: '消息类', error: e.message, items: [] })),
    pickEvent(options).catch((e) => ({ category: 'event', categoryName: '大事件类', error: e.message, items: [] })),
    pickFundamental(options).catch((e) => ({ category: 'fundamental', categoryName: '基本面类', error: e.message, items: [] })),
  ]);
  const all = [...sentiment.items, ...news.items, ...event.items, ...fundamental.items];
  all.sort((a, b) => (b.expectedPct ?? b.score) - (a.expectedPct ?? a.score));
  return { at: Date.now(), elapsedMs: Date.now() - started, sentiment, news, event, fundamental, top: all.slice(0, 12) };
}

module.exports = {
  pickAll,
  pickSentiment,
  pickNews,
  pickEvent,
  pickFundamental,
  isMainBoard,
  passesBaseFilter,
  technicalScore,
};
