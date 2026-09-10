'use strict';

/**
 * 模拟盘（纸面交易）引擎。
 *
 * 规则：起始本金 10 万元，只做沪深主板，按 A 股真实交易规则逐日记录。
 *   - T+1：当日买入的股票次日才能卖（实现方式：只用"昨日之前的持仓"做卖出判断）
 *   - 100 股/手：买入必须是 100 股的整数倍
 *   - 涨停不追（买不进）、跌停不卖
 *   - 费用：佣金万分之2.5（最低 5 元）、卖出印花税 0.05%、过户费 0.001%（双边）
 *   - 单只仓位上限用选股引擎给出的建议仓位，最多同时持有 5 只
 *
 * 记录方式：
 *   - 每个自然日只留一条记录（交易日=建仓/调仓/持有，非交易日=休市）
 *   - 当天的成交一旦落定就锁定，不再随盘中价格反复变化
 *   - 盘中用实时价、收盘后用当日收盘价、盘前用上一交易日收盘价（开盘后会重算）
 *   - 过去的日子在之后运行时按当日收盘价结算一次，然后冻结
 *   - 错过的交易日会按当日收盘价补记，保证净值曲线连续
 *
 * 所有持仓、现金、盈亏都由"成交流水重放"算出来，不存在对不上的情况。
 */

const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const em = require('../data/eastmoney');
const { round } = require('./indicators');

const STATE_FILE = path.join(cfg.USER_DIR, 'portfolio.json');
const STATE_VERSION = 1;

const INITIAL_CAPITAL = 100000;
const MAX_POSITIONS = 5;
const LOT = 100;              // 1 手 = 100 股
const MIN_SCORE = 62;         // 入选最低综合评分
const BUY_TOL_UP = 1.008;     // 允许略高于买入区间上沿
const BUY_TOL_DOWN = 0.97;    // 跌穿买入区间下沿太多，视为形态走坏
const BACKFILL_LIMIT = 60;    // 单次最多补记多少个交易日

const FEE = {
  commissionRate: 0.00025,  // 佣金 万分之2.5
  commissionMin: 5,         // 单笔最低 5 元
  stampDutyRate: 0.0005,    // 印花税 0.05%（仅卖出）
  transferRate: 0.00001,    // 过户费 0.001%（双边）
};

/** 各类别的持股天数上限（和选股引擎的卖出纪律保持一致） */
const HOLD_LIMIT = { sentiment: 5, news: 20, event: 20, fundamental: 60 };

/* ------------------------------------------------------------------ */
/* 时间（一律按北京时间算，不受机器时区影响）                            */
/* ------------------------------------------------------------------ */

const BJ_OFFSET = 8 * 3600 * 1000;
const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad2 = (n) => String(n).padStart(2, '0');

function bj(ts = Date.now()) {
  return new Date(ts + BJ_OFFSET);
}

function dateStr(ts = Date.now()) {
  const d = bj(ts);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function minutesOfDay(ts = Date.now()) {
  const d = bj(ts);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function weekdayOf(dateOrTs) {
  if (typeof dateOrTs === 'string') {
    const [y, m, d] = dateOrTs.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  }
  return bj(dateOrTs).getUTCDay();
}

function weekdayName(dateStrValue) {
  return WD[weekdayOf(dateStrValue)] || '';
}

function daysBetween(from, to) {
  if (!from || !to) return 1;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 1;
  return Math.max(1, Math.round((b - a) / 86400000));
}

/* ------------------------------------------------------------------ */
/* 费用                                                                */
/* ------------------------------------------------------------------ */

function commissionOf(amount) {
  return Math.max(amount * FEE.commissionRate, FEE.commissionMin);
}

function buyFee(gross) {
  return round(commissionOf(gross) + gross * FEE.transferRate, 2);
}

function sellFee(gross) {
  return round(commissionOf(gross) + gross * FEE.transferRate + gross * FEE.stampDutyRate, 2);
}

/* ------------------------------------------------------------------ */
/* 状态读写                                                            */
/* ------------------------------------------------------------------ */

function emptyState() {
  return {
    version: STATE_VERSION,
    initialCapital: INITIAL_CAPITAL,
    startDate: null,
    createdAt: null,
    lastRunAt: 0,
    journal: [],
  };
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (parsed && Array.isArray(parsed.journal)) {
      parsed.initialCapital = Number(parsed.initialCapital) || INITIAL_CAPITAL;
      return parsed;
    }
  } catch (_) {
    /* 首次运行或文件损坏：重新开始 */
  }
  return null;
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    throw new Error(`模拟盘数据写入失败：${err.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* 成交流水 -> 账户重放                                                  */
/* ------------------------------------------------------------------ */

/** 把成交流水重放成"现金 + 持仓"，保证账实永远一致 */
function replay(initialCapital, trades) {
  let cash = initialCapital;
  const positions = new Map();

  for (const t of trades || []) {
    if (!t || !Number.isFinite(t.price) || !Number.isFinite(t.shares)) continue;
    const gross = t.price * t.shares;
    if (t.side === 'buy') {
      cash -= gross + (Number(t.fee) || 0);
      const prev = positions.get(t.code);
      if (prev) {
        const shares = prev.shares + t.shares;
        const cost = (prev.cost * prev.shares + gross + (Number(t.fee) || 0)) / shares;
        positions.set(t.code, { ...prev, shares, cost, lastBuyDate: t.date });
      } else {
        positions.set(t.code, {
          code: t.code,
          name: t.name,
          shares: t.shares,
          cost: (gross + (Number(t.fee) || 0)) / t.shares,
          openDate: t.date,
          lastBuyDate: t.date,
          category: t.category || 'sentiment',
          plan: t.plan || null,
          sells: 0,
        });
      }
    } else if (t.side === 'sell') {
      cash += gross - (Number(t.fee) || 0);
      const prev = positions.get(t.code);
      if (!prev) continue;
      const shares = prev.shares - t.shares;
      if (shares <= 0) positions.delete(t.code);
      else positions.set(t.code, { ...prev, shares, sells: prev.sells + 1 });
    }
  }

  return { cash: round(cash, 2), positions };
}

function collectTrades(state, predicate) {
  const out = [];
  for (const entry of state.journal) {
    if (!predicate(entry.date)) continue;
    for (const t of entry.trades || []) out.push(t);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 交易日判定                                                          */
/* ------------------------------------------------------------------ */

/**
 * 用"最新行情时间"判断今天是不是交易日：
 * 东方财富快照的 f86 字段就是最后一笔行情的时间戳，比猜节假日靠谱。
 */
function resolveSession(now, clock) {
  const date = dateStr(now);
  const wd = weekdayOf(now);
  const minutes = minutesOfDay(now);
  const lastQuoteDate = (clock && clock.date) || null;

  if (lastQuoteDate && lastQuoteDate >= date) {
    return {
      date,
      weekday: WD[wd],
      trading: true,
      priceSource: minutes < 15 * 60 + 5 ? 'live' : 'close',
      clock,
    };
  }
  if (wd === 0 || wd === 6) {
    return { date, weekday: WD[wd], trading: false, reason: '周末休市', priceSource: 'prevClose', clock };
  }
  if (lastQuoteDate && minutes >= 16 * 60) {
    return {
      date,
      weekday: WD[wd],
      trading: false,
      reason: '今日全市场无行情（节假日休市）',
      priceSource: 'prevClose',
      clock,
    };
  }
  return {
    date,
    weekday: WD[wd],
    trading: true,
    priceSource: minutes >= 9 * 60 + 30 ? 'live' : 'prevClose',
    preOpen: minutes < 9 * 60 + 30,
    clock,
  };
}

const PRICE_SOURCE_TEXT = {
  live: '盘中实时价',
  close: '当日收盘价',
  prevClose: '上一交易日收盘价（盘前参考，开盘后自动重算）',
};

/* ------------------------------------------------------------------ */
/* 交易决策                                                            */
/* ------------------------------------------------------------------ */

function slimPlan(plan) {
  if (!plan) return null;
  return {
    category: plan.category,
    horizon: plan.horizon,
    planType: plan.planType,
    buyZone: plan.buyZone,
    entryMid: plan.entryMid,
    stopLoss: plan.stopLoss,
    stopLossPct: plan.stopLossPct,
    targets: plan.targets,
    riskReward: plan.riskReward,
    positionPct: plan.positionPct,
    winRate: plan.winRate,
    atr: plan.atr,
  };
}

function makeTrade(side, position, price, shares, reason, extra) {
  const gross = round(price * shares, 2);
  const fee = side === 'buy' ? buyFee(gross) : sellFee(gross);
  return {
    date: extra.date,
    code: position.code,
    name: position.name,
    side,
    price: round(price, 2),
    shares,
    amount: gross,
    fee,
    net: round(side === 'buy' ? gross + fee : gross - fee, 2),
    reason,
    category: extra.category || position.category || null,
    plan: extra.plan !== undefined ? extra.plan : position.plan,
    priceSource: extra.priceSource,
  };
}

/** 卖出：止损 / 目标 / 持有到期。只用"昨日之前的持仓"，天然满足 T+1 */
function decideSells(acc, quotes, today, session) {
  const trades = [];
  for (const pos of acc.positions.values()) {
    const q = quotes.get(pos.code) || {};
    const price = Number.isFinite(q.price) ? q.price : null;
    if (price === null || price <= 0) continue;
    if (Number.isFinite(q.changePct) && q.changePct <= -9.8) continue; // 跌停卖不出去

    const plan = pos.plan || {};
    const stop = Number.isFinite(plan.stopLoss) ? plan.stopLoss : null;
    const t1 = plan.targets && plan.targets[0] ? plan.targets[0].price : null;
    const t2 = plan.targets && plan.targets[1] ? plan.targets[1].price : null;
    const extra = { date: today, category: pos.category, plan: pos.plan, priceSource: session.priceSource };

    let shares = 0;
    let reason = '';
    if (stop && price <= stop) {
      shares = pos.shares;
      reason = `现价 ${round(price, 2)} 跌破止损价 ${stop}，按纪律无条件清仓`;
    } else if (t2 && price >= t2) {
      shares = pos.shares;
      reason = `触及第二目标 ${t2}（现价 ${round(price, 2)}），清仓兑现`;
    } else if (t1 && price >= t1 && !pos.sells) {
      shares = Math.floor(pos.shares / 2 / LOT) * LOT;
      if (shares < LOT) shares = pos.shares;
      reason = `触及第一目标 ${t1}（现价 ${round(price, 2)}），先减半仓锁定利润`;
    } else {
      const held = daysBetween(pos.openDate, today);
      const limit = HOLD_LIMIT[pos.category] ?? 20;
      if (held >= limit && price <= pos.cost) {
        shares = pos.shares;
        reason = `持有 ${held} 个交易日仍未走出成本区，按纪律换股`;
      }
    }
    if (shares > 0) trades.push(makeTrade('sell', pos, price, shares, reason, extra));
  }
  return trades;
}

/** 买入：从当日选股结果里挑"价格正好落在买入区间"的标的 */
function decideBuys(acc, quotes, picks, today, session) {
  const out = [];
  const items = (picks && picks.top) || [];
  if (!items.length) return out;

  const positions = new Map(acc.positions);
  let cash = acc.cash;
  let marketValue = 0;
  for (const p of acc.positions.values()) {
    const q = quotes.get(p.code) || {};
    marketValue += (Number.isFinite(q.price) ? q.price : p.cost) * p.shares;
  }
  const totalAssets = cash + marketValue;

  for (const item of items) {
    if (positions.size >= MAX_POSITIONS) break;
    if (!item || !item.code || positions.has(item.code)) continue;
    const plan = item.plan;
    if (!plan || !plan.buyZone || !Number.isFinite(plan.buyZone.low) || !Number.isFinite(plan.buyZone.high)) continue;

    const q = quotes.get(item.code) || {};
    const price = Number.isFinite(q.price) ? q.price : item.price;
    if (!Number.isFinite(price) || price <= 0) continue;
    const changePct = Number.isFinite(q.changePct) ? q.changePct : item.changePct;
    if (Number.isFinite(changePct) && changePct >= 9.8) continue;   // 涨停，买不进
    if (Number.isFinite(changePct) && changePct <= -9.8) continue;  // 跌停，不接
    if ((item.score ?? 0) < MIN_SCORE) continue;
    if (Number.isFinite(plan.riskReward) && plan.riskReward < 1) continue;
    if (price > plan.buyZone.high * BUY_TOL_UP) continue;   // 高于买区上限，等回踩
    if (price < plan.buyZone.low * BUY_TOL_DOWN) continue;  // 跌穿买区，形态走坏

    const weight = Math.min(Math.max(Number(plan.positionPct) || 10, 5), 30);
    const budget = Math.min(totalAssets * (weight / 100), cash);
    let shares = Math.floor(budget / price / LOT) * LOT;
    while (shares >= LOT && price * shares + buyFee(price * shares) > cash) shares -= LOT;
    if (shares < LOT) continue;

    const gross = price * shares;
    const fee = buyFee(gross);
    const reason =
      `评分 ${item.score}｜现价 ${round(price, 2)} 落在买入区间 ${plan.buyZone.low}-${plan.buyZone.high}｜` +
      `止损 ${plan.stopLoss}，目标 ${plan.targets.map((t) => t.price).join(' / ')}｜` +
      `建议仓位 ${weight}%（实际 ${round((gross / totalAssets) * 100, 1)}%）`;

    out.push(
      makeTrade('buy', { code: item.code, name: item.name, category: item.category, plan }, price, shares, reason, {
        date: today,
        category: item.category,
        plan: slimPlan(plan),
        priceSource: session.priceSource,
      }),
    );

    cash -= gross + fee;
    positions.set(item.code, {
      code: item.code,
      name: item.name,
      shares,
      cost: (gross + fee) / shares,
      openDate: today,
      category: item.category,
      plan,
      sells: 0,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 持仓快照                                                            */
/* ------------------------------------------------------------------ */

function describeHold(p, price, t1) {
  const plan = p.plan || {};
  const stop = Number.isFinite(plan.stopLoss) ? plan.stopLoss : null;
  if (stop && price <= stop) return `已跌破止损 ${stop}，下一交易日执行`;
  if (t1 && price >= t1) return `已到第一目标 ${t1}，准备减半`;
  if (price > p.cost) return `浮盈持有，止损位 ${stop ?? '-'}`;
  return `小幅浮亏持有，仍高于止损位 ${stop ?? '-'}`;
}

/** 这只票"下一步怎么办"，写在每日记录里，读起来一目了然 */
function nextActionOf(p) {
  const plan = p.plan || {};
  const stop = Number.isFinite(plan.stopLoss) ? plan.stopLoss : null;
  const t1 = plan.targets && plan.targets[0] ? plan.targets[0].price : null;
  const t2 = plan.targets && plan.targets[1] ? plan.targets[1].price : null;
  const bits = [];
  if (t1) bits.push(`涨到 ${t1} 减一半`);
  if (t2) bits.push(`涨到 ${t2} 全部卖出`);
  if (stop) bits.push(`跌破 ${stop} 无条件清仓`);
  return bits.length ? bits.join('；') : '按计划持有';
}

function markPositions(acc, quotes, today) {
  const rows = [];
  for (const p of acc.positions.values()) {
    const q = quotes.get(p.code) || {};
    const price = Number.isFinite(q.price) ? q.price : p.cost;
    const marketValue = round(price * p.shares, 2);
    const costValue = p.cost * p.shares;
    const plan = p.plan || {};
    const t1 = plan.targets && plan.targets[0] ? plan.targets[0].price : null;
    rows.push({
      code: p.code,
      name: p.name,
      shares: p.shares,
      cost: round(p.cost, 2),
      last: round(price, 2),
      changePct: Number.isFinite(q.changePct) ? q.changePct : null,
      marketValue,
      floatPnl: round(marketValue - costValue, 2),
      floatPnlPct: p.cost ? round(((price - p.cost) / p.cost) * 100, 2) : 0,
      category: p.category || null,
      openDate: p.openDate,
      heldDays: daysBetween(p.openDate, today),
      stopLoss: Number.isFinite(plan.stopLoss) ? plan.stopLoss : null,
      target1: t1,
      note: describeHold(p, price, t1),
      nextAction: nextActionOf(p, price),
    });
  }
  rows.sort((a, b) => b.marketValue - a.marketValue);
  return rows;
}

/* ------------------------------------------------------------------ */
/* 历史结算 / 补记                                                      */
/* ------------------------------------------------------------------ */

async function closeOf(code, date, cache) {
  if (!cache.has(code)) {
    const k = await em.kline(code, { limit: 80 }).catch(() => null);
    cache.set(code, (k && k.bars) || []);
  }
  const bars = cache.get(code);
  let hit = null;
  for (const b of bars) if (b.date <= date) hit = b;
  return hit ? hit.close : null;
}

/** 把过去未结算的交易日按"当日收盘价"定稿 */
async function finalizePast(state, today) {
  const pending = state.journal.filter((e) => !e.final && e.date < today);
  if (!pending.length) return;
  const cache = new Map();
  for (const entry of pending) {
    let marketValue = 0;
    for (const p of entry.positions || []) {
      const close = await closeOf(p.code, entry.date, cache);
      if (Number.isFinite(close)) p.last = round(close, 2);
      const last = Number.isFinite(p.last) ? p.last : p.cost;
      p.marketValue = round(last * p.shares, 2);
      p.floatPnl = round(p.marketValue - p.cost * p.shares, 2);
      p.floatPnlPct = p.cost ? round(((last - p.cost) / p.cost) * 100, 2) : 0;
      marketValue += p.marketValue;
    }
    entry.marketValue = round(marketValue, 2);
    entry.totalAssets = round((entry.cash || 0) + marketValue, 2);
    // 盘前按上一交易日收盘价预演过的记录，收盘结算时补一句说明，避免事后看不懂成交价
    if (entry.provisional && entry.priceSource === 'prevClose') {
      entry.notes = [
        ...(entry.notes || []),
        '这条记录是盘前按上一交易日收盘价预演的，收盘后已按当日收盘价结算估值；成交价保持预演当刻的价格不变。',
      ];
      entry.highlights = entry.notes;
      entry.priceSourceText = '盘前预演（上一交易日收盘价），收盘后已结算';
    }
    entry.provisional = false;
    entry.final = true;
    entry.settled = true;
  }
}

/** 中间漏掉的交易日：按当日收盘价补记（不做新决策，只持有/估值） */
async function backfillGaps(state, today) {
  if (!state.journal.length) return;
  const last = state.journal[state.journal.length - 1].date;
  if (!last || last >= today) return;

  const cal = await em.indexKline('000001', { limit: 120 }).catch(() => null);
  const dates = ((cal && cal.bars) || [])
    .map((b) => b.date)
    .filter((d) => d > last && d < today);
  if (!dates.length) return;

  const cache = new Map();
  for (const date of dates.slice(-BACKFILL_LIMIT)) {
    const prevTrades = collectTrades(state, (d) => d < date);
    const acc = replay(state.initialCapital, prevTrades);
    let marketValue = 0;
    const positions = [];
    for (const p of acc.positions.values()) {
      const close = await closeOf(p.code, date, cache);
      const last = Number.isFinite(close) ? round(close, 2) : round(p.cost, 2);
      const value = round(last * p.shares, 2);
      marketValue += value;
      positions.push({
        code: p.code,
        name: p.name,
        shares: p.shares,
        cost: round(p.cost, 2),
        last,
        changePct: null,
        marketValue: value,
        floatPnl: round(value - p.cost * p.shares, 2),
        floatPnlPct: p.cost ? round(((last - p.cost) / p.cost) * 100, 2) : 0,
        category: p.category,
        openDate: p.openDate,
        heldDays: daysBetween(p.openDate, date),
        stopLoss: p.plan && Number.isFinite(p.plan.stopLoss) ? p.plan.stopLoss : null,
        target1: p.plan && p.plan.targets && p.plan.targets[0] ? p.plan.targets[0].price : null,
        note: '补记：按当日收盘价估值',
        nextAction: nextActionOf(p),
      });
    }
    state.journal.push({
      date,
      weekday: weekdayName(date),
      trading: true,
      status: positions.length ? '持有' : '空仓',
      priceSource: 'close',
      trades: [],
      positions,
      cash: round(acc.cash, 2),
      marketValue: round(marketValue, 2),
      totalAssets: round(acc.cash + marketValue, 2),
      backfilled: true,
      final: true,
      settled: true,
      summary: positions.length
        ? '补记：当日未运行程序，持仓按收盘价估值，未做买卖。'
        : '补记：当日空仓，现金无变化。',
      notes: [
        positions.length
          ? '这天没有打开程序，所以没有任何买卖，持仓按当日收盘价估值，账户金额保持不变。'
          : '这天没有打开程序，账户空仓，现金和净值都没有变化。',
      ],
      highlights: [],
      at: Date.now(),
    });
  }
  state.journal.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/* ------------------------------------------------------------------ */
/* 派生统计（保证日与日之间连得上）                                      */
/* ------------------------------------------------------------------ */

function recomputeSeries(state) {
  state.journal.sort((a, b) => (a.date < b.date ? -1 : 1));
  let prev = state.initialCapital;
  let peak = state.initialCapital;
  let days = 0;
  let tradeDays = 0;

  for (const entry of state.journal) {
    days += 1;
    if (entry.trading) tradeDays += 1;
    entry.dayIndex = days;
    entry.tradeDayIndex = tradeDays;
    entry.totalAssets = round(Number(entry.totalAssets) || 0, 2);
    entry.marketValue = round(Number(entry.marketValue) || 0, 2);
    entry.cash = round(Number(entry.cash) || 0, 2);
    entry.dayPnl = round(entry.totalAssets - prev, 2);
    entry.dayPnlPct = prev ? round(((entry.totalAssets - prev) / prev) * 100, 2) : 0;
    entry.cumPnl = round(entry.totalAssets - state.initialCapital, 2);
    entry.cumPnlPct = round((entry.cumPnl / state.initialCapital) * 100, 2);
    entry.nav = round(entry.totalAssets / state.initialCapital, 4);
    peak = Math.max(peak, entry.totalAssets);
    entry.peakNav = round(peak / state.initialCapital, 4);
    entry.drawdownPct = round(((entry.totalAssets - peak) / peak) * 100, 2);
    entry.positionRatio = entry.totalAssets
      ? round((entry.marketValue / entry.totalAssets) * 100, 1)
      : 0;
    for (const t of entry.trades || []) {
      t.feePct = t.amount ? round((t.fee / t.amount) * 100, 3) : 0;
    }
    prev = entry.totalAssets;
  }
  state.stats = {
    days,
    tradeDays,
    totalAssets: prev,
    cumPnl: round(prev - state.initialCapital, 2),
    cumPnlPct: round(((prev - state.initialCapital) / state.initialCapital) * 100, 2),
  };
}

/* ------------------------------------------------------------------ */
/* 每天一条记录                                                        */
/* ------------------------------------------------------------------ */

/**
 * 当日候选池快照：把"为什么买 / 为什么没买"一起记下来。
 * 只取合并推荐的前 10 只，够解释决策就行，不占用太多空间。
 */
function candidateRows(acc, quotes, picks, tradedCodes) {
  const rows = [];
  const held = new Set([...acc.positions.keys()]);
  for (const item of (picks && picks.top) || []) {
    if (rows.length >= 10) break;
    const q = quotes.get(item.code) || {};
    const price = Number.isFinite(q.price) ? q.price : item.price;
    const changePct = Number.isFinite(q.changePct) ? q.changePct : item.changePct;
    const score = Number.isFinite(item.score) ? item.score : 0;
    const zone = (item.plan && item.plan.buyZone) || null;

    let status = '观望';
    let note = '';
    if (tradedCodes.has(item.code)) status = '已买入';
    else if (held.has(item.code)) status = '已持有';
    else if (!Number.isFinite(price)) status = '无行情';
    else if (!zone || !Number.isFinite(zone.low) || !Number.isFinite(zone.high)) status = '无计划';
    else if (Number.isFinite(changePct) && changePct >= 9.8) {
      status = '涨停不追';
      note = '已经封板，买不进也不追';
    } else if (Number.isFinite(changePct) && changePct <= -9.8) {
      status = '跌停不接';
      note = '跌停中，不接飞刀';
    } else if (score < MIN_SCORE) {
      status = '评分不足';
      note = `评分 ${round(score, 1)} 低于入选线 ${MIN_SCORE}`;
    } else if (price > zone.high * BUY_TOL_UP) {
      status = '高于买区';
      note = `高于买区上限 ${round((price / zone.high - 1) * 100, 1)}%，等回踩再买`;
    } else if (price < zone.low * BUY_TOL_DOWN) {
      status = '跌破买区';
      note = '已跌破买区下沿，形态走坏，放弃';
    } else {
      status = '在买区内';
      note = '价格在买区里，但现金或仓位已排满，留到下一个交易日';
    }

    rows.push({
      code: item.code,
      name: item.name,
      category: item.category || null,
      categoryName: item.categoryName || '',
      score: round(score, 1),
      price: Number.isFinite(price) ? round(price, 2) : null,
      changePct: Number.isFinite(changePct) ? round(changePct, 2) : null,
      zone: zone ? `${round(zone.low, 2)}-${round(zone.high, 2)}` : null,
      status,
      note,
    });
  }
  return rows;
}

/** 把一天写成一段可读的"操盘记录"：一句话结论 + 几条要点 */
function describeEntry(entry) {
  const buys = entry.trades.filter((t) => t.side === 'buy');
  const sells = entry.trades.filter((t) => t.side === 'sell');
  const names = (list) => list.map((t) => t.name || t.code).join('、');
  const money = (v) => (Number.isFinite(v) ? v.toFixed(2) : '-');
  const sign = (v) => `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(2)}`;
  const candidates = entry.candidates || [];

  if (!entry.trading) {
    entry.status = '休市';
    entry.summary = `${entry.reason || '今日休市'}，我不做任何操作，持仓按最近收盘价估值。`;
  } else if (buys.length && !sells.length) {
    entry.status = entry.positions.length === buys.length ? '建仓' : '加仓';
    entry.summary = `买入 ${names(buys)}，共 ${buys.length} 笔，动用 ${money(
      buys.reduce((s, t) => s + t.net, 0),
    )} 元（含费用），仓位升到 ${entry.positionRatio}%。`;
  } else if (sells.length && !buys.length) {
    entry.status = '减仓';
    entry.summary = `卖出 ${names(sells)}，共 ${sells.length} 笔，回收 ${money(
      sells.reduce((s, t) => s + t.net, 0),
    )} 元，仓位降到 ${entry.positionRatio}%。`;
  } else if (sells.length && buys.length) {
    entry.status = '调仓';
    entry.summary = `卖出 ${names(sells)}，换入 ${names(buys)}，完成一次调仓，仓位 ${entry.positionRatio}%。`;
  } else if (entry.positions.length) {
    entry.status = '持有';
    entry.summary = `今天没有动仓位，继续持有 ${entry.positions.length} 只（${entry.positions
      .map((p) => p.name)
      .join('、')}），止损和目标价都没触发。`;
  } else {
    entry.status = '空仓';
    const first = candidates.find((c) => c.status === '高于买区') || candidates[0];
    entry.summary = first
      ? `今天保持空仓。最想买的 ${first.name}（评分 ${first.score}）现价 ${
          first.price === null ? '-' : first.price
        } 还没跌进买入区间 ${first.zone || '-'}，我继续等。`
      : '今天保持空仓：候选标的现价都不在买入区间里，等更好的价格再出手。';
  }

  const notes = [];
  notes.push(
    `账户：总资产 ${money(entry.totalAssets)} 元 ＝ 现金 ${money(entry.cash)} + 持仓市值 ${money(
      entry.marketValue,
    )}，仓位 ${entry.positionRatio}%。`,
  );
  notes.push(
    `当日盈亏 ${sign(entry.dayPnl)} 元（${sign(entry.dayPnlPct)}%），累计 ${sign(entry.cumPnl)} 元（${sign(
      entry.cumPnlPct,
    )}%），净值 ${entry.nav}，最大回撤 ${entry.drawdownPct}%。`,
  );
  if (entry.index && Number.isFinite(entry.index.price)) {
    const idxUp = Number(entry.index.changePct) >= 0;
    notes.push(
      `大盘：${entry.index.name} ${entry.index.price}（${sign(entry.index.changePct)}%），${
        idxUp ? '指数偏强，但我按计划价买卖，不追高。' : '指数偏弱，我更看重止损纪律。'
      }`,
    );
  }
  for (const t of buys) {
    notes.push(
      `买入 ${t.name}（${t.code}）${t.shares} 股 @ ${t.price} 元，成交 ${money(t.amount)} 元，费用 ${money(
        t.fee,
      )} 元。理由：${t.reason}`,
    );
  }
  for (const t of sells) {
    notes.push(
      `卖出 ${t.name}（${t.code}）${t.shares} 股 @ ${t.price} 元，成交 ${money(t.amount)} 元，费用 ${money(
        t.fee,
      )} 元。理由：${t.reason}`,
    );
  }
  if (entry.positions.length) {
    notes.push(
      `持仓跟踪：${entry.positions
        .map(
          (p) =>
            `${p.name} ${p.floatPnlPct >= 0 ? '+' : ''}${p.floatPnlPct}%（成本 ${p.cost}／现价 ${p.last}，下一步 ${
              p.nextAction || p.note || '按计划持有'
            }）`,
        )
        .join('；')}`,
    );
  } else if (entry.trading) {
    notes.push('当前空仓，10 万本金全部是现金，等符合买点的机会出现。');
  }
  if (!buys.length && entry.trading && candidates.length) {
    notes.push(
      `候选池观察：${candidates
        .slice(0, 3)
        .map(
          (c) =>
            `${c.name} 现价 ${c.price === null ? '-' : c.price}／买区 ${c.zone || '-'}／${c.status}${
              c.note ? `（${c.note}）` : ''
            }`,
        )
        .join('；')}`,
    );
  }
  entry.notes = notes;
  entry.highlights = notes;
  return entry;
}

async function buildToday(state, session, picks, existing) {
  const today = session.date;
  const prevTrades = collectTrades(state, (d) => d < today);
  const prevAcc = replay(state.initialCapital, prevTrades);
  let trades;
  let quotes = null;

  if (existing && !existing.provisional) {
    // 当日成交已经锁定，只做估值更新，避免盘中价格波动把成交价改来改去
    trades = existing.trades || [];
  } else if (!session.trading) {
    trades = [];
  } else {
    const codes = new Set();
    for (const p of prevAcc.positions.values()) codes.add(p.code);
    for (const item of (picks && picks.top) || []) codes.add(item.code);
    quotes = await em.quotesBatch([...codes]).catch(() => new Map());

    const sellTrades = decideSells(prevAcc, quotes, today, session);
    const midAcc = replay(state.initialCapital, [...prevTrades, ...sellTrades]);
    const buyTrades = decideBuys(midAcc, quotes, picks, today, session);
    trades = [...sellTrades, ...buyTrades];
  }

  const acc = replay(state.initialCapital, [...prevTrades, ...trades]);
  const codes = new Set([...acc.positions.keys()]);
  for (const t of trades) codes.add(t.code);
  // 候选股也要取快照，才能把"今天为什么没买它"写进记录里
  if (session.trading) {
    for (const item of (picks && picks.top) || []) if (item && item.code) codes.add(item.code);
  }
  if (!quotes) quotes = await em.quotesBatch([...codes]).catch(() => new Map());
  else {
    const missing = [...codes].filter((c) => !quotes.has(c));
    if (missing.length) {
      const more = await em.quotesBatch(missing).catch(() => new Map());
      for (const [k, v] of more) quotes.set(k, v);
    }
  }

  const positions = markPositions(acc, quotes, today);
  const marketValue = round(
    positions.reduce((s, p) => s + p.marketValue, 0),
    2,
  );
  const tradedCodes = new Set(trades.filter((t) => t.side === 'buy').map((t) => t.code));
  const candidates = session.trading ? candidateRows(acc, quotes, picks, tradedCodes) : [];

  return {
    date: today,
    weekday: session.weekday,
    trading: !!session.trading,
    reason: session.reason || null,
    priceSource: session.priceSource,
    priceSourceText: PRICE_SOURCE_TEXT[session.priceSource],
    provisional: session.priceSource === 'prevClose',
    trades,
    positions,
    candidates,
    cash: round(acc.cash, 2),
    marketValue,
    totalAssets: round(acc.cash + marketValue, 2),
    index: session.clock && session.clock.index ? session.clock.index : null,
    final: !session.trading,
    at: Date.now(),
  };
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

const RULES = [
  '起始本金 100,000 元，只做沪深主板（600/601/603/605/000/001/002/003），不做科创板、创业板、北交所。',
  '只用自有资金做多：不融资、不加杠杆、不做空，不碰 ST 与退市风险股。',
  'T+1：当日买入的次日才能卖出（程序只用"昨日之前的持仓"做卖出判断）。',
  '卖出回笼的资金当天就可以用来买新的标的，但卖出的股票本身要下一交易日才能再买回。',
  '100 股/手：买入必须是 100 股的整数倍，卖出不超过持仓。',
  '涨停（+10%）不追、买不进；跌停不卖，等下一个交易日。',
  '费用：佣金万分之2.5（单笔最低 5 元）、卖出印花税 0.05%、过户费 0.001%（双边），成本价含费用。',
  '仓位：单只按选股引擎给出的建议仓位（5%~30%），最多同时持有 5 只，其余留现金。',
  '卖出纪律：跌破止损清仓 / 到第一目标减半 / 到第二目标清仓 / 持有到期换股。',
  '成交价：盘中用实时价，收盘后用当日收盘价；盘前用上一交易日收盘价，开盘后自动重算。',
  '每个自然日只记一条，运行应用就自动续写；过去的日子按当日收盘价结算一次后冻结不再变动。',
  '每一笔成交都留痕（价格、股数、金额、费用、买卖理由），账户由成交流水重放得出，账实永远对得上。',
];

function buildPayload(state, session) {
  const journal = state.journal.slice().sort((a, b) => (a.date < b.date ? 1 : -1));
  const latest = state.journal[state.journal.length - 1] || null;
  const allTrades = [];
  for (const e of state.journal) for (const t of e.trades || []) allTrades.push(t);
  allTrades.reverse();

  const unrealized = latest ? round(latest.positions.reduce((s, p) => s + (p.floatPnl || 0), 0), 2) : 0;

  return {
    profile: {
      initialCapital: state.initialCapital,
      startDate: state.startDate,
      currency: 'CNY',
      maxPositions: MAX_POSITIONS,
      lot: LOT,
      minScore: MIN_SCORE,
      fees: {
        commission: '万分之2.5（最低 5 元）',
        stampDuty: '0.05%（仅卖出）',
        transfer: '0.001%（双边）',
      },
    },
    account: latest
      ? {
          date: latest.date,
          cash: latest.cash,
          marketValue: latest.marketValue,
          totalAssets: latest.totalAssets,
          positionRatio: latest.positionRatio,
          dayPnl: latest.dayPnl,
          dayPnlPct: latest.dayPnlPct,
          cumPnl: latest.cumPnl,
          cumPnlPct: latest.cumPnlPct,
          nav: latest.nav,
          peakNav: latest.peakNav,
          drawdownPct: latest.drawdownPct,
          unrealizedPnl: unrealized,
          realizedPnl: round(latest.cumPnl - unrealized, 2),
          tradeDays: latest.tradeDayIndex,
          days: latest.dayIndex,
        }
      : null,
    session,
    today: latest,
    holdings: latest ? latest.positions : [],
    journal,
    trades: allTrades,
    equity: state.journal.map((e) => ({ date: e.date, nav: e.nav, totalAssets: e.totalAssets })),
    rules: RULES,
    at: Date.now(),
  };
}

/**
 * 跑一遍每日流程：结算历史 -> 补记漏掉的交易日 -> 生成/更新今天的记录。
 * picks 由调用方传入（服务端已有缓存），避免重复触发全市场抓取。
 */
async function run({ picks = null, force = false } = {}) {
  const now = Date.now();
  const today = dateStr(now);
  const state = loadState() || emptyState();
  if (!state.startDate) {
    state.startDate = today;
    state.createdAt = now;
  }

  const clock = await em.marketClock().catch(() => null);
  const session = resolveSession(now, clock);
  const existing = state.journal.find((e) => e.date === today);
  if (!force && existing && existing.final) {
    recomputeSeries(state);
    return buildPayload(state, session);
  }

  await finalizePast(state, today);
  await backfillGaps(state, today);

  const entry = await buildToday(state, session, picks, existing);
  const next = state.journal.filter((e) => e.date !== today);
  next.push(entry);
  state.journal = next;
  // 先算净值 / 回撤 / 仓位这些派生指标，再据它们写当天的操盘记录
  recomputeSeries(state);
  describeEntry(entry);
  state.lastRunAt = now;
  saveState(state);
  return buildPayload(state, session);
}

/** 重新开始（清空记录，回到 10 万本金） */
function reset() {
  const now = Date.now();
  const state = emptyState();
  state.startDate = dateStr(now);
  state.createdAt = now;
  saveState(state);
  return { ok: true, startDate: state.startDate };
}

module.exports = {
  run,
  reset,
  loadState,
  saveState,
  replay,
  RULES,
  INITIAL_CAPITAL,
  FEE,
  buyFee,
  sellFee,
  dateStr,
  resolveSession,
};
