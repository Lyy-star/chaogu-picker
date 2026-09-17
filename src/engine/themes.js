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

function round(v, digits = 2) {
  if (!Number.isFinite(v)) return null;
  const p = 10 ** digits;
  return Math.round(v * p) / p;
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
  mergeMonth,
  isActive,
  themeSeason,
};
