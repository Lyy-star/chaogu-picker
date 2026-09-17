'use strict';

/**
 * 季节性题材 + 月内脉冲识别自检（不联网）。
 *
 *   node scripts/test-themes.js
 *
 * 断言里用的是真实盘面量出来的数字：影视院线 2 月的春节档行情、
 * 冰雪经济 11 月的入冬行情，验证"冲几天就跌回去"能不能被筛出来。
 */

const seasonal = require('../src/engine/seasonal');
const themes = require('../src/engine/themes');

let failed = 0;
function check(ok, msg) {
  if (ok) {
    console.log(`v ${msg}`);
  } else {
    console.error(`x ${msg}`);
    failed += 1;
  }
}

/** 造一只票某个月的季节统计（字段和 monthStatsWithPeak 的输出一致） */
function stockStat({ avgPct, avgPeak, giveBack, total = 10, winRate = 55 }) {
  const s = {
    total,
    avgPct,
    avgPeak,
    giveBack,
    winRate,
    up: Math.round((total * winRate) / 100),
  };
  s.pulse = seasonal.isPulse(s);
  return s;
}

/** 让同一只票在指定月份带上统计 */
function stock(month, opts) {
  return { [month]: stockStat(opts) };
}

console.log('== 月内脉冲判定 ==');
check(
  seasonal.isPulse({ avgPeak: 15.09, avgPct: 0.71, giveBack: 0.95 }),
  '春节档影视（月内最高 +15.09%、月末只剩 +0.71%、回吐 95%）判为脉冲',
);
check(
  !seasonal.isPulse({ avgPeak: 16.39, avgPct: 5.82, giveBack: 0.67 }),
  '冰雪经济 11 月（月内最高 +16.39%、月末还有 +5.82%）不算脉冲，是整月趋势',
);
check(
  !seasonal.isPulse({ avgPeak: 4.2, avgPct: 0.3, giveBack: 0.93 }),
  '月内最高只有 4.2% 的不算脉冲（冲得太少，没什么好抢）',
);
check(
  !seasonal.isPulse({ avgPeak: 12, avgPct: 8, giveBack: 0.33 }),
  '月内冲高但月末基本守住（回吐 33%）的不算脉冲',
);
check(
  !seasonal.isPulse({ avgPeak: 9.5, avgPct: 2.4, giveBack: 0.75 }),
  '月末还有 +2.4% 的仍按趋势处理（脉冲要求月末基本白干）',
);

console.log('\n== 题材聚合 ==');
const film = themes.themeSeason([
  stock(2, { avgPct: 0.71, avgPeak: 15.09, giveBack: 0.95 }),
  stock(2, { avgPct: -1.2, avgPeak: 13.4, giveBack: 1 }),
  stock(2, { avgPct: 1.5, avgPeak: 12.0, giveBack: 0.88 }),
  stock(2, { avgPct: 0.2, avgPeak: 11.2, giveBack: 0.98 }),
]);
check(
  film.pulse.includes(2),
  `春节档影视整体判为脉冲（2 月：月末 ${film.months[2].avgPct}%、月内最高 ${film.months[2].avgPeak}%、回吐 ${film.months[2].giveBack}）`,
);
check(!film.active.includes(2), '脉冲月份不会被当成"旺季顺风"月份');

const winter = themes.themeSeason([
  stock(11, { avgPct: 8.1, avgPeak: 16.4, giveBack: 0.5 }),
  stock(11, { avgPct: 5.2, avgPeak: 15.1, giveBack: 0.66 }),
  stock(11, { avgPct: 4.4, avgPeak: 14.6, giveBack: 0.7, winRate: 75 }),
  stock(11, { avgPct: 5.6, avgPeak: 17.2, giveBack: 0.67, winRate: 75 }),
]);
check(winter.active.includes(11), '冰雪经济 11 月判为旺季（整月趋势）');
check(!winter.pulse.includes(11), '冰雪经济 11 月没被误标成脉冲');

console.log('\n== 样本门槛 ==');
const thin = themes.themeSeason([
  stock(2, { avgPct: -2, avgPeak: 20, giveBack: 1 }),
  stock(2, { avgPct: -3, avgPeak: 18, giveBack: 1 }),
]);
check(!thin.pulse.includes(2) && !thin.active.includes(2), '只有 2 只成分股有数据的月份，两个名单都不进');

console.log('\n== 规则参数 ==');
check(seasonal.PULSE_RULE.minPeakPct === 6, `脉冲门槛：月内最高涨幅 ≥ ${seasonal.PULSE_RULE.minPeakPct}%`);
check(seasonal.PULSE_RULE.maxEndPct === 2, `脉冲门槛：月末涨幅 ≤ ${seasonal.PULSE_RULE.maxEndPct}%`);
check(
  themes.SEASONAL_THEMES.length >= 16,
  `备选题材 ${themes.SEASONAL_THEMES.length} 个（含春节档影视、煤炭、电力、家电、饮料等）`,
);

console.log(failed ? `\n有 ${failed} 项没过` : '\n全部通过');
process.exit(failed ? 1 : 0);
