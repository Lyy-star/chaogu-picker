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

/**
 * 正主字 + 市场炒过的谐音字。
 * 例：羊年除了「羊」，市场还会顺带炒「阳 / 洋 / 扬」；马年炒「马 / 码」。
 */
const HOMOPHONE = {
  鼠: ['鼠', '数'],
  牛: ['牛', '纽'],
  虎: ['虎', '琥'],
  兔: ['兔', '图'],
  龙: ['龙', '隆'],
  蛇: ['蛇', '佘'],
  马: ['马', '码'],
  羊: ['羊', '阳', '洋', '扬', '牧'],
  猴: ['猴', '侯'],
  鸡: ['鸡', '吉'],
  狗: ['狗', '苟'],
  猪: ['猪', '朱'],
};

function zodiacChars(animal) {
  return HOMOPHONE[animal] || [animal];
}

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
function rankForMonth(candidates, month, { minYears = 2, limit = 100, seasonWeight = 0.65 } = {}) {
  const scored = [];

  for (const c of candidates || []) {
    if (!c || !c.code) continue;
    // 优先用按月缓存好的季节统计（月度榜走这条），没有就现算（其它调用方传 bars）
    const season = (c.seasonByMonth && c.seasonByMonth[month]) || seasonOf(c.bars, month);
    if (!season || !season.total || season.total < minYears) continue;

    const sScore = seasonScore(season);
    // 「当前分」统一用行情快照重算：榜单里有上百只票，只有选股结果那几十只带日线 techScore，
    // 直接混在一起排等于用两把尺子量，所以这里全部换成同一口径。
    const tech = snapshotScore(c);
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
      // 季节统计只留界面上要用的四个字段：100 只 × 12 个月的完整对象太占体积
      season: {
        total: season.total,
        avgPct: season.avgPct,
        winRate: season.winRate,
        up: season.up,
      },
      seasonScore: sScore,
      total,
    });
  }

  scored.sort((a, b) => b.total - a.total || b.seasonScore - a.seasonScore);
  return scored.slice(0, limit);
}

/**
 * 当前分（0-100）：只用行情快照就能算出来的一致口径。
 * 相对强度为主（温和启动最好、暴涨算追高），再叠加资金和量能。
 */
function snapshotScore(row) {
  if (!row) return null;
  let s = 50;

  const chg60 = num(row.change60Pct);
  if (chg60 !== null) {
    if (chg60 >= -10 && chg60 <= 20) s += 12;
    else if (chg60 > 60) s -= 14;
    else if (chg60 > 35) s -= 6;
    else if (chg60 < -25) s -= 8;
  }

  const netPct = num(row.mainNetInPct);
  if (netPct !== null) {
    if (netPct >= 5) s += 10;
    else if (netPct >= 1) s += 4;
    else if (netPct <= -5) s -= 12;
    else if (netPct < 0) s -= 4;
  }

  const tr = num(row.turnoverRate);
  if (tr !== null) {
    if (tr >= 2 && tr <= 15) s += 8;
    else if (tr > 35) s -= 10;
    else if (tr < 0.5) s -= 6;
  }

  return Math.max(0, Math.min(100, Math.round(s)));
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

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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
    const pre = closeAt(s.bars, s.year - 1, 4);
    const end = closeAt(s.bars, s.year, 2);
    if (!start || !end) continue;
    const gain = ((end - start) / start) * 100;
    const list = byYear.get(s.year) || [];
    list.push({
      year: s.year,
      animal: s.animal,
      code: s.code,
      name: s.name,
      startPrice: round(start),
      gain: round(gain, 1),
      preGain: pre ? round(((start - pre) / pre) * 100, 1) : null,
    });
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
  const preGains = leaders.map((x) => x.preGain).filter(Number.isFinite);

  return {
    leaders,
    years: byYear.size,
    startPriceMedian: prices.length ? round(prices.sort((a, b) => a - b)[Math.floor(prices.length / 2)]) : null,
    startPriceMax: prices.length ? round(Math.max(...prices)) : null,
    gainMedian: gains.length ? round(gains.sort((a, b) => a - b)[Math.floor(gains.length / 2)], 1) : null,
    // 启动前半年涨幅：龙头在起爆前大多是横盘的
    preGainMedian: preGains.length
      ? round(preGains.sort((a, b) => a - b)[Math.floor(preGains.length / 2)], 1)
      : null,
    leaderHitRate: gains.length ? round((gainsPos / gains.length) * 100, 0) : null,
  };
}

/** 近 N 个月涨幅（用月线算，判断"有没有已经启动"） */
function recentGain(bars, months = 3) {
  const arr = (bars || []).filter((b) => Number.isFinite(b.close));
  if (arr.length < months + 1) return null;
  const last = arr[arr.length - 1].close;
  const base = arr[arr.length - 1 - months].close;
  if (!base) return null;
  return round(((last - base) / base) * 100, 1);
}

/**
 * 埋伏打分（0-100）。
 *
 * 生肖是纯情绪票，所以这里不看基本面，只看"资金好不好拉、有没有已经炒过"：
 * 正主名字 > 谐音名字；低价、小市值、近几个月没启动、盘面安静 = 适合潜伏。
 */
function ambushScore(row, profile, { type = 'main', gain3m = null } = {}) {
  const reasons = [];
  const risks = [];
  let score = 38;

  if (type === 'main') {
    score += 24;
    reasons.push(`名称里直接带「${row.zodiacChar}」字，是这类题材的正主`);
  } else if (type === 'homophone') {
    score += 10;
    reasons.push(`名称里带谐音字「${row.zodiacChar}」，往年市场也炒过谐音，确定性低一档`);
  } else if (type === 'current') {
    score += 6;
    reasons.push(`属于今年（${row.animal || ''}年）的生肖股，行情窗口还没走完`);
  }

  const price = Number(row.price);
  const median = Number(profile && profile.startPriceMedian);
  if (Number.isFinite(price) && Number.isFinite(median)) {
    if (price <= median) {
      score += 16;
      reasons.push(`现价 ${round(price)} 元，低于往年龙头启动价中位数（${median} 元），拉起来省资金`);
    } else if (price <= median * 1.5) {
      score += 6;
      reasons.push(`现价 ${round(price)} 元，接近往年龙头的启动价（中位数 ${median} 元）`);
    } else {
      score -= 10;
      risks.push(`现价 ${round(price)} 元明显高于往年龙头启动价（${median} 元），埋伏性价比差`);
    }
  }

  const cap = Number(row.floatCap);
  if (Number.isFinite(cap)) {
    const yi = cap / 1e8;
    if (yi <= 50) {
      score += 14;
      reasons.push(`流通市值只有 ${yi.toFixed(0)} 亿，小盘票一点资金就能拉动`);
    } else if (yi <= 120) {
      score += 5;
      reasons.push(`流通市值 ${yi.toFixed(0)} 亿，盘子适中`);
    } else {
      score -= 12;
      risks.push(`流通市值 ${yi.toFixed(0)} 亿偏大，纯题材很难撬动`);
    }
  }

  // 优先用月线算出来的近 3 个月涨幅；没有月线就用快照里的 60 日涨跌幅
  const gain = Number.isFinite(gain3m)
    ? gain3m
    : (Number.isFinite(Number(row.change60Pct)) ? Number(row.change60Pct) : null);
  const gainLabel = Number.isFinite(gain3m) ? '近 3 个月' : '近 60 个交易日';

  if (Number.isFinite(gain)) {
    if (gain <= 10) {
      score += 12;
      reasons.push(`${gainLabel}只涨了 ${round(gain)}%，还没启动，正适合潜伏`);
    } else if (gain <= 30) {
      score += 3;
      reasons.push(`${gainLabel}涨了 ${round(gain)}%，已经有点动静`);
    } else {
      score -= 14;
      risks.push(`${gainLabel}已经涨了 ${round(gain)}%，第一波可能炒完了，再进就是接棒`);
    }
  }

  const turnover = Number(row.turnoverRate);
  if (Number.isFinite(turnover)) {
    if (turnover <= 3) {
      score += 8;
      reasons.push(`换手率 ${round(turnover)}%，盘面还很安静，没人抢筹`);
    } else if (turnover <= 10) {
      score += 2;
    } else {
      score -= 8;
      risks.push(`换手率 ${round(turnover)}%，已经热闹起来了，埋伏成本变高`);
    }
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons: reasons.slice(0, 4),
    risks: risks.slice(0, 2),
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
  zodiacChars,
  seasonScore,
  seasonOf,
  rankForMonth,
  snapshotScore,
  matchZodiac,
  hypeWindow,
  leaderProfile,
  matchLeaderProfile,
  recentGain,
  ambushScore,
  closeAt,
  MONTH_CN,
  ZODIAC,
};
