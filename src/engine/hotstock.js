'use strict';

/**
 * 热门票：把「今天全市场最热的主板个股」单独挑出来。
 *
 * 和短线推荐（龙虎榜）是互补的两个视角：
 *   - 龙虎榜看的是「谁被资金选中了」（有席位、有历史胜率）；
 *   - 热门票看的是「眼球和钱现在聚在哪里」（成交额、换手、量比、强度、主力资金）。
 *
 * 热度分五个因子，各自 0~100 分，再按权重合成：
 *   amount   成交额 —— 最直接的热度代理，按全市场分位给分
 *   turnover 换手率 —— 太冷没人玩、太高多半是分歧出货，12% 上下最热
 *   volume   量比   —— 相对自己平时的量放大了多少
 *   strength 当日强度 —— 涨得越强越热，涨停单列，跳水票压到低分
 *   money    主力资金 —— 主力净流入占比越高越热，净流出扣分
 *
 * 注意：热 ≠ 能买。这个榜只回答"现在钱和眼球在哪"，
 * 真要下单还是回到短线推荐（龙虎榜 + 席位）去看筹码和谁在买。
 */

const { isST, isMainBoard } = require('./shortterm');

const DEFAULT_HEAT_WEIGHTS = { amount: 0.3, money: 0.25, strength: 0.2, turnover: 0.15, volume: 0.1 };

function round(v, digits = 2) {
  if (!Number.isFinite(v)) return null;
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp(v, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, v));
}

function yi(v) {
  const n = num(v);
  if (n === null) return '-';
  if (Math.abs(n) >= 1e8) return `${round(n / 1e8)}亿`;
  if (Math.abs(n) >= 1e4) return `${round(n / 1e4, 0)}万`;
  return String(round(n, 0));
}

/** 在升序数组里找 <= v 的比例（全市场分位） */
function percentileOf(sorted, v) {
  if (!sorted.length || !Number.isFinite(v)) return 0;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo / sorted.length;
}

/* ------------------------------------------------------------------ */
/* 五个因子                                                            */
/* ------------------------------------------------------------------ */

/**
 * 成交额绝对值分档（元）：成交额是"钱有没有来"的硬指标，
 * 必须有一个绝对锚，否则清淡的交易日里"矮子里的高个"也能拿满分。
 */
const AMOUNT_STEPS = [
  [1e7, 18],    // 1000 万
  [3e7, 30],    // 3000 万
  [1e8, 45],    // 1 亿
  [3e8, 58],    // 3 亿
  [1e9, 72],    // 10 亿
  [3e9, 86],    // 30 亿
  [1e10, 96],   // 100 亿
  [3e10, 100],
];

/** 在 log10 轴上做分段线性插值 */
function logRamp(steps, v) {
  if (!Number.isFinite(v) || v <= 0) return steps[0][1];
  const x = Math.log10(v);
  if (x <= Math.log10(steps[0][0])) return steps[0][1];
  for (let i = 1; i < steps.length; i += 1) {
    const [v1, s1] = steps[i - 1];
    const [v0, s0] = steps[i];
    const x0 = Math.log10(v0);
    if (x <= x0) {
      const x1 = Math.log10(v1);
      const t = (x - x1) / (x0 - x1);
      return s1 + (s0 - s1) * t;
    }
  }
  return steps[steps.length - 1][1];
}

/**
 * 成交额 = 绝对分档 × 全市场分位的小幅加成。
 * 只用分位会让"前十名"挤在一起，只看绝对值又体现不出"今天谁更突出"，
 * 所以以绝对值为主（0.85 起步），排得越靠前最多加成 30%。
 */
function amountScore(amount, pct) {
  if (!Number.isFinite(amount) || amount <= 0) return 20;
  const base = logRamp(AMOUNT_STEPS, amount);
  const boost = 0.85 + 0.3 * Math.max(0, Math.min(1, pct));
  return clamp(base * boost);
}

/** 换手率：以 12% 为中心的钟形，两头都低 */
function turnoverScore(t) {
  if (!Number.isFinite(t) || t <= 0) return 10;
  const sigma = 0.95;
  const d = Math.log(t) - Math.log(12);
  return clamp(25 + 75 * Math.exp(-(d * d) / (2 * sigma * sigma)));
}

function volumeScore(r) {
  if (!Number.isFinite(r) || r <= 0) return 45; // 拿不到量比时按中性偏低算
  if (r >= 3) return 95;
  if (r >= 2) return 88;
  if (r >= 1.5) return 78;
  if (r >= 1) return 62;
  if (r >= 0.7) return 45;
  return 28;
}

function strengthScore(chg) {
  if (!Number.isFinite(chg)) return 45;
  if (chg >= 9.8) return 95;
  if (chg >= 7) return 86;
  if (chg >= 5) return 78;
  if (chg >= 2) return 66;
  if (chg >= 0) return 54;
  if (chg >= -2) return 42;
  if (chg >= -5) return 30;
  return 16;
}

/** 主力资金：优先用净流入占比（f184），拿不到再退回净额（f62） */
function moneyScore(row) {
  const pct = num(row.mainNetInPct);
  if (pct !== null) {
    if (pct >= 12) return 96;
    if (pct >= 8) return 88;
    if (pct >= 5) return 80;
    if (pct >= 2) return 70;
    if (pct >= 0) return 58;
    if (pct >= -3) return 44;
    if (pct >= -8) return 28;
    return 14;
  }
  const net = num(row.mainNetIn);
  if (net === null) return 50;
  if (net >= 3e8) return 90;
  if (net >= 1e8) return 80;
  if (net >= 3e7) return 68;
  if (net >= 0) return 56;
  if (net >= -5e7) return 40;
  return 22;
}

/* ------------------------------------------------------------------ */
/* 打分                                                                */
/* ------------------------------------------------------------------ */

function verdictOf(score) {
  // 门槛是按真实盘面调的：能进这个榜的本来就是全市场最热的一批，
  // 卡太松会变成十几行全是"人气最旺"，反而看不出差别
  if (score >= 92) return '人气最旺';
  if (score >= 85) return '热度靠前';
  if (score >= 70) return '温度一般';
  return '只是有点量';
}

/** 单只票的热度分：五个因子 + 人话版理由 / 风险 / 标签 */
function heatOf(row, { amounts = [], lhbCodes, boardLeaders } = {}) {
  const code = String(row.code || '');
  const name = String(row.name || '');
  const amount = num(row.amount);
  const turnoverRate = num(row.turnoverRate);
  const volumeRatio = num(row.volumeRatio);
  const changePct = num(row.changePct);
  const net = num(row.mainNetIn);
  const netPct = num(row.mainNetInPct);

  const reasons = [];
  const risks = [];
  const tags = [];
  const marks = []; // 最关键的身份标记，排在标签最前面，避免被截断

  /* 成交额 */
  const pct = amount === null ? 0 : percentileOf(amounts, amount);
  const amountPart = amount === null ? 40 : amountScore(amount, pct);
  if (amount !== null) {
    const topPct = (1 - pct) * 100;
    const topLabel = topPct <= 0.1 ? '<0.1' : topPct < 1 ? topPct.toFixed(1) : String(Math.round(topPct));
    if (amount >= 2e9) {
      reasons.push(`成交额 ${yi(amount)}，排在全市场前 ${topLabel}%，是今天资金真正聚集的地方`);
    } else if (amount >= 5e8) {
      reasons.push(`成交额 ${yi(amount)}，资金参与度不错（全市场前 ${topLabel}%）`);
    }
    tags.push(`成交额 ${yi(amount)}`);
  }

  /* 换手 */
  const turnoverPart = turnoverScore(turnoverRate);
  if (turnoverRate !== null) {
    tags.push(`换手 ${round(turnoverRate, 1)}%`);
    if (turnoverRate >= 5 && turnoverRate <= 20) {
      reasons.push(`换手 ${round(turnoverRate, 1)}%，交投活跃又不算失控`);
    } else if (turnoverRate > 35) {
      risks.push(`换手 ${round(turnoverRate, 1)}%，筹码换得太快，通常是高位分歧`);
    } else if (turnoverRate < 1) {
      risks.push('换手不到 1%，基本没人玩，热的是别处');
    }
  }

  /* 量比 */
  const volumePart = volumeScore(volumeRatio);
  if (volumeRatio !== null) {
    tags.push(`量比 ${round(volumeRatio, 2)}`);
    if (volumeRatio >= 2) reasons.push(`量比 ${round(volumeRatio, 2)}，相对平时明显放量`);
    if (volumeRatio >= 5) risks.push(`量比 ${round(volumeRatio, 2)}，一天放出几倍的量，接力要小心`);
  }

  /* 当日强度 */
  const strengthPart = strengthScore(changePct);
  if (changePct !== null) {
    if (changePct >= 9.8) {
      marks.push('涨停');
      reasons.push('今天涨停，是盘面上最强的那一档');
      risks.push('已涨停买不进，明天要考虑的是溢价还能不能给');
    } else if (changePct >= 5) {
      reasons.push(`今天涨 ${round(changePct, 2)}%，属于强势票`);
    } else if (changePct <= -9.8) {
      risks.push('今天跌停，别在这种票上抢反弹');
    } else if (changePct <= -5) {
      risks.push(`今天跌 ${round(Math.abs(changePct), 2)}%，是被砸的那一档，热的是卖盘`);
    }
  }

  /* 主力资金 */
  const moneyPart = moneyScore(row);
  if (net !== null) {
    if (net >= 5e7) {
      reasons.push(`主力净流入 ${yi(net)}${netPct !== null ? `（占成交额 ${round(netPct, 2)}%）` : ''}`);
      tags.push(`净流入 ${yi(net)}`);
    } else if (net <= -5e7) {
      risks.push(`主力净流出 ${yi(Math.abs(net))}，是资金在出，不是在进`);
      tags.push(`净流出 ${yi(Math.abs(net))}`);
    }
  }

  /* 外部标记：龙虎榜 / 板块龙头 */
  if (lhbCodes && lhbCodes.has(code)) {
    marks.push('近日上过龙虎榜');
    reasons.push('最近几个交易日上过龙虎榜，人气和资金都来过');
  }
  const boardName = boardLeaders && boardLeaders.get(code);
  if (boardName) {
    marks.push(`${boardName} 领涨`);
    reasons.push(`是热门概念「${boardName}」的领涨股`);
  }

  const parts = {
    amount: amountPart,
    turnover: turnoverPart,
    volume: volumePart,
    strength: strengthPart,
    money: moneyPart,
  };
  const score = combine(parts, DEFAULT_HEAT_WEIGHTS);

  return {
    code,
    name,
    price: num(row.price),
    changePct: round(changePct),
    amount,
    turnoverRate: round(turnoverRate),
    volumeRatio: round(volumeRatio),
    netBuy: net,
    netPct: round(netPct),
    floatCap: num(row.floatCap),
    change60Pct: num(row.change60Pct),
    score,
    verdict: verdictOf(score),
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v)])),
    reasons: reasons.slice(0, 4),
    risks: risks.slice(0, 3),
    tags: [...marks, ...tags].slice(0, 6),
  };
}

/** 按权重合成总分 */
function combine(parts, weights) {
  const w = { ...DEFAULT_HEAT_WEIGHTS, ...(weights || {}) };
  const total = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  let sum = 0;
  for (const k of Object.keys(w)) sum += (Number.isFinite(parts[k]) ? parts[k] : 50) * w[k];
  return Math.round(clamp(sum / total));
}

/**
 * 从全市场快照里挑出最热的主板票。
 * @param {Array} rows  em.marketSnapshot() 的 rows
 * @param {object} opts
 * @param {number} opts.limit        取前 N 只
 * @param {Set<string>} opts.lhbCodes 最近上过龙虎榜的代码（用来打标记）
 * @param {Map<string,string>} opts.boardLeaders 代码 -> 热门板块名（领涨股标记）
 */
function buildHotList(rows, { limit = 12, lhbCodes, boardLeaders } = {}) {
  const universe = [];
  for (const r of rows || []) {
    const code = String(r.code || '');
    if (!code || !isMainBoard(code) || isST(r.name)) continue;
    if (!Number.isFinite(r.amount) || r.amount <= 0) continue;
    if (!Number.isFinite(r.price) || r.price <= 0) continue;
    universe.push(r);
  }

  const amounts = universe.map((r) => r.amount).sort((a, b) => a - b);
  const scored = universe.map((r) => heatOf(r, { amounts, lhbCodes, boardLeaders }));
  scored.sort((a, b) => b.score - a.score || (b.amount || 0) - (a.amount || 0));

  return {
    list: scored.slice(0, limit).map((x, i) => ({ ...x, rank: i + 1 })),
    total: universe.length,
  };
}

/** 数最近连续涨停的天数（主板 10% 口径的近似判断） */
function limitUpStreak(bars) {
  if (!Array.isArray(bars) || bars.length < 2) return 0;
  let n = 0;
  for (let i = bars.length - 1; i >= 1; i -= 1) {
    const chg = num(bars[i].changePct);
    if (chg !== null && chg >= 9.7) n += 1;
    else break;
  }
  return n;
}

/**
 * 第二轮：补上日线位置信息（只有前 N 只才拉 K 线）。
 * 热度分不变——这是个热度榜，不是买入榜；日线只用来提示追高风险。
 */
function finalize(item, { tech, streak = 0 } = {}) {
  const reasons = [...(item.reasons || [])];
  const risks = [...(item.risks || [])];
  const tags = [...(item.tags || [])];

  if (streak >= 2) {
    tags.push(`${streak} 连板`);
    if (streak >= 3) risks.push(`已经 ${streak} 连板，位置很高，接力是纯博弈`);
  }

  const chg5 = tech && num(tech.chg5Pct);
  if (chg5 !== null && chg5 > 25) {
    risks.push(`近 5 个交易日已经涨了 ${round(chg5, 1)}%，热度是用涨幅堆出来的`);
  }
  if (tech && Number.isFinite(tech.position)) {
    if (tech.position >= 0.9) risks.push('处在近 60 日最高位附近，追高风险大');
    else if (tech.position <= 0.35) reasons.push(`处在近 60 日区间 ${Math.round(tech.position * 100)}% 的位置，热度还没换到高位`);
  }
  if (tech && Number.isFinite(tech.atrPct) && tech.atrPct > 8) {
    risks.push(`日均波动 ${round(tech.atrPct, 1)}%，仓位要压住`);
  }

  return {
    code: item.code,
    name: item.name,
    rank: item.rank,
    price: item.price,
    changePct: item.changePct,
    amount: item.amount,
    turnoverRate: item.turnoverRate,
    volumeRatio: item.volumeRatio,
    netBuy: item.netBuy,
    netPct: item.netPct,
    floatCap: item.floatCap,
    change60Pct: item.change60Pct,
    chg5Pct: chg5,
    position: tech && Number.isFinite(tech.position) ? tech.position : null,
    streak,
    score: item.score,
    verdict: item.verdict,
    parts: item.parts,
    tags: tags.slice(0, 6),
    reasons: reasons.slice(0, 4),
    risks: risks.slice(0, 3),
  };
}

module.exports = {
  DEFAULT_HEAT_WEIGHTS,
  buildHotList,
  heatOf,
  finalize,
  limitUpStreak,
  turnoverScore,
  volumeScore,
  strengthScore,
  moneyScore,
  verdictOf,
};
