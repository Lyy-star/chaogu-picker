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

module.exports = { zodiacOf, seasonScore, seasonOf, rankForMonth, matchZodiac, MONTH_CN, ZODIAC };
