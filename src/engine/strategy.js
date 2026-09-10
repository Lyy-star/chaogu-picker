'use strict';

/**
 * 动态买卖策略。
 *
 * 所有价格都由"实时价 + ATR + 均线 + 近期高低点"现算，不写死。
 * 输出的是一份纪律化的交易计划，不是收益承诺。
 *
 * 关键约定：
 *   买点(buyZone) -> 止损(stopLoss) -> 目标位(targets)
 *   止损幅度、目标幅度一律按"买入均价"计算，而不是按现价。
 *   因为计划本身就是等回踩到 buyZone 才买，用现价算会严重失真。
 */

const { round } = require('./indicators');

const CATEGORY_STYLE = {
  sentiment: { name: '情绪类', atrStop: 1.8, horizon: '短线 1-5 个交易日', maxHold: 5, maxLossPct: 0.07 },
  news: { name: '消息类', atrStop: 2.6, horizon: '波段 2-6 周（跟消息进度）', maxHold: 20, maxLossPct: 0.13 },
  event: { name: '大事件类', atrStop: 2.0, horizon: '事件驱动 1-4 周', maxHold: 20, maxLossPct: 0.09 },
  fundamental: { name: '基本面类', atrStop: 2.4, horizon: '中线 1-3 个月（等基本面兑现）', maxHold: 60, maxLossPct: 0.12 },
};

function tick(v) {
  return Math.round(v * 100) / 100;
}

/**
 * @param {object} args
 * @param {object} args.quote    实时快照
 * @param {object} args.ctx      buildContext 的指标包
 * @param {string} args.category sentiment | news | event
 * @param {number} args.score    综合分 0-100
 * @param {object} args.extra    { leaderName, sentimentLevel, eventDate, eventName }
 */
function buildPlan({ quote, ctx, category = 'sentiment', score = 60, extra = {} }) {
  const style = CATEGORY_STYLE[category] || CATEGORY_STYLE.sentiment;
  const price = Number(quote && quote.price);
  if (!Number.isFinite(price) || price <= 0) return null;

  const atr = Number.isFinite(ctx && ctx.atr14) && ctx.atr14 > 0 ? ctx.atr14 : price * 0.03;
  const ma5 = Number.isFinite(ctx && ctx.ma5) ? ctx.ma5 : price;
  const ma10 = Number.isFinite(ctx && ctx.ma10) ? ctx.ma10 : ma5;
  const ma20 = Number.isFinite(ctx && ctx.ma20) ? ctx.ma20 : ma5;
  const dev = ma5 ? (price - ma5) / ma5 : 0;
  const isLimitUp = Number.isFinite(quote.changePct) && quote.changePct >= 9.7;

  /* ---------------- 买点 ---------------- */
  // 基本面类是中线视角：股价离 5 日线太远时，等回踩的锚点放到 10 日线更合理
  const isFundamental = category === 'fundamental';
  const anchor = isFundamental ? ma10 : ma5;
  const anchorDev = anchor ? (price - anchor) / anchor : dev;
  let planType;
  let center;
  if (isLimitUp) {
    planType = 'limitUp';
    center = anchor;
  } else if (anchorDev > 0.04) {
    planType = 'pullback';
    center = anchor;
  } else if (anchorDev < -0.02) {
    planType = 'dip';
    center = price;
  } else {
    planType = 'now';
    center = price;
  }

  const spread = { limitUp: 0.45, pullback: 0.4, dip: 0.5, now: 0.35 }[planType];
  const buyLow = tick(Math.max(center - spread * atr, price * 0.85));
  const buyHigh = tick(
    planType === 'limitUp' ? center + 0.3 * atr : Math.min(center + 0.25 * atr, price * 1.03),
  );
  const entryMid = (buyLow + buyHigh) / 2;

  /* ---------------- 止损 ---------------- */
  const near5Low = Number.isFinite(ctx && ctx.low20) ? Math.max(ctx.low20, price - 4 * atr) : price - 3 * atr;
  const stopByAtr = center - style.atrStop * atr;
  const stopByLow = near5Low - 0.2 * atr;
  let stopLoss = tick(Math.max(stopByAtr, stopByLow));
  // 单笔最大亏损上限：短线情绪股必须止损更紧
  stopLoss = tick(Math.max(stopLoss, price * (1 - style.maxLossPct)));
  // 止损必须在"买入区间下沿"之下，否则买点与止损自相矛盾
  stopLoss = tick(Math.min(stopLoss, buyLow - 0.2 * atr, price * 0.985));
  stopLoss = tick(Math.max(stopLoss, price * (1 - style.maxLossPct - 0.05), 0.01));

  /* ---------------- 目标位 ---------------- */
  const t1Mult = category === 'event' ? 2.4 : isFundamental ? 3.0 : 2.0;
  const t2Mult = category === 'event' ? 4.2 : isFundamental ? 5.2 : 3.6;
  const t2CapMult = isFundamental ? 8 : 6;
  const t1Atr = price + t1Mult * atr;
  const high20 = Number.isFinite(ctx && ctx.high20) ? ctx.high20 : null;
  // 只有当"前高"确实在现价上方、且没超过 ATR 测算的目标太远时，才把它当第一压力位；
  // 如果股价已经站在前高附近（甚至突破），就按 ATR 延伸测算，否则目标会贴着脸，赔率失真。
  const t1 = tick(
    high20 && high20 > price * 1.02 && high20 < price + (t1Mult + 0.2) * atr ? high20 : t1Atr,
  );
  const t2Atr = price + t2Mult * atr;
  const high60 = Number.isFinite(ctx && ctx.high60) ? ctx.high60 : null;
  // 第二目标同样要封顶，避免出现"+70%"这种不切实际的数字
  const t2 = tick(Math.min(Math.max(t2Atr, high60 || t2Atr), price + t2CapMult * atr));

  const targets = [
    {
      price: t1,
      pct: round(((t1 - entryMid) / entryMid) * 100, 2),
      note: '第一目标：减半仓',
    },
    {
      price: t2,
      pct: round(((t2 - entryMid) / entryMid) * 100, 2),
      note: '第二目标：剩余仓位用移动止盈跟',
    },
  ];

  const stopLossPct = round(((stopLoss - entryMid) / entryMid) * 100, 2);
  const stopLossPctVsPrice = round(((stopLoss - price) / price) * 100, 2);
  const risk = Math.max(entryMid - stopLoss, 0.01);
  const reward = Math.max(t1 - entryMid, 0.01);
  const riskReward = round(reward / risk, 2);

  /* ---------------- 仓位建议 ---------------- */
  let position = score >= 82 ? 30 : score >= 74 ? 22 : score >= 66 ? 15 : 10;
  if (category === 'news') position = Math.min(position, 15); // 消息未证实，仓位封顶
  if (category === 'fundamental') position = Math.min(position, 25); // 中线品种，留出加仓空间
  const sl = extra.sentimentLevel;
  if (sl === '冰点') position = Math.round(position * 0.5);
  else if (sl === '偏冷') position = Math.round(position * 0.7);
  else if (sl === '亢奋') position = Math.round(position * 0.8); // 情绪过热时反而要收敛
  position = Math.max(5, Math.min(position, 30));

  /* ---------------- 卖出纪律（动态文本） ---------------- */
  const sellRules = [];
  if (category === 'sentiment') {
    sellRules.push(`跌破 5 日线 ${round(ma5)} 且 30 分钟收不回 → 先减半仓`);
    sellRules.push('盘中跌破分时均价线并且放量 → 减 1/3 仓');
    sellRules.push(
      `板块龙头${extra.leaderName ? `（${extra.leaderName}）` : ''}炸板，或所属板块跌出主力资金净流入榜 → 清仓，不等反弹`,
    );
    sellRules.push(`触及 ${t1} 减半，剩余仓位用 ${round(ma5)} 做移动止盈`);
    sellRules.push(`持有超过 ${style.maxHold} 个交易日仍未创新高、且成交量萎缩 → 离场`);
  } else if (category === 'news') {
    sellRules.push('公告正式证实（披露预案 / 复牌）当日冲高 → 至少兑现 50%，这是"利好落地"位置');
    sellRules.push('出现澄清、终止、被否公告 → 无条件止损，不等反弹');
    sellRules.push(`跌破 10 日线 ${round(ma10)} → 离场观望`);
    sellRules.push(`持有超过 ${style.maxHold} 个交易日仍无实质性公告进展 → 降到低仓`);
    sellRules.push('重组题材靠"消息定价"，没有新进展本身就是利空');
  } else if (category === 'fundamental') {
    sellRules.push(`下一期财报若营收/净利增速转负、或低于上一期，说明逻辑走坏 → 减半仓`);
    sellRules.push('股东户数连续两期增加（筹码分散）、或机构家数连续两期减少 → 减仓');
    sellRules.push(`跌破 20 日线 ${round(ma20)} 且 3 个交易日内收不回 → 离场，中线逻辑暂时失效`);
    sellRules.push(`估值修复到所属行业 PE 分位 80% 以上（不再便宜）→ 分批兑现`);
    sellRules.push(`触及 ${t1} 减半仓，剩余仓位跟 20 日线移动止盈`);
    sellRules.push(`持有超过 ${style.maxHold} 个交易日基本面没有兑现（业绩/机构仍未改善）→ 换股`);
  } else {
    sellRules.push(
      `事件开幕前 2 个交易日开始减仓（买预期、卖事实）${extra.eventDate ? `，事件日 ${extra.eventDate}` : ''}`,
    );
    sellRules.push('事件落地当天，不论盈亏清掉剩余仓位');
    sellRules.push(`跌破 5 日线 ${round(ma5)} 或触及 ${stopLoss} → 止损`);
    sellRules.push(`触及 ${t1} 减半仓，剩余仓位跟 ${round(ma5)} 移动止盈`);
  }
  sellRules.push(`无条件止损：${stopLoss}（相对买入均价 ${stopLossPct}%），跌破就执行，不找理由`);

  /* ---------------- 买点提示语 ---------------- */
  const anchorName = isFundamental ? '10 日线' : '5 日线';
  const planText = {
    limitUp: `今日已涨停，不追高。明日看是否高开缩量、回踩 ${tick(ma5)} 一带，等分时均价线企稳再进`,
    pullback: `现价高于 ${anchorName} ${round(anchorDev * 100, 1)}%，等回踩 ${tick(center)} 附近（区间 ${buyLow}-${buyHigh}）再买，别追`,
    dip: `股价在 ${anchorName}下方，属于低吸型，可在 ${buyLow}-${buyHigh} 分批接，跌破 ${stopLoss} 就认错`,
    now: `现价贴近 ${anchorName}，可在 ${buyLow}-${buyHigh} 区间分批建仓，不要一次满仓`,
  }[planType];

  /* ---------------- 期望收益（估算，用于排序） ---------------- */
  // 把 0-100 的综合评分保守地映射成"估算胜率"：
  // 50 分 -> 40%，70 分 -> 52%，90 分 -> 64%。
  // 它只是同类机会之间的相对排序，不是统计回测出来的概率。
  const winRate = Math.max(0.4, Math.min(0.68, 0.4 + (score - 50) * 0.006));
  const gainPct = Math.max(0, Math.min((t1 - entryMid) / entryMid, 0.15));
  const lossPct = Math.max(0, (entryMid - stopLoss) / entryMid);
  const expected = winRate * gainPct - (1 - winRate) * lossPct;

  return {
    category: style.name,
    horizon: style.horizon,
    planType,
    planText,
    buyZone: { low: buyLow, high: buyHigh },
    entryMid: tick(entryMid),
    stopLoss,
    stopLossPct,
    stopLossPctVsPrice,
    targets,
    riskReward,
    positionPct: position,
    sellRules,
    winRate: round(winRate * 100, 1),
    expectedPct: round(expected * 100, 2),
    atr: round(atr, 2),
    ma: { ma5: round(ma5), ma10: round(ma10), ma20: round(ma20) },
  };
}

module.exports = { buildPlan, CATEGORY_STYLE };
