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

/**
 * 第一轮打分（不用 K 线，只看龙虎榜数据）：
 * 从几百条上榜记录里挑出值得进一步看的票。
 */
function scoreBase(row, { winRate, seat, sellSeat }) {
  const reasons = [];
  const risks = [];
  let score = 42;
  const weights = { win: 0.35, seat: 0.25, money: 0.2, tech: 0.2 };

  /* 资金面 */
  const net = num(row.BILLBOARD_NET_AMT) || 0;
  const netRatio = num(row.DEAL_NET_RATIO);
  if (net >= 2e8) {
    score += 9;
    reasons.push(`龙虎榜净买入 ${round(net / 1e8)} 亿元，资金介入很深`);
  } else if (net >= 5e7) {
    score += 5;
    reasons.push(`龙虎榜净买入约 ${round(net / 1e8)} 亿元，有资金在做`);
  } else if (net <= -5e7) {
    score -= 12;
    risks.push(`龙虎榜净卖出约 ${round(Math.abs(net) / 1e8)} 亿元，是资金在出，不是在进`);
  }
  if (netRatio !== null && netRatio >= 5) {
    score += 4;
    reasons.push(`净买入占成交额 ${round(netRatio)}%，当天是主动买上去的`);
  }

  /* 席位质量 */
  if (seat) {
    if (seat.instCount >= 2) {
      score += 5;
      reasons.push(`买方有 ${seat.instCount} 个机构专用席位，机构在参与`);
    }
    if (seat.activeCount > 0) {
      score += Math.min(8, 4 + seat.activeCount);
      reasons.push(`买方有 ${seat.activeCount} 个近三个月活跃席位（${seat.activeNames.join('、')}），一线游资在动手`);
    }
    if (seat.topProb !== null && seat.topProb >= 55) {
      score += 4;
      reasons.push(`买方最强席位近 3 日上涨概率 ${round(seat.topProb, 1)}%，历史手感不错`);
    }
    if (!seat.instCount && !seat.activeCount) {
      risks.push('买方席位比较普通，没有明显的一线游资或机构');
    }
  }
  if (sellSeat && sellSeat.instCount > 0) {
    score -= 6;
    risks.push(`卖方出现 ${sellSeat.instCount} 个机构专用席位，机构在减仓`);
  }

  /* 历史胜率 */
  if (winRate && winRate.samples >= 4) {
    if (winRate.winRate >= 65) {
      score += 10;
      reasons.push(
        `这只票历史上榜 ${winRate.samples} 次，5 日胜率 ${winRate.winRate}%，平均 ${winRate.avgD5 > 0 ? '+' : ''}${winRate.avgD5}%`,
      );
    } else if (winRate.winRate >= 50) {
      score += 3;
      reasons.push(`历史上榜 ${winRate.samples} 次，5 日胜率 ${winRate.winRate}%，平均 ${winRate.avgD5}%`);
    } else if (winRate.winRate <= 35) {
      score -= 12;
      risks.push(`历史上榜 ${winRate.samples} 次，5 日胜率只有 ${winRate.winRate}%，上榜后经常回落`);
    }
  } else {
    weights.win = 0.15;
    weights.tech += 0.1;
    weights.money += 0.1;
    risks.push('这只票历史样本不足 4 次，胜率的参考价值有限');
  }

  /* 上榜原因 */
  const explain = String(row.EXPLAIN || '');
  const reason = String(row.EXPLANATION || '');
  if (explain.includes('机构买入')) {
    score += 3;
    reasons.push(`上榜原因：${explain}`);
  } else if (explain.includes('机构卖出')) {
    score -= 5;
    risks.push(`上榜原因：${explain}`);
  } else if (explain) {
    reasons.push(`上榜原因：${explain}`);
  }
  if (/连续三个交易日|涨幅偏离值累计/.test(reason)) {
    risks.push('属于多日大涨后的上榜，位置已经不低');
  }

  const chg = num(row.CHANGE_RATE);
  if (chg !== null) {
    if (chg >= 9.8) reasons.push('当日涨停上榜，属于强势票');
    else if (chg <= -9.8) risks.push('当日跌停上榜，别在这种票上抢反弹');
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons, risks, weights };
}

/** 第二轮：带上 K 线技术位置，出最终分和建议 */
function scoreFinal(base, { tech }) {
  let score = base.score;
  const reasons = [...base.reasons];
  const risks = [...base.risks];

  if (tech) {
    if (Number.isFinite(tech.ma5) && Number.isFinite(tech.ma10)) {
      if (tech.price > tech.ma5 && tech.ma5 > tech.ma10) {
        score += 6;
        reasons.push('现价在 5 日线上方、且 5 日线在 10 日线上方，短线是强势结构');
      } else if (tech.price < tech.ma10) {
        score -= 9;
        risks.push('已经跌破 10 日线，短线结构转弱');
      }
    }
    if (Number.isFinite(tech.position)) {
      if (tech.position >= 0.9) {
        score -= 10;
        risks.push('处在近 60 日最高位附近，追高风险大');
      } else if (tech.position <= 0.35) {
        score += 5;
        reasons.push(`处在近 60 日区间 ${Math.round(tech.position * 100)}% 的位置，算相对低位`);
      }
    }
    if (Number.isFinite(tech.chg5Pct) && tech.chg5Pct > 25) {
      score -= 10;
      risks.push(`近 5 个交易日已经涨了 ${tech.chg5Pct}%，再进就是接力`);
    }
    if (Number.isFinite(tech.atrPct) && tech.atrPct > 8) {
      risks.push(`日均波动 ${tech.atrPct}%，题材票波动大，仓位要压住`);
    }
  }

  const final = Math.max(0, Math.min(96, Math.round(score)));
  const verdict = final >= 78 ? '重点关注' : final >= 66 ? '可低吸' : final >= 52 ? '观察' : '回避';
  return { score: final, verdict, reasons: reasons.slice(0, 6), risks: risks.slice(0, 3) };
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
function buildCandidates({ boardRows, seatRows, sellRows, historyRows, maxCandidates = 12 }) {
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
    const base = scoreBase(row, { winRate, seat, sellSeat });

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
