'use strict';

/**
 * 季节性题材。
 *
 * A 股每年都有人按时令炒题材：入冬炒冰雪经济（大连圣亚、长白山）、
 * 供暖季炒天然气、夏天炒啤酒、中秋国庆和春节炒白酒、春节档暑期档炒影视院线……
 * 这些"月度推荐"里原来完全没有体现，因为季节性只算了个股，没算题材。
 *
 * 这里的做法：题材名单是人工挑的（下面 SEASONAL_THEMES），
 * 但"哪几个月是旺季"是**算出来的**——取题材里主板成分股的月线，
 * 统计这些成分股在每个自然月的历史平均涨幅和上涨年份占比，够强才算旺季。
 * 所以窗口不写死，市场自己说话；题材不行了，榜单里自然就不出现。
 */

const seasonal = require('./seasonal');

/** 备选题材：都是东方财富的板块代码（概念板块 + 行业板块），直接取成分股 */
const SEASONAL_THEMES = [
  { code: 'BK1185', name: '冰雪经济', hint: '滑雪、冰雪旅游，通常入冬到春节前' },
  { code: 'BK0843', name: '天然气', hint: '北方供暖季的用气高峰' },
  { code: 'BK0437', name: '煤炭', hint: '迎峰度冬、供暖补库' },
  { code: 'BK0428', name: '电力', hint: '迎峰度夏的用电高峰' },
  { code: 'BK0896', name: '白酒', hint: '中秋国庆 + 春节备货' },
  { code: 'BK1073', name: '啤酒', hint: '夏季消费旺季' },
  { code: 'BK1239', name: '白色家电', hint: '夏季空调、以旧换新' },
  { code: 'BK1282', name: '饮料乳品', hint: '夏季饮料旺季' },
  { code: 'BK0485', name: '旅游酒店', hint: '节假日和暑期出行' },
  { code: 'BK1222', name: '影视院线', hint: '春节档 + 暑期档（典型脉冲型）' },
  { code: 'BK1479', name: '航空运输', hint: '春运 + 暑运' },
  { code: 'BK0888', name: '农业种植', hint: '春耕 + 一号文件' },
  { code: 'BK1515', name: '粮食种植', hint: '春耕、玉米种子' },
  { code: 'BK0927', name: '免税概念', hint: '旅游旺季带动' },
  { code: 'BK0490', name: '军工', hint: '建军节、国庆前后' },
  { code: 'BK1079', name: '户外露营', hint: '春秋出行' },
];

/** 命中旺季题材时给综合分加的分：够用就行，不能让题材盖过个股自己的季节性 */
const THEME_BONUS = 4;

/** 旺季判定门槛：成分股在这个月的历史平均涨幅、上涨占比、样本数都要够 */
const ACTIVE_RULE = { minAvgPct: 1.5, minWinRate: 55, minMembers: 4 };

/**
 * 春节日期表（农历节日在公历上每年都跑，只能查表）。
 * 用来把"脉冲峰值出现在几号"翻译成"春节前几个交易日"——春节档影视的关键就是这个节点。
 */
const SPRING_FESTIVAL = {
  2015: '2015-02-19', 2016: '2016-02-08', 2017: '2017-01-28', 2018: '2018-02-16',
  2019: '2019-02-05', 2020: '2020-01-25', 2021: '2021-02-12', 2022: '2022-02-01',
  2023: '2023-01-22', 2024: '2024-02-10', 2025: '2025-01-29', 2026: '2026-02-17',
  2027: '2027-02-06', 2028: '2028-01-26', 2029: '2029-02-13', 2030: '2030-02-03',
  2031: '2031-01-23', 2032: '2032-02-11',
};

function round(v, digits = 2) {
  if (!Number.isFinite(v)) return null;
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * 月内峰值出现在什么时候：拿日线算出每个月"涨得最高的那天"，
 * 再看它落在几号、是当月第几个交易日、离春节有几个交易日。
 *
 * 为什么需要它：月线只能告诉你"这个月冲高又回吐"，但不知道冲高在哪几天；
 * 而对脉冲型题材来说，**什么时候买**才是关键（春节档影视是节前涨、节后见顶）。
 *
 * @param {Array} barsList 每只成分股的日线 bars
 * @param {number} month 1-12
 */
function peakTiming(barsList, month, { now = new Date() } = {}) {
  const curKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const dayOfMonth = [];
  const tradeDays = [];
  const holidays = [];

  for (const bars of barsList || []) {
    if (!Array.isArray(bars) || bars.length < 40) continue;
    const byMonth = new Map();
    const allDates = [];
    for (const b of bars) {
      const d = String((b && b.date) || '');
      if (d.length < 10 || !Number.isFinite(b.close)) continue;
      const key = d.slice(0, 7);
      if (!byMonth.has(key)) byMonth.set(key, []);
      byMonth.get(key).push({ date: d, close: b.close });
      allDates.push(d);
    }
    const keys = [...byMonth.keys()].sort();
    allDates.sort();

    for (let i = 1; i < keys.length; i += 1) {
      const key = keys[i];
      if (key === curKey) continue; // 当月还没走完
      const curMonth = Number(key.slice(5, 7));
      if (curMonth !== month) continue;
      const prev = byMonth.get(keys[i - 1]);
      const cur = byMonth.get(key);
      const base = prev[prev.length - 1] && prev[prev.length - 1].close;
      if (!Number.isFinite(base) || base <= 0) continue;

      let best = cur[0];
      for (const x of cur) if (x.close > best.close) best = x;
      if (!best || best.close <= base) continue; // 这个月没涨，谈不上峰值

      dayOfMonth.push(Number(best.date.slice(8, 10)));
      tradeDays.push(cur.indexOf(best) + 1);

      // 离春节还有几个交易日（负数=节前）
      const year = Number(key.slice(0, 4));
      const sf = SPRING_FESTIVAL[year];
      if (sf) {
        const anchor = allDates.find((d) => d >= sf);
        const pi = allDates.indexOf(best.date);
        const ai = anchor ? allDates.indexOf(anchor) : -1;
        if (pi >= 0 && ai >= 0) holidays.push(pi - ai);
      }
    }
  }

  const timing = { samples: dayOfMonth.length };

  // 公历日期：这个月里峰值一般落在几号
  if (dayOfMonth.length >= 4) {
    const sortedDay = [...dayOfMonth].sort((a, b) => a - b);
    const sortedTrade = [...tradeDays].sort((a, b) => a - b);
    timing.dayLow = Math.round(quantile(sortedDay, 0.25));
    timing.dayMid = Math.round(quantile(sortedDay, 0.5));
    timing.dayHigh = Math.round(quantile(sortedDay, 0.75));
    timing.tradeLow = Math.round(quantile(sortedTrade, 0.25));
    timing.tradeMid = Math.round(quantile(sortedTrade, 0.5));
    timing.tradeHigh = Math.round(quantile(sortedTrade, 0.75));
  }

  const sortedHoliday = [...holidays].sort((a, b) => a - b);
  if (sortedHoliday.length >= 6) {
    const mid = Math.round(quantile(sortedHoliday, 0.5));
    // 只有在春节前后一个月内才提"离春节几个交易日"；
    // 9 月显示"对春节 152 个交易日"这种就是废话，不如不给。
    if (Math.abs(mid) <= 25) {
      timing.holidayName = '春节';
      timing.holidayMid = mid;
      timing.holidayLow = Math.round(quantile(sortedHoliday, 0.25));
      timing.holidayHigh = Math.round(quantile(sortedHoliday, 0.75));
    }
  }
  return Number.isFinite(timing.dayMid) || Number.isFinite(timing.holidayMid) ? timing : null;
}

/**
 * 把一个题材的若干成分股的"某月季节性"合成题材的季节性。
 * @param {Array} seasonalPerStock [{1:{total,avgPct,winRate,up}, ...}, ...]
 * @param {number} month
 */
function mergeMonth(seasonalPerStock, month) {
  const rows = (seasonalPerStock || [])
    .map((s) => s && s[month])
    .filter((x) => x && x.total);
  if (!rows.length) return null;

  const n = rows.length;
  const avg = (key) => rows.reduce((a, b) => a + (Number.isFinite(b[key]) ? b[key] : 0), 0) / n;
  const stat = {
    members: n,
    total: Math.min(...rows.map((r) => r.total)),
    avgPct: round(avg('avgPct'), 2),
    avgPeak: round(avg('avgPeak'), 2),
    winRate: round(avg('winRate'), 1),
    giveBack: round(avg('giveBack'), 2),
    // 这个月里"平均是涨的"成分股有几只，用来判断题材的普涨程度
    up: rows.filter((r) => (r.avgPct || 0) > 0).length,
  };
  // 脉冲型：月内冲得起来，但大部分涨幅到月底又还回去了（春节档影视就是典型）
  stat.pulse = seasonal.isPulse(stat);
  return stat;
}

/** 这个月算不算这个题材的旺季 */
function isActive(stat, rule = ACTIVE_RULE) {
  return !!stat
    && stat.members >= rule.minMembers
    && stat.avgPct >= rule.minAvgPct
    && stat.winRate >= rule.minWinRate;
}

/**
 * 一个题材 12 个月的季节性，并分出两类月份：
 *   active（旺季）：月末涨幅和上涨占比都够，可以当整月顺风股；
 *   pulse（脉冲）：月内冲得猛但月末基本白干，只能抢一把就跑。
 * 样本太薄（成分股不够）的月份两个都不给，免得一两只票的噪声被当成题材规律。
 *
 * @param {Array} seasonalPerStock 每个成分股的 12 个月季节统计
 */
function themeSeason(seasonalPerStock, rule = ACTIVE_RULE, pulseMinMembers = 3) {
  const months = {};
  const active = [];
  const pulse = [];
  for (let m = 1; m <= 12; m += 1) {
    const stat = mergeMonth(seasonalPerStock, m);
    if (!stat) continue;
    months[m] = stat;
    if (stat.members < pulseMinMembers) continue;
    if (isActive(stat, rule)) active.push(m);
    else if (stat.pulse) pulse.push(m);
  }
  return { months, active, pulse };
}

module.exports = {
  SEASONAL_THEMES,
  THEME_BONUS,
  ACTIVE_RULE,
  SPRING_FESTIVAL,
  mergeMonth,
  isActive,
  themeSeason,
  peakTiming,
};
