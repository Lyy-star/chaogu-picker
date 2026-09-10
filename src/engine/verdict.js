'use strict';

/**
 * 单只股票的「结论」：技术面 + 资金面折成一个评分，并给出中文理由。
 *
 * 推荐列表里给全市场打分用的是 picker 的 technicalScore / fundScore，
 * 这里把同一套口径套到用户自己搜/自选的股票上，两边结论才可比。
 */

const { technicalScore, fundScore } = require('./picker');
const { round } = require('./indicators');

function yi(v) {
  if (!Number.isFinite(v)) return '-';
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(v / 1e4).toFixed(0)}万`;
  return v.toFixed(0);
}

function stanceOf(total) {
  if (total >= 72) return { stance: '强', text: '多项指标共振，属于当前规则下的强势形态' };
  if (total >= 60) return { stance: '偏强', text: '结构与资金面偏正面，可等回踩分批参与' };
  if (total >= 45) return { stance: '中性', text: '多空信号混杂，建议观察或小仓位试仓' };
  return { stance: '偏弱', text: '技术面与资金面都不占优，暂以观望为主' };
}

function buildVerdict({ ctx, quote, mainNetIn, mainNetInPct }) {
  const tech = ctx ? technicalScore(ctx) : null;
  const hasFund = Number.isFinite(mainNetIn) || Number.isFinite(mainNetInPct);
  const fund = hasFund ? fundScore({ mainNetIn, mainNetInPct }) : null;

  const reasons = [];

  if (ctx) {
    if (ctx.bullStack === true) reasons.push('均线多头排列（MA5 > MA10 > MA20），趋势结构完整');
    else if (ctx.bullStack === false) reasons.push('均线还没走成多头，趋势仍在修复中');

    if (Number.isFinite(ctx.priceVsMa5Pct)) {
      if (ctx.priceVsMa5Pct > 12) reasons.push(`股价高出 MA5 达 ${ctx.priceVsMa5Pct}%，短线明显过热，追高风险大`);
      else if (ctx.priceVsMa5Pct > 6) reasons.push(`股价高于 MA5 ${ctx.priceVsMa5Pct}%，短线偏热，等回踩更稳`);
      else if (ctx.priceVsMa5Pct > 0) reasons.push(`站在 MA5 上方 ${ctx.priceVsMa5Pct}%，短线偏强`);
      else reasons.push(`跌破 MA5 ${Math.abs(ctx.priceVsMa5Pct)}%，短线走弱`);
    }

    if (Number.isFinite(ctx.position)) {
      const pos = Math.round(ctx.position * 100);
      if (ctx.position > 0.9) reasons.push('处于近 60 日高位区间，向上空间相对有限');
      else if (ctx.position < 0.25) reasons.push('处于近 60 日低位区间，一旦资金回头弹性较大');
      else reasons.push(`位于近 60 日区间的 ${pos}% 位置`);
    }

    if (Number.isFinite(ctx.volRatio5)) {
      if (ctx.volRatio5 > 2) reasons.push(`当日成交量是 5 日均量的 ${ctx.volRatio5} 倍，放量明显`);
      else if (ctx.volRatio5 < 0.6) reasons.push('量能萎缩，缺乏资金参与');
      else reasons.push(`量能温和（约 5 日均量的 ${ctx.volRatio5} 倍）`);
    }

    if (Number.isFinite(ctx.atrPct) && ctx.atrPct > 6) {
      reasons.push(`日常波动 ATR 达 ${ctx.atrPct}%，属高波动品种，仓位要打折`);
    }
  } else if (quote && quote.price === null) {
    reasons.push('拿不到这只票的行情数据');
  }

  if (Number.isFinite(mainNetInPct) || Number.isFinite(mainNetIn)) {
    const pct = Number.isFinite(mainNetInPct) ? `（占成交额 ${mainNetInPct}%）` : '';
    const net = Number.isFinite(mainNetIn) ? yi(Math.abs(mainNetIn)) : '';
    if (Number.isFinite(mainNetIn) && mainNetIn < 0) {
      reasons.push(`当日主力资金净流出 ${net}${pct}，上涨未必有主力推动`);
    } else if (Number.isFinite(mainNetIn)) {
      reasons.push(`当日主力资金净流入 ${net}${pct}`);
    }
  }

  let total;
  if (tech !== null && fund !== null) total = round(tech * 0.6 + fund * 0.4, 1);
  else if (tech !== null) total = tech;
  else if (fund !== null) total = fund;
  else total = null;

  const { stance, text } = total === null ? { stance: '—', text: '数据不足，无法判断' } : stanceOf(total);

  return {
    total,
    tech,
    fund,
    stance,
    stanceText: text,
    reasons: reasons.slice(0, 6),
  };
}

module.exports = { buildVerdict };
