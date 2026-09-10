'use strict';

/** 服务端联调：起服务 -> 打各接口 -> 关掉 */

const cfg = require('../src/config');
const { start } = require('../src/server');

async function hit(path, ms = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const t0 = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.PORT}${path}`, { signal: controller.signal });
    const text = await res.text();
    return { status: res.status, text, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  const server = await start(cfg.PORT);
  console.log(`服务已启动，端口 ${server.address().port}\n`);

  const staticRes = await hit('/');
  console.log(`GET / -> ${staticRes.status} ${staticRes.text.length}B (${staticRes.ms}ms)`);
  const jsRes = await hit('/app.js');
  console.log(`GET /app.js -> ${jsRes.status} ${jsRes.text.length}B`);
  const cssRes = await hit('/styles.css');
  console.log(`GET /styles.css -> ${cssRes.status} ${cssRes.text.length}B`);
  const chartRes = await hit('/charts.js');
  console.log(`GET /charts.js -> ${chartRes.status} ${chartRes.text.length}B`);

  const health = await hit('/api/health');
  console.log(`\n/api/health -> ${health.status} ${health.text.slice(0, 200)}`);

  const overview = await hit('/api/overview');
  if (overview.status === 200) {
    const data = JSON.parse(overview.text).data;
    console.log(`\n/api/overview (${overview.ms}ms)`);
    console.log(`  指数: ${(data.indexes || []).map((i) => `${i.name}${i.changePct}%`).join(' ')}`);
    console.log(`  涨跌家数: ${JSON.stringify(data.breadth)}`);
    console.log(`  情绪: ${JSON.stringify(data.sentiment)}`);
  } else {
    console.log(`\n/api/overview -> ${overview.status} ${overview.text.slice(0, 300)}`);
  }

  const picks = await hit('/api/picks');
  if (picks.status === 200) {
    const data = JSON.parse(picks.text).data;
    console.log(`\n/api/picks (${picks.ms}ms) 引擎耗时 ${data.elapsedMs}ms`);
    console.log(
      `  情绪类 ${data.sentiment.items.length} 条 / 消息类 ${data.news.items.length} 条 / ` +
        `事件类 ${data.event.items.length} 条 / 基本面类 ${(data.fundamental.items || []).length} 条`,
    );
    if (data.fundamental.items && data.fundamental.items.length) {
      const f = data.fundamental.items[0];
      console.log(`  基本面标题: ${data.fundamental.headline}`);
      console.log(
        `  基本面样例: ${f.name} 基本面分${f.fundScore} 合计${f.score} 空间${f.upsidePct}% ` +
          `ROE${f.fundamental && f.fundamental.roe} 户数环比${f.fundamental && f.fundamental.holderNumRatio}%`,
      );
    }
    console.log(`  今日推荐 Top3: ${data.top.slice(0, 3).map((t) => `${t.name}(${t.categoryName})`).join(', ')}`);
    const first = data.top[0];
    if (first) {
      console.log(`  样例: ${first.name} 买入${first.plan.buyZone.low}-${first.plan.buyZone.high} 止损${first.plan.stopLoss} 仓位${first.plan.positionPct}% 胜率${first.plan.winRate}%`);
    }
  } else {
    console.log(`\n/api/picks -> ${picks.status} ${picks.text.slice(0, 400)}`);
  }

  const stock = await hit('/api/stock/600519');
  if (stock.status === 200) {
    const d = JSON.parse(stock.text).data;
    console.log(`\n/api/stock/600519 (${stock.ms}ms)`);
    console.log(`  行情: ${d.quote && d.quote.name} ${d.quote && d.quote.price}`);
    console.log(`  分时点: ${d.trends ? d.trends.points.length : 0} 源=${d.trends && d.trends.source}`);
    console.log(`  日线根数: ${d.kline ? d.kline.bars.length : 0} 源=${d.kline && d.kline.source}`);
    console.log(`  技术: MA5=${d.tech && d.tech.ma5} ATR=${d.tech && d.tech.atr14}`);
    console.log(`  资金流条数: ${d.flow.length} 公告 ${d.announcements.length} 新闻 ${d.news.length}`);
    console.log(
      `  基本面: 报告期 ${d.fundamentals && d.fundamentals.reportDate} ` +
        `ROE ${d.fundamentals && d.fundamentals.performance && d.fundamentals.performance.roe} ` +
        `股东户数 ${d.fundamentals && d.fundamentals.holder && d.fundamentals.holder.holderNum} ` +
        `基金 ${d.fundamentals && d.fundamentals.fundCount} 家`,
    );
    console.log(`  计划: 买${d.plan.buyZone.low}-${d.plan.buyZone.high} 止损${d.plan.stopLoss}`);
  } else {
    console.log(`\n/api/stock/600519 -> ${stock.status} ${stock.text.slice(0, 300)}`);
  }

  const events = await hit('/api/events');
  if (events.status === 200) {
    const d = JSON.parse(events.text).data;
    console.log(`\n/api/events -> ${d.events.length} 个事件`);
    d.events.slice(0, 6).forEach((e) => {
      console.log(`  ${e.date} ${e.name} (${e.daysUntil}天, 影响力${e.level}, ${e.verify ? '待核实' : '已确认'}) -> ${(e.matchedBoards || []).map((b) => b.name).join('/') || '未匹配板块'}`);
    });
  } else {
    console.log(`\n/api/events -> ${events.status} ${events.text.slice(0, 300)}`);
  }

  const pfRes = await hit('/api/portfolio', 180000);
  if (pfRes.status === 200) {
    const d = JSON.parse(pfRes.text).data;
    const a = d.account || {};
    console.log(`\n/api/portfolio (${pfRes.ms}ms) 起始日 ${d.profile.startDate}`);
    console.log(
      `  总资产 ${a.totalAssets} 现金 ${a.cash} 持仓市值 ${a.marketValue} 仓位 ${a.positionRatio}% ` +
        `累计 ${a.cumPnlPct}% 回撤 ${a.drawdownPct}%`,
    );
    console.log(`  记录 ${a.days} 天 / 交易日 ${a.tradeDays} 天，持仓 ${d.holdings.length} 只`);
    for (const h of d.holdings) {
      console.log(`    ${h.name}(${h.code}) ${h.shares}股 成本${h.cost} 现价${h.last} 浮盈${h.floatPnlPct}%`);
    }
    const last = d.today;
    if (last) console.log(`  最近一天 ${last.date} 【${last.status}】${last.summary}`);
  } else {
    console.log(`\n/api/portfolio -> ${pfRes.status} ${pfRes.text.slice(0, 300)}`);
  }

  server.close();
  process.exit(0);
})().catch((err) => {
  console.error('测试失败:', err);
  process.exit(1);
});
