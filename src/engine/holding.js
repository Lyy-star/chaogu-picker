'use strict';

/**
 * 持仓建议引擎（纯计算，不联网）。
 *
 * 输入：实时行情 + 技术上下文 + 交易计划 + 用户填的持股 / 成本 / 可用资金
 * 输出：现在该做什么（可以加仓 / 减仓止盈 / 清仓止损 / 继续持有 / 等回踩），
 *       以及"具体多少股、大概多少钱"。
 *
 * 买卖点全部沿用 strategy.buildPlan 算出来的区间和价位，
 * 和推荐列表、自选页是同一套口径；这里只负责把它和"你的持仓"对上。
 */

const LOT = 100; // A 股买入必须是 100 股整数倍
const DEFAULT_ADD_RATIO = 0.3; // 一次加仓默认动用可用资金的 30%
const MIN_SCORE_TO_ADD = 55; // 低于这个分不再加仓（宁可不做）
const COST_STOP_LOSS_PCT = -8; // 相对成本的纪律止损线

function lotFloor(shares) {
  const n = Math.floor((Number(shares) || 0) / LOT) * LOT;
  return n > 0 ? n : 0;
}

function round(v, digits = 2) {
  if (!Number.isFinite(v)) return null;
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

function noneResult(price) {
  return {
    action: 'none',
    actionText: '数据不足',
    level: 'info',
    lot: 0,
    amount: 0,
    price: Number.isFinite(price) ? price : null,
    profitPct: null,
    marketValue: null,
    reasons: [],
    triggers: [],
  };
}

/**
 * @param {object} p
 * @param {object} p.quote   实时快照
 * @param {object} p.ctx     技术上下文（buildContext）
 * @param {object} p.plan    交易计划（buildPlan）
 * @param {object} p.verdict 综合结论（buildVerdict）
 * @param {object} p.trends  当日分时（取最新点位的均价）
 * @param {number} p.shares  持有股数
 * @param {number} p.cost    持仓成本价
 * @param {number} p.cash    可用资金
 * @param {number} p.addRatio 一次加仓动用可用资金的比例
 */
function buildAdvice({ quote, ctx, plan, verdict, trends, shares, cost, cash, addRatio } = {}) {
  const price = Number(quote && quote.price);
  const held = Math.max(0, Math.round(Number(shares) || 0));
  const costPrice = Number(cost) > 0 ? Number(cost) : null;
  const money = Math.max(0, Number(cash) || 0);
  const ratio = Number.isFinite(Number(addRatio)) && Number(addRatio) > 0 ? Number(addRatio) : DEFAULT_ADD_RATIO;

  if (!Number.isFinite(price) || price <= 0 || !plan || !plan.buyZone) return noneResult(price);

  const zone = plan.buyZone;
  const t1 = plan.targets && plan.targets[0];
  const t2 = plan.targets && plan.targets[1];
  const stopLoss = Number.isFinite(Number(plan.stopLoss)) ? Number(plan.stopLoss) : null;
  const profitPct = costPrice ? round(((price - costPrice) / costPrice) * 100, 2) : null;
  const marketValue = held ? round(price * held, 2) : 0;
  const score = Number.isFinite(Number(verdict && verdict.total)) ? Number(verdict.total) : null;

  const lastTrend = trends && Array.isArray(trends.points) && trends.points.length
    ? trends.points[trends.points.length - 1]
    : null;
  const avg = lastTrend && Number.isFinite(Number(lastTrend.avg)) ? Number(lastTrend.avg) : null;

  const base = {
    action: 'hold',
    actionText: '继续持有',
    level: 'info',
    lot: 0,
    amount: 0,
    price,
    profitPct,
    marketValue,
    zone: { low: zone.low, high: zone.high },
    stopLoss,
    reasons: [],
    triggers: [],
  };

  const trendNote = avg
    ? (price >= avg
      ? `现价 ${round(price)} 在分时均价 ${round(avg)} 上方，日内买盘占优`
      : `现价 ${round(price)} 低于分时均价 ${round(avg)}，日内偏弱，别急着加`)
    : null;

  /* ---------------- 1. 止损：最高优先级 ---------------- */
  if (stopLoss && price <= stopLoss) {
    return {
      ...base,
      action: 'exit',
      actionText: '清仓止损',
      level: 'alert',
      lot: held,
      amount: round(price * held, 2),
      reasons: [
        `现价 ${round(price)} 已跌破计划的止损位 ${round(stopLoss)}`,
        profitPct === null ? '' : `相对你的成本 ${round(costPrice)}，当前 ${profitPct > 0 ? '+' : ''}${profitPct}%`,
        '规则里止损是一次性执行的：先把仓位砍掉，再等下一次机会，不在这里讲成本',
      ].filter(Boolean),
      triggers: [`止损位 ${round(stopLoss)}`, '跌破即执行'],
    };
  }

  /* ---------------- 2. 成本纪律止损 ---------------- */
  if (costPrice && profitPct !== null && profitPct <= COST_STOP_LOSS_PCT) {
    return {
      ...base,
      action: 'exit',
      actionText: '止损离场',
      level: 'alert',
      lot: held,
      amount: round(price * held, 2),
      reasons: [
        `你的成本 ${round(costPrice)}，现价 ${round(price)}，浮亏 ${profitPct}%`,
        `亏损已超过纪律线 ${COST_STOP_LOSS_PCT}%，继续拿着只是等更大的亏损`,
        '如果还想拿着，就先减半仓把风险砍掉，剩下的当作观察仓',
      ],
      triggers: [`成本止损线 ${COST_STOP_LOSS_PCT}%`],
    };
  }

  /* ---------------- 3. 止盈：第二目标留底仓 ---------------- */
  if (t2 && price >= t2.price && held > 0) {
    const keep = lotFloor(held * 0.25);
    const sell = held - keep;
    return {
      ...base,
      action: 'trim',
      actionText: '减仓止盈（到第二目标）',
      level: 'alert',
      lot: sell > 0 ? sell : 0,
      amount: round(price * (sell > 0 ? sell : 0), 2),
      reasons: [
        `现价 ${round(price)} 已到第二目标 ${round(t2.price)}（+${round(t2.pct)}%）`,
        keep > 0
          ? `建议卖出 ${sell} 股，留 ${keep} 股底仓用移动止盈跟`
          : `持仓只有 ${held} 股，建议一次性卖出`,
        '目标是"卖在过程中"而不是卖在最高点，剩下的仓位用 5 日线跟',
      ],
      triggers: [`第二目标 ${round(t2.price)}`],
    };
  }

  /* ---------------- 4. 止盈：第一目标减半 ---------------- */
  if (t1 && price >= t1.price && held > 0) {
    const half = lotFloor(held / 2);
    const sell = half > 0 ? half : held;
    return {
      ...base,
      action: 'trim',
      actionText: '减仓止盈（到第一目标）',
      level: 'alert',
      lot: sell,
      amount: round(price * sell, 2),
      reasons: [
        `现价 ${round(price)} 已到第一目标 ${round(t1.price)}（+${round(t1.pct)}%）`,
        `建议先卖 ${sell} 股（约 ${round(price * sell, 2)} 元），把利润落袋一半`,
        '剩下的仓位继续拿，跌破 5 日线再走',
      ],
      triggers: [`第一目标 ${round(t1.price)}`],
    };
  }

  /* ---------------- 5. 加仓：回踩到买入区间 ---------------- */
  const inZone = price >= zone.low && price <= zone.high;
  const belowZone = price < zone.low;
  const scoreOk = score === null || score >= MIN_SCORE_TO_ADD;

  if (inZone && scoreOk) {
    const budget = money * ratio;
    const lot = lotFloor(budget / price);
    const canAdd = lot >= LOT;
    const reasons = [
      `现价 ${round(price)} 落在计划的买入区间 ${round(zone.low)} - ${round(zone.high)} 内`,
      score === null ? '' : `当前综合评分 ${score}（${verdict.stance}），技术面/资金面支持继续参与`,
      avg ? trendNote : '',
    ].filter(Boolean);

    if (canAdd) {
      reasons.push(
        `按可用资金 ${round(money)} 的 ${Math.round(ratio * 100)}% 算，可加 ${lot} 股（约 ${round(budget)} 元）`,
      );
      if (stopLoss) {
        const risk = round((price - stopLoss) * lot, 2);
        reasons.push(`加仓后到止损位的风险敞口约 ${risk} 元，能接受再动手`);
      }
      return {
        ...base,
        action: 'add',
        actionText: '可以加仓',
        level: 'alert',
        lot,
        amount: round(price * lot, 2),
        reasons,
        triggers: [`买入区间 ${round(zone.low)} - ${round(zone.high)}`, `评分 ${score}`],
      };
    }

    reasons.push(
      money > 0
        ? `可用资金 ${round(money)} 元不够买一手（${round(price * LOT)} 元），先别动`
        : '还没填"可用资金"，填上我才能算加多少股',
    );
    return { ...base, action: 'wait', actionText: '区间内但资金不够一手', level: 'info', reasons, triggers: [] };
  }

  if (belowZone) {
    return {
      ...base,
      action: 'wait',
      actionText: '跌破买点，等企稳',
      level: 'info',
      reasons: [
        `现价 ${round(price)} 已经低于计划买入区间下沿 ${round(zone.low)}`,
        stopLoss ? `再往下到 ${round(stopLoss)} 就是止损位，别在这里硬接` : '趋势没企稳之前，加仓等于摊平亏损',
        trendNote || '',
      ].filter(Boolean),
      triggers: [`区间下沿 ${round(zone.low)}`],
    };
  }

  /* ---------------- 6. 价格在区间上方：等回踩 ---------------- */
  const gapPct = round(((price - zone.high) / zone.high) * 100, 2);
  return {
    ...base,
    action: 'wait',
    actionText: '价高，等回踩',
    level: 'info',
    reasons: [
      `现价 ${round(price)} 比买入区间上沿（${round(zone.high)}）还高 ${gapPct}%`,
      '追高的代价是止损位被迫拉远，等回到区间里再加更划算',
      score === null ? '' : `当前评分 ${score}（${verdict.stance}）`,
      trendNote || '',
    ].filter(Boolean),
    triggers: [`买入区间上沿 ${round(zone.high)}`],
  };
}

module.exports = { buildAdvice, LOT };
