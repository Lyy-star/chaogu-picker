'use strict';

const em = require('../src/data/eastmoney');

(async () => {
  const t0 = Date.now();
  try {
    const s = await em.marketSnapshot({ force: true });
    console.log(`快照 OK: ${s.rows.length}/${s.total} 页数${s.pages} 失败页${s.failedPages} 用时${Date.now() - t0}ms`);
  } catch (err) {
    console.log(`快照 FAIL(${Date.now() - t0}ms): ${err.message}`);
  }

  for (const [name, fn] of [
    ['概念板块涨幅榜', () => em.boardRank('concept', 'change', 60, { force: true })],
    ['概念板块资金榜', () => em.boardRank('concept', 'flow', 60, { force: true })],
    ['个股资金排行', () => em.moneyFlowRank(100, undefined, { force: true })],
    ['情绪温度', () => em.sentimentGauge({ force: true })],
    ['公告第1页', () => em.announcements(1, 100)],
  ]) {
    const t = Date.now();
    try {
      const r = await fn();
      console.log(`${name} OK (${Date.now() - t}ms) 条数=${Array.isArray(r) ? r.length : 'obj'}`);
    } catch (err) {
      console.log(`${name} FAIL (${Date.now() - t}ms): ${err.message}`);
    }
  }
})();
