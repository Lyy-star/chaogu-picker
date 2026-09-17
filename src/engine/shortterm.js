'use strict';

/**
 * 短线推荐引擎：以「龙虎榜 + 席位追踪」为核心的 3~10 个交易日视角。
 *
 * 全部基于公开数据做统计，不做预测：
 *   1. 候选 = 最近几个交易日登上龙虎榜的个股（剔除 ST、非主板）；
 *   2. 胜率 = 该股过去每次上榜后 5 日的涨跌（东方财富直接给 D1/D5/D10 收益），
 *      样本越多越可信，样本少的会明确标出来；
 *   3. 席位 = 买入席位里有多少活跃游资（近 3 个月上榜次数多）、
 *      这些席位的近 3 日上涨概率是多少，机构专用席位是买还是卖；
 *   4. 打分 = 历史胜率 35% + 席位质量 25% + 资金净买 20% + 技术位置 20%。
 */

const cfg = require('../config');

const F = {
  d1: 'D1_CLOSE_ADJCHRATE',
  d5: 'D5_CLOSE_ADJCHRATE',
  d10: 'D10_CLOSE_ADJCHRATE',
};

const DEFAULT_WEIGHTS = { win: 0.35, seat: 0.25, money: 0.2, tech: 0.2 };

function round(v, digits = 2) {
  if (!Number.isFinite(v)) return null;
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function isMainBoard(code) {
  const c = String(code || '');
  if (cfg.BOARD.excludePattern.test(c)) return false;
  return cfg.BOARD.mainBoardPattern.test(c);
}

function isST(name) {
  return /ST|退/.test(String(name || ''));
}

/** 'YYYY-MM-DD'，n 天前 */
function dayBefore(n, base = new Date()) {
  const d = new Date(base.getTime() - n * 24 * 3600 * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 个股历史胜率：把该股所有上榜记录里的 D1/D5/D10 收益拿来统计 */
function winRateOf(records) {
  const d5 = [];
  const d1 = [];
  const d10 = [];
  for (const r of records || []) {
    const v5 = num(r[F.d5]);
    if (v5 !== null) d5.push(v5);
    const v1 = num(r[F.d1]);
    if (v1 !== null) d1.push(v1);
    const v10 = num(r[F.d10]);
    if (v10 !== null) d10.push(v10);
  }

  return {
    samples: d5.length,
    winRate: d5.length ? round((d5.filter((x) => x > 0).length / d5.length) * 100, 1) : null,
    avgD5: round(mean(d5), 2),
    avgD1: round(mean(d1), 2),
    avgD10: round(mean(d10), 2),
    best: d5.length ? round(Math.max(...d5), 1) : null,
    worst: d5.length ? round(Math.min(...d5), 1) : null,
  };
}

/** 席位画像：从该股某一次上榜的买入席位里，看是谁在买 */
function seatProfile(seats) {
  // 同一只票当天可能有多条上榜原因，同一个席位会重复出现，这里按席位名合并
  const merged = new Map();
  for (const s of seats || []) {
    const name = String(s.OPERATEDEPT_NAME || '');
    if (!name) continue;
    const cur = merged.get(name) || {
      name,
      code: String(s.OPERATEDEPT_CODE || ''),
      buy: 0,
      net: 0,
      prob3: num(s.RISE_PROBABILITY_3DAY),
      times3m: num(s.TOTAL_BUYER_SALESTIMES_3DAY),
    };
    cur.buy += num(s.BUY) || 0;
    cur.net += num(s.NET) || 0;
    merged.set(name, cur);
  }
  const list = [...merged.values()];

  const isGt = (s) => s.name.includes('股通');
  const inst = list.filter((s) => s.name.includes('机构专用'));
  // 活跃游资：排除机构专用和北向（股通），近 3 个月买方上榜 ≥30 次
  const active = list.filter((s) => !s.name.includes('机构专用') && !isGt(s) && (s.times3m || 0) >= 30);
  const top = list
    .filter((s) => !s.name.includes('机构专用') && !isGt(s))
    .sort((a, b) => (b.prob3 || 0) - (a.prob3 || 0))
    .slice(0, 3);

  return {
    list,
    count: list.length,
    instCount: inst.length,
    instBuy: round(inst.reduce((a, b) => a + b.buy, 0), 0),
    gtCount: list.filter(isGt).length,
    activeCount: active.length,
    activeNames: active
      .sort((a, b) => (b.times3m || 0) - (a.times3m || 0))
      .slice(0, 3)
      .map((s) => s.name),
    topProb: top.length ? top[0].prob3 : null,
    topNames: top.map((s) => `${s.name}（近3日胜率 ${round(s.prob3, 1)}%）`),
  };
}

/** 技术位置因子（只有拿到日线才算得出来） */
function techFactor(tech) {
  const reasons = [];
  const risks = [];
  if (!tech) return { score: 50, reasons, risks };

  let s = 50;
  if (Number.isFinite(tech.ma5) && Number.isFinite(tech.ma10)) {
    if (tech.price > tech.ma5 && tech.ma5 > tech.ma10) {
      s += 12;
      reasons.push('现价在 5 日线上方、且 5 日线在 10 日线上方，短线是强势结构');
    } else if (tech.price < tech.ma10) {
      s -= 15;
      risks.push('已经跌破 10 日线，短线结构转弱');
    }
  }
  if (Number.isFinite(tech.position)) {
    if (tech.position >= 0.9) {
      s -= 15;
      risks.push('处在近 60 日最高位附近，追高风险大');
    } else if (tech.position <= 0.35) {
      s += 10;
      reasons.push(`处在近 60 日区间 ${Math.round(tech.position * 100)}% 的位置，算相对低位`);
    }
  }
  if (Number.isFinite(tech.chg5Pct) && tech.chg5Pct > 25) {
    s -= 15;
    risks.push(`近 5 个交易日已经涨了 ${tech.chg5Pct}%，再进就是接力`);
  }
  if (Number.isFinite(tech.atrPct) && tech.atrPct > 8) {
    risks.push(`日均波动 ${tech.atrPct}%，题材票波动大，仓位要压住`);
  }
  return { score: clamp100(s), reasons, risks };
}

function verdictOf(score) {
  if (score >= 78) return '重点关注';
  if (score >= 66) return '可低吸';
  if (score >= 52) return '观察';
  return '回避';
}

/** 第一轮：不用 K 线，直接出分（用来给候选排序） */
function scoreBase(row, ctx = {}) {
  const { parts, reasons, risks } = factorScores(row, ctx);
  // 记住"原始权重"：第二轮补上技术因子时要用它重算，
  // 否则第一轮把技术权重分给别的因子后，技术好坏就不影响结果了
  const weights = { ...DEFAULT_WEIGHTS, ...(ctx.weights || {}) };
  const combined = combineParts(parts, weights);
  return {
    score: combined.score,
    parts,
    weights,
    verdict: verdictOf(combined.score),
    reasons,
    risks,
  };
}

/** 第二轮：补上技术位置因子，重算总分 */
function scoreFinal(base, { tech } = {}) {
  const f = techFactor(tech);
  const combined = combineParts({ ...base.parts, tech: f.score }, base.weights);
  return {
    score: combined.score,
    verdict: verdictOf(combined.score),
    reasons: [...base.reasons, ...f.reasons].slice(0, 6),
    risks: [...base.risks, ...f.risks].slice(0, 3),
  };
}

/**
 * 组织一次短线候选：
 * @param {object} p
 * @param {Array} p.boardRows   近几日的龙虎榜详情（每只票取最近一次上榜）
 * @param {Array} p.seatRows    近几日的买入席位
 * @param {Array} p.sellRows    近几日的卖出席位
 * @param {Array} p.historyRows 近几个月的历史龙虎榜（算个股胜率）
 * @param {number} p.maxCandidates 进入第二轮（要拉 K 线）的只数
 */
function buildCandidates({ boardRows, seatRows, sellRows, historyRows, maxCandidates = 12, weights }) {
  const latest = new Map();
  for (const r of boardRows || []) {
    const code = String(r.SECURITY_CODE || '');
    if (!code) continue;
    const date = String(r.TRADE_DATE || '').slice(0, 10);
    const cur = latest.get(code);
    if (!cur || date > cur.date) latest.set(code, { date, row: r });
  }

  const history = new Map();
  for (const r of historyRows || []) {
    const code = String(r.SECURITY_CODE || '');
    if (!history.has(code)) history.set(code, []);
    history.get(code).push(r);
  }

  const groupBy = (rows) => {
    const m = new Map();
    for (const s of rows || []) {
      const key = `${s.SECURITY_CODE}|${String(s.TRADE_DATE || '').slice(0, 10)}`;
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(s);
    }
    return m;
  };
  const seatMap = groupBy(seatRows);
  const sellMap = groupBy(sellRows);

  const out = [];
  for (const [code, { row, date }] of latest) {
    const name = String(row.SECURITY_NAME_ABBR || '');
    if (!isMainBoard(code) || isST(name)) continue;

    const winRate = winRateOf(history.get(code) || []);
    const seat = seatProfile(seatMap.get(`${code}|${date}`) || []);
    const sellSeat = seatProfile(sellMap.get(`${code}|${date}`) || []);
    const base = scoreBase(row, { winRate, seat, sellSeat, weights });

    out.push({
      code,
      name,
      date,
      price: num(row.CLOSE_PRICE),
      changePct: num(row.CHANGE_RATE),
      turnoverRate: num(row.TURNOVERRATE),
      amount: num(row.ACCUM_AMOUNT),
      floatCap: num(row.FREE_MARKET_CAP),
      dealRatio: num(row.DEAL_AMOUNT_RATIO),
      netBuy: num(row.BILLBOARD_NET_AMT),
      explain: String(row.EXPLAIN || ''),
      explanation: String(row.EXPLANATION || ''),
      winRate,
      seat,
      base,
    });
  }

  out.sort((a, b) => b.base.score - a.base.score);
  return { list: out.slice(0, maxCandidates), total: out.length };
}

/** 近几日最活跃的买方席位（游资追踪） */
function hotSeats(seatRows, { days = 5, limit = 10, base = new Date() } = {}) {
  const cutoff = dayBefore(days, base);
  const agg = new Map();
  for (const s of seatRows || []) {
    const date = String(s.TRADE_DATE || '').slice(0, 10);
    if (date < cutoff) continue;
    const name = String(s.OPERATEDEPT_NAME || '');
    if (!name || name.includes('机构专用') || name.includes('股通')) continue;
    const cur = agg.get(name) || { name, times: 0, buy: 0, stocks: new Set(), probs: [] };
    cur.times += 1;
    cur.buy += num(s.BUY) || 0;
    if (s.SECURITY_CODE) cur.stocks.add(`${s.SECURITY_NAME_ABBR || ''}(${s.SECURITY_CODE})`);
    const p = num(s.RISE_PROBABILITY_3DAY);
    if (p !== null) cur.probs.push(p);
    agg.set(name, cur);
  }

  return [...agg.values()]
    .filter((x) => x.times >= 2 && Number.isFinite(mean(x.probs)))
    .map((x) => ({
      name: x.name,
      times: x.times,
      buy: round(x.buy, 0),
      prob3: round(mean(x.probs), 1),
      stocks: [...x.stocks].slice(0, 4),
    }))
    .sort((a, b) => b.times - a.times || (b.prob3 || 0) - (a.prob3 || 0))
    .slice(0, limit);
}

module.exports = {
  DEFAULT_WEIGHTS,
  buildCandidates,
  hotSeats,
  winRateOf,
  seatProfile,
  scoreBase,
  scoreFinal,
  dayBefore,
  isMainBoard,
  isST,
};

function clamp100(v) {
  return Math.max(0, Math.min(100, v));
}

/**
 * 四个因子各自打 0-100 分。
 * 分因子打分（而不是直接加减总分）是为了让权重真正生效：
 * 复盘之后调整权重，推荐结果就会跟着变。
 */
function factorScores(row, { winRate, seat, sellSeat }) {
  const reasons = [];
  const risks = [];

  /* 资金面 */
  let money = 50;
  const net = num(row.BILLBOARD_NET_AMT) || 0;
  const ratio = num(row.DEAL_NET_RATIO);
  if (net >= 2e8) {
    money += 22;
    reasons.push(`龙虎榜净买入 ${round(net / 1e8)} 亿元，资金介入很深`);
  } else if (net >= 5e7) {
    money += 12;
    reasons.push(`龙虎榜净买入约 ${round(net / 1e8)} 亿元，有资金在做`);
  } else if (net > 0) {
    money += 4;
  } else if (net <= -5e7) {
    money -= 28;
    risks.push(`龙虎榜净卖出约 ${round(Math.abs(net) / 1e8)} 亿元，是资金在出，不是在进`);
  } else {
    money -= 10;
  }
  if (ratio !== null) {
    if (ratio >= 10) {
      money += 12;
      reasons.push(`净买入占成交额 ${round(ratio)}%，当天是主动买上去的`);
    } else if (ratio >= 5) {
      money += 6;
      reasons.push(`净买入占成交额 ${round(ratio)}%`);
    }
  }

  /* 席位 */
  let seatScore = 45;
  if (seat && seat.count) {
    if (seat.instCount >= 2) {
      seatScore += 12;
      reasons.push(`买方有 ${seat.instCount} 个机构专用席位，机构在参与`);
    }
    if (seat.activeCount > 0) {
      seatScore += Math.min(25, 10 + seat.activeCount * 4);
      reasons.push(
        `买方有 ${seat.activeCount} 个近三个月活跃席位（${(seat.activeNames || []).join('、')}），一线游资在动手`,
      );
    }
    if (seat.topProb !== null && seat.topProb >= 55) {
      seatScore += 8;
      reasons.push(`买方最强席位近 3 日上涨概率 ${round(seat.topProb, 1)}%，历史手感不错`);
    }
    if (!seat.instCount && !seat.activeCount) {
      risks.push('买方席位比较普通，没有明显的一线游资或机构');
    }
  } else {
    seatScore = 38;
    risks.push('没有取到这只票的买方席位明细');
  }
  if (sellSeat && sellSeat.instCount > 0) {
    seatScore -= Math.min(25, sellSeat.instCount * 6);
    risks.push(`卖方出现 ${sellSeat.instCount} 个机构专用席位，机构在减仓`);
  }

  /* 历史胜率（样本不足就留空，权重会自动让给别的因子） */
  let win = null;
  if (winRate && winRate.samples >= 4) {
    win = 50 + (winRate.winRate - 50) * 1.1 + (winRate.avgD5 || 0) * 1.6;
    reasons.push(
      `历史上榜 ${winRate.samples} 次，5 日胜率 ${winRate.winRate}%，平均 ${winRate.avgD5 > 0 ? '+' : ''}${winRate.avgD5}%`,
    );
    if (winRate.winRate <= 35) risks.push(`5 日胜率只有 ${winRate.winRate}%，上榜后经常回落`);
  } else {
    risks.push('这只票历史样本不足 4 次，胜率的参考价值有限');
  }

  /* 上榜原因 */
  const explain = String(row.EXPLAIN || '');
  if (explain.includes('机构买入')) {
    seatScore += 4;
    reasons.push(`上榜原因：${explain}`);
  } else if (explain.includes('机构卖出')) {
    seatScore -= 6;
    risks.push(`上榜原因：${explain}`);
  } else if (explain) {
    reasons.push(`上榜原因：${explain}`);
  }
  if (/连续三个交易日|涨幅偏离值累计/.test(String(row.EXPLANATION || ''))) {
    risks.push('属于多日大涨后的上榜，位置已经不低');
  }

  const chg = num(row.CHANGE_RATE);
  if (chg !== null && chg >= 9.8) reasons.push('当日涨停上榜，属于强势票');
  if (chg !== null && chg <= -9.8) risks.push('当日跌停上榜，别在这种票上抢反弹');

  return {
    parts: {
      money: clamp100(money),
      seat: clamp100(seatScore),
      win: win === null ? null : clamp100(win),
      tech: null,
    },
    reasons,
    risks,
  };
}

/** 按权重把四个因子合成总分；缺哪个因子，就把它的权重分给别的因子 */
function combineParts(parts, weights) {
  const w = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
  const p = { ...parts };

  if (p.win === null || p.win === undefined) {
    const extra = w.win;
    w.win = 0;
    w.money += extra / 2;
    w.tech += extra / 2;
    p.win = 50;
  }
  if (p.tech === null || p.tech === undefined) {
    const extra = w.tech;
    w.tech = 0;
    w.money += extra / 2;
    w.seat += extra / 2;
    p.tech = 50;
  }

  const total = w.win + w.seat + w.money + w.tech || 1;
  const score = (p.win * w.win + p.seat * w.seat + p.money * w.money + p.tech * w.tech) / total;
  return { score: Math.round(clamp100(score)), weights: w };
}
