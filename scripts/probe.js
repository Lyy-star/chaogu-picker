'use strict';

/** 数据源自检：逐个接口打一遍，看哪些可用。 */

const em = require('../src/data/eastmoney');

const tasks = [
  ['个股快照', async () => {
    const q = await em.quote('600519');
    return `${q.name} ${q.price} ${q.changePct}% 换手${q.turnoverRate}% 量比${q.volumeRatio}`;
  }],
  ['批量快照', async () => {
    const m = await em.quotesBatch(['600519', '000001', '601318']);
    return [...m.values()].map((q) => `${q.name}:${q.price}`).join(' | ');
  }],
  ['市场概览', async () => {
    const o = await em.marketOverview({ force: true });
    return `${o.indexes.map((i) => `${i.name}${i.changePct}%`).join(' ')} 涨${o.breadth?.up}跌${o.breadth?.down}`;
  }],
  ['概念板块', async () => {
    const b = await em.boardRank('concept', 'change', 5, { force: true });
    return b.map((x) => `${x.name}${x.changePct}% 主力${(x.mainNetIn / 1e8).toFixed(2)}亿 领涨${x.leaderName}`).join(' | ');
  }],
  ['行业板块(资金)', async () => {
    const b = await em.boardRank('industry', 'flow', 5, { force: true });
    return b.map((x) => `${x.name} 主力${(x.mainNetIn / 1e8).toFixed(2)}亿`).join(' | ');
  }],
  ['板块成分股', async () => {
    const b = await em.boardRank('concept', 'change', 1, { force: true });
    if (!b.length) return '无板块';
    const s = await em.boardStocks(b[0].code, 5, { force: true });
    return `${b[0].name}: ` + s.map((x) => `${x.name}${x.changePct}%`).join(' ');
  }],
  ['主力资金排行', async () => {
    const r = await em.moneyFlowRank(5, undefined, { force: true });
    return r.map((x) => `${x.name} 主力${(x.mainNetIn / 1e8).toFixed(2)}亿 ${x.changePct}%`).join(' | ');
  }],
  ['分时', async () => {
    const t = await em.minuteTrends('600519', 1, { force: true });
    return `昨收${t.preClose} 点数${t.points.length} 最新${t.points.at(-1)?.price}`;
  }],
  ['日线(多源)', async () => {
    const k = await em.kline('600519', { limit: 60 }, { force: true });
    return `源=${k.source} 根数${k.bars.length} 最新${JSON.stringify(k.bars.at(-1))}`;
  }],
  ['个股资金流', async () => {
    const f = await em.stockFlow('600519', { limit: 5 }, { force: true });
    return `条数${f.length} 最新${JSON.stringify(f.at(-1))}`;
  }],
  ['涨停池', async () => {
    const p = await em.pool('zt', new Date(), { force: true });
    return `涨停${p.length}只 最高连板${Math.max(...p.map((x) => x.limitUpCount || 1))} 示例${JSON.stringify(p[0] || {})}`;
  }],
  ['情绪温度', async () => {
    const g = await em.sentimentGauge({ force: true });
    return JSON.stringify(g);
  }],
  ['7x24快讯', async () => {
    const n = await em.newsFlash(1, 5);
    return n.map((x) => `[${x.time.slice(11, 16)}] ${x.title.slice(0, 30)}`).join(' || ');
  }],
  ['主板全量快照', async () => {
    const t0 = Date.now();
    const s = await em.marketSnapshot({ force: true });
    return `行数${s.rows.length}/${s.total} 用时${Date.now() - t0}ms 示例${JSON.stringify(s.rows[0])}`;
  }],
  ['主板涨跌家数', async () => {
    const b = await em.marketBreadth({ force: true });
    return JSON.stringify(b);
  }],
  ['全市场公告', async () => {
    const a = await em.announcements(1, 5);
    return a.map((x) => `${x.date} ${x.codes[0]?.name || ''} ${x.title.slice(0, 26)}`).join(' || ');
  }],
  ['个股新闻搜索', async () => {
    const n = await em.stockNews('贵州茅台', 3);
    return n.map((x) => x.title.slice(0, 30)).join(' || ');
  }],
  ['最新财报期', async () => {
    const [period, valDate] = await Promise.all([em.latestReportPeriod(), em.latestValuationDate()]);
    return `财报期 ${period} / 估值日 ${valDate}`;
  }],
  ['业绩报表(主板)', async () => {
    const period = await em.latestReportPeriod();
    const rows = await em.performanceReport(period);
    const mt = rows.find((r) => r.code === '600519');
    return `${rows.length} 条 | 茅台 ROE${mt?.roe?.toFixed(2)}% 营收同比${mt?.revenueYoy?.toFixed(2)}% 净利同比${mt?.profitYoy?.toFixed(2)}%`;
  }],
  ['股东户数(主板)', async () => {
    const period = await em.latestReportPeriod();
    const rows = await em.holderNumberReport(period);
    const mt = rows.find((r) => r.code === '600519');
    return `${rows.length} 条 | 茅台 ${mt?.holderNum} 户 环比${mt?.holderNumRatio?.toFixed(2)}%`;
  }],
  ['机构持仓(全市场)', async () => {
    const period = await em.latestReportPeriod();
    const rows = await em.orgHoldReport(period);
    const mt = rows.find((r) => r.code === '600519');
    return `${rows.length} 条 | 茅台 ${mt?.orgNum} 家 环比${mt?.orgNumChange}家 占流通${mt?.orgSharesRatio?.toFixed(2)}% 标签${mt?.label}`;
  }],
  ['估值(主板)', async () => {
    const valDate = await em.latestValuationDate();
    const rows = await em.valuationReport(valDate);
    const mt = rows.find((r) => r.code === '600519');
    return `${rows.length} 条 | 茅台 PE${mt?.pe?.toFixed(2)} PB${mt?.pb?.toFixed(2)} 行业${mt?.industry}`;
  }],
  ['主要财务指标(主板)', async () => {
    const period = await em.latestReportPeriod();
    const rows = await em.financeMainReport(period);
    const mt = rows.find((r) => r.code === '600519');
    return `${rows.length} 条 | 茅台 资产负债率${mt?.debtRatio?.toFixed(2)}% 流动比率${mt?.currentRatio?.toFixed(2)} ROIC${mt?.roic?.toFixed(2)}%`;
  }],
  ['F10 股东研究', async () => {
    const d = await em.shareholderResearch('600519');
    return `机构 ${d.orgTotal?.orgCount} 家 / 基金 ${d.fundCount} 家 / 基金明细 ${d.fundHolders.length} 条 / 户数历史 ${d.holderHistory.length} 条`;
  }],
  ['单只基本面快照', async () => {
    const d = await em.stockFundamentalSnapshot('600519');
    return `报告期 ${d.reportDate} ROE ${d.performance?.roe?.toFixed(2)}% 户数 ${d.holder?.holderNum} 机构 ${d.org?.orgNum} 家 PE ${d.valuation?.pe?.toFixed(2)}`;
  }],
];

(async () => {
  for (const [name, fn] of tasks) {
    const t0 = Date.now();
    try {
      const out = await fn();
      console.log(`[OK  ] ${name} (${Date.now() - t0}ms): ${out}`);
    } catch (err) {
      console.log(`[FAIL] ${name} (${Date.now() - t0}ms): ${err.message}`);
    }
  }
})();
