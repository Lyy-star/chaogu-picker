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

/** 备选题材：都是东方财富的概念板块代码，直接取成分股 */
const SEASONAL_THEMES = [
  { code: 'BK1185', name: '冰雪经济', hint: '滑雪、冰雪旅游，通常入冬到春节前' },
  { code: 'BK0843', name: '天然气', hint: '北方供暖季的用气高峰' },
  { code: 'BK0896', name: '白酒', hint: '中秋国庆 + 春节备货' },
  { code: 'BK1073', name: '啤酒', hint: '夏季消费旺季' },
  { code: 'BK0485', name: '旅游酒店', hint: '节假日和暑期出行' },
  { code: 'BK0847', name: '影视院线', hint: '春节档 + 暑期档' },
  { code: 'BK0888', name: '农业种植', hint: '春耕 + 一号文件' },
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
  const avgPct = rows.reduce((a, b) => a + (Number.isFinite(b.avgPct) ? b.avgPct : 0), 0) / n;
  const winRate = rows.reduce((a, b) => a + (Number.isFinite(b.winRate) ? b.winRate : 0), 0) / n;
  return {
    members: n,
    total: Math.min(...rows.map((r) => r.total)),
    avgPct: round(avgPct, 2),
    winRate: round(winRate, 1),
    // 这个月里"平均是涨的"成分股有几只，用来判断题材的普涨程度
    up: rows.filter((r) => (r.avgPct || 0) > 0).length,
  };
}

/** 这个月算不算这个题材的旺季 */
function isActive(stat, rule = ACTIVE_RULE) {
  return !!stat
    && stat.members >= rule.minMembers
    && stat.avgPct >= rule.minAvgPct
    && stat.winRate >= rule.minWinRate;
}

/**
 * 一个题材 12 个月的季节性 + 哪几个月是旺季。
 * @param {Array} seasonalPerStock 每个成分股的 12 个月季节统计
 */
function themeSeason(seasonalPerStock, rule = ACTIVE_RULE) {
  const months = {};
  const active = [];
  for (let m = 1; m <= 12; m += 1) {
    const stat = mergeMonth(seasonalPerStock, m);
    if (!stat) continue;
    months[m] = stat;
    if (isActive(stat, rule)) active.push(m);
  }
  return { months, active };
}

module.exports = {
  SEASONAL_THEMES,
  THEME_BONUS,
  ACTIVE_RULE,
  mergeMonth,
  isActive,
  themeSeason,
};
