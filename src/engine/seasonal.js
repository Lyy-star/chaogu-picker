'use strict';

/**
 * 月度季节性排名 + 生肖题材。
 *
 * 思路（全部基于公开历史数据，不做预测）：
 *  1. 对候选股取"月线"（约 10 年），算出每个自然月的平均涨跌幅和上涨年份占比；
 *  2. 按"季节性得分"排序，再和当前的选股评分加权，得到月度推荐；
 *  3. 生肖股：把股票名称里带生肖字的挑出来（近几年市场有炒生肖的习惯），
 *     附上它们的活跃度和当月季节性，但明确标注这是题材炒作、风险更高。
 */

const { monthlyReturns, monthSummary } = require('./insight');

const MONTH_CN = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
const ZODIAC = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];

/** 公历年份对应的生肖（2026 -> 马） */
function zodiacOf(year) {
  const idx = (((Number(year) - 4) % 12) + 12) % 12;
  return ZODIAC[idx];
}

/**
 * 季节性得分（0-100）：平均涨幅为主，上涨概率为辅。
 * 例：平均 +5.5%、71% 上涨 -> 50 + 22 + 12.6 = 84.6
 */
function seasonScore(stats) {
  if (!stats || !stats.total) return null;
  const avg = Number.isFinite(stats.avgPct) ? stats.avgPct : 0;
  const win = Number.isFinite(stats.winRate) ? stats.winRate : 50;
  return Math.max(0, Math.min(100, Math.round((50 + avg * 4 + (win - 50) * 0.6) * 10) / 10));
}

/** 把"月线 bars"算成指定月份的季节性统计 */
function seasonOf(bars, month) {
  if (!Array.isArray(bars) || !bars.length) return null;
  return monthSummary(monthlyReturns(bars), month);
}

/**
 * 候选股 -> 指定月份的季节性排名
 * @param {Array} candidates [{code,name,price,changePct,techScore,bars}]
 * @param {number} month 1-12
 */
function rankForMonth(candidates, month, { minYears = 3, limit = 12, seasonWeight = 0.65 } = {}) {
  const scored = [];

  for (const c of candidates || []) {
    if (!c || !c.code) continue;
    const season = seasonOf(c.bars, month);
    if (!season || !season.total || season.total < minYears) continue;

    const sScore = seasonScore(season);
    const tech = Number.isFinite(c.techScore) ? c.techScore : null;
    const total = tech === null
      ? sScore
      : Math.round((sScore * seasonWeight + tech * (1 - seasonWeight)) * 10) / 10;

    scored.push({
      code: c.code,
      name: c.name,
      price: c.price,
      changePct: c.changePct,
      amount: c.amount,
      turnoverRate: c.turnoverRate,
      techScore: tech,
      season,
      seasonScore: sScore,
      total,
    });
  }

  scored.sort((a, b) => b.total - a.total);
  return scored.slice(0, limit);
}

/** 名称里带生肖字的股票，返回命中的字 */
function matchZodiac(rows, chars) {
  const set = [...new Set((chars || []).filter(Boolean))];
  const out = [];
  for (const r of rows || []) {
    const name = String((r && r.name) || '');
    if (!name) continue;
    const hit = set.find((c) => name.includes(c));
    if (hit) out.push({ ...r, zodiacChar: hit });
  }
  return out;
}

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function round(v, digits = 2) {
  if (!Number.isFinite(v)) return null;
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

/** 取某年某月的最后收盘价 */
function closeAt(bars, year, month) {
  const hits = (bars || []).filter((b) => {
    const d = String((b && b.date) || '');
    return Number(d.slice(0, 4)) === year && Number(d.slice(5, 7)) === month && Number.isFinite(b.close);
  });
  return hits.length ? hits[hits.length - 1].close : null;
}

/**
 * 生肖炒作窗口：统计过往年生肖股在"前一年 9 月 ~ 当年 3 月"这段里，
 * 每个自然月的平均涨幅，看市场到底在哪几个月炒。
 * @param {Array} samples [{ year, animal, code, name, bars }]
 */
function hypeWindow(samples) {
  const byMonth = new Map();
  for (const s of samples || []) {
    const prevYear = s.year - 1;
    for (let m = 9; m <= 12; m += 1) {
      const c = closeAt(s.bars, prevYear, m);
      const p = closeAt(s.bars, prevYear, m - 1);
      if (c && p) {
        const list = byMonth.get(m) || [];
        list.push(((c - p) / p) * 100);
        byMonth.set(m, list);
      }
    }
    for (let m = 1; m <= 3; m += 1) {
      const c = closeAt(s.bars, s.year, m);
      const p = closeAt(s.bars, s.year, m - 1);
      if (c && p) {
        const list = byMonth.get(m) || [];
        list.push(((c - p) / p) * 100);
        byMonth.set(m, list);
      }
    }
  }

  const months = [...byMonth.entries()]
    .map(([month, arr]) => ({
      month,
      name: MONTH_CN[month - 1],
      n: arr.length,
      avgPct: round(mean(arr), 2),
      winRate: round((arr.filter((x) => x > 0).length / arr.length) * 100, 1),
    }))
    .sort((a, b) => a.month - b.month);

  const best = [...months].sort((a, b) => b.avgPct - a.avgPct);
  return {
    months,
    best: best.slice(0, 3),
    windowMonths: best.slice(0, 3).map((x) => x.month).sort((a, b) => a - b),
  };
}

/**
 * 往年生肖龙头：按"前一年 10 月底 → 当年 2 月底"这段涨幅挑出每年前几名，
 * 再统计它们的共同特征（主要是启动价），给今年的候选做参照。
 */
function leaderProfile(samples, { topPerYear = 3 } = {}) {
  const byYear = new Map();
  for (const s of samples || []) {
    const start = closeAt(s.bars, s.year - 1, 10);
    const end = closeAt(s.bars, s.year, 2);
    if (!start || !end) continue;
    const gain = ((end - start) / start) * 100;
    const list = byYear.get(s.year) || [];
    list.push({ year: s.year, animal: s.animal, code: s.code, name: s.name, startPrice: round(start), gain: round(gain, 1) });
    byYear.set(s.year, list);
  }

  const leaders = [];
  for (const list of byYear.values()) {
    leaders.push(...list.sort((a, b) => b.gain - a.gain).slice(0, topPerYear));
  }
  leaders.sort((a, b) => b.gain - a.gain);

  const prices = leaders.map((x) => x.startPrice).filter(Number.isFinite);
  const gains = leaders.map((x) => x.gain).filter(Number.isFinite);
  const gainsPos = gains.filter((g) => g > 0).length;

  return {
    leaders,
    years: byYear.size,
    startPriceMedian: prices.length ? round(prices.sort((a, b) => a - b)[Math.floor(prices.length / 2)]) : null,
    startPriceMax: prices.length ? round(Math.max(...prices)) : null,
    gainMedian: gains.length ? round(gains.sort((a, b) => a - b)[Math.floor(gains.length / 2)], 1) : null,
    leaderHitRate: gains.length ? round((gainsPos / gains.length) * 100, 0) : null,
  };
}

/**
 * 用往年龙头的特征，给今年的生肖候选打分（0-100）。
 * 只看能算得准的特征：启动价（低价优先）、当前价、换手率、名称结构。
 */
function matchLeaderProfile(candidate, profile, { price } = {}) {
  const reasons = [];
  let score = 50;

  const p = Number.isFinite(price) ? price : Number(candidate && candidate.price);
  const median = profile && Number.isFinite(profile.startPriceMedian) ? profile.startPriceMedian : null;
  if (Number.isFinite(p) && median) {
    if (p <= median) {
      score += 18;
      reasons.push(`现价 ${round(p)} 元，比往年生肖龙头的启动价中位数（${median} 元）还低，符合低价题材的特征`);
    } else if (p <= median * 1.5) {
      score += 8;
      reasons.push(`现价 ${round(p)} 元，和往年龙头启动价（中位数 ${median} 元）接近`);
    } else {
      score -= 10;
      reasons.push(`现价 ${round(p)} 元，明显高于往年龙头的启动价（中位数 ${median} 元），拉起来更费资金`);
    }
  }

  const turnover = Number(candidate && candidate.turnoverRate);
  if (Number.isFinite(turnover)) {
    if (turnover >= 3 && turnover <= 25) {
      score += 12;
      reasons.push(`换手率 ${round(turnover)}%，属于有资金参与、又不至于过热的区间`);
    } else if (turnover < 1) {
      score -= 6;
      reasons.push(`换手率只有 ${round(turnover)}%，太冷，题材来之前没人接力`);
    } else if (turnover > 30) {
      score -= 8;
      reasons.push(`换手率 ${round(turnover)}%，已经过热，容易接在情绪顶上`);
    }
  }

  const name = String((candidate && candidate.name) || '');
  const ch = candidate && candidate.zodiacChar;
  if (ch && name.startsWith(ch)) {
    score += 8;
    reasons.push(`名称以「${ch}」开头（${name}），是市场最认的那类生肖票`);
  } else if (ch) {
    score += 4;
    reasons.push(`名称里含生肖字「${ch}」（${name}）`);
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons: reasons.slice(0, 3),
  };
}

module.exports = {
  zodiacOf,
  seasonScore,
  seasonOf,
  rankForMonth,
  matchZodiac,
  hypeWindow,
  leaderProfile,
  matchLeaderProfile,
  closeAt,
  MONTH_CN,
  ZODIAC,
};
