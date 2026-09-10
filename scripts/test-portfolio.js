'use strict';

/**
 * 模拟盘自检：跑一遍选股 + 每日记账流程，把账户、持仓、流水打印出来。
 * 用法：node scripts/test-portfolio.js [--force]
 */

const picker = require('../src/engine/picker');
const portfolio = require('../src/engine/portfolio');

const FORCE = process.argv.includes('--force');

function money(v) {
  return Number.isFinite(v) ? v.toFixed(2) : '-';
}

(async () => {
  console.log('抓取选股结果…');
  const picks = await picker.pickAll({ force: false }).catch((err) => {
    console.log('选股失败：', err.message);
    return null;
  });
  if (picks) {
    console.log(
      `  基本面 ${picks.fundamental.items.length} / 情绪 ${picks.sentiment.items.length} / ` +
        `消息 ${picks.news.items.length} / 事件 ${picks.event.items.length}，合并推荐 ${picks.top.length} 只`,
    );
  }

  const data = await portfolio.run({ picks, force: FORCE });
  const a = data.account || {};
  console.log('\n=== 账户 ===');
  console.log(`起始本金 ${data.profile.initialCapital}  起始日 ${data.profile.startDate}`);
  console.log(
    `总资产 ${money(a.totalAssets)}  现金 ${money(a.cash)}  持仓市值 ${money(a.marketValue)}  仓位 ${a.positionRatio}%`,
  );
  console.log(
    `今日 ${a.dayPnl >= 0 ? '+' : ''}${money(a.dayPnl)} (${a.dayPnlPct}%)  累计 ${
      a.cumPnl >= 0 ? '+' : ''
    }${money(a.cumPnl)} (${a.cumPnlPct}%)  回撤 ${a.drawdownPct}%`,
  );
  console.log(`记录 ${a.days} 天 / 交易日 ${a.tradeDays} 天  成交价口径：${data.session.priceSource}`);

  console.log('\n=== 当前持仓 ===');
  if (!data.holdings.length) console.log('（空仓）');
  for (const h of data.holdings) {
    console.log(
      `${h.name}(${h.code}) ${h.shares}股 成本 ${h.cost} 现价 ${h.last} 市值 ${money(h.marketValue)} ` +
        `浮盈 ${money(h.floatPnl)} (${h.floatPnlPct}%) 止损 ${h.stopLoss ?? '-'} 目标 ${h.target1 ?? '-'}`,
    );
  }

  console.log('\n=== 每日记录 ===');
  for (const e of data.journal.slice().reverse()) {
    console.log(
      `\n[${e.date} ${e.weekday}] 第${e.dayIndex}天/${e.trading ? `交易日${e.tradeDayIndex}` : '休市'} 【${e.status}】 ` +
        `总资产 ${money(e.totalAssets)} 当日 ${e.dayPnl >= 0 ? '+' : ''}${money(e.dayPnl)}(${e.dayPnlPct}%) ` +
        `累计 ${e.cumPnlPct}% 仓位 ${e.positionRatio}%（${e.priceSource}）`,
    );
    console.log(`  ${e.summary}`);
    for (const t of e.trades || []) {
      console.log(
        `  ${t.side === 'buy' ? '买入' : '卖出'} ${t.name} ${t.shares}股 @${t.price} 金额 ${money(
          t.amount,
        )} 费用 ${money(t.fee)}  理由：${t.reason}`,
      );
    }
  }
  console.log('');
})().catch((err) => {
  console.error('自检失败：', err && err.stack ? err.stack : err);
  process.exit(1);
});
