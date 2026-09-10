'use strict';

const { pickAll } = require('../src/engine/picker');

(async () => {
  const t0 = Date.now();
  const res = await pickAll({ perCategory: 5 });
  console.log(`总耗时 ${Date.now() - t0}ms / 引擎内部 ${res.elapsedMs}ms\n`);

  for (const key of ['fundamental', 'sentiment', 'news', 'event']) {
    const cat = res[key];
    console.log(`\n===== ${cat.categoryName} =====`);
    console.log(`标题：${cat.headline}`);
    if (cat.error) console.log(`错误：${cat.error}`);
    for (const it of cat.items) {
      console.log(
        `\n${it.name}(${it.code}) ${it.price} ${it.changePct}% 评分${it.score} 胜率${it.winRate}% 期望${it.expectedPct}%`,
      );
      console.log(`  买入区间 ${it.plan?.buyZone?.low}-${it.plan?.buyZone?.high} | 止损 ${it.plan?.stopLoss}(${it.plan?.stopLossPct}%) | 目标 ${it.plan?.targets?.map((t) => t.price).join('/')} | 仓位${it.plan?.positionPct}% | 盈亏比${it.plan?.riskReward}`);
      console.log(`  买点：${it.plan?.planText}`);
      for (const r of it.reasons) console.log(`  理由：${r}`);
      for (const risk of it.risks) console.log(`  风险：${risk}`);
    }
  }
})();
