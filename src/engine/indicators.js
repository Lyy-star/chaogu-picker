'use strict';

/**
 * 纯函数技术指标。输入统一为 kline 的 bars 数组（按时间升序）。
 */

function sma(values, n) {
  if (!values || values.length < n || n <= 0) return null;
  let sum = 0;
  for (let i = values.length - n; i < values.length; i += 1) sum += values[i];
  return sum / n;
}

function highest(values, n) {
  const arr = values.slice(-n).filter((v) => Number.isFinite(v));
  return arr.length ? Math.max(...arr) : null;
}

function lowest(values, n) {
  const arr = values.slice(-n).filter((v) => Number.isFinite(v));
  return arr.length ? Math.min(...arr) : null;
}

/** 平均真实波幅 ATR(n)：衡量日内波动，用于止损和买卖区间 */
function atr(bars, n = 14) {
  if (!bars || bars.length < n + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i += 1) {
    const cur = bars[i];
    const prev = bars[i - 1];
    if (![cur.high, cur.low, prev.close].every(Number.isFinite)) continue;
    trs.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close)));
  }
  if (trs.length < n) return null;
  return sma(trs, n);
}

function pctChange(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return ((to - from) / from) * 100;
}

function round(v, digits = 2) {
  if (!Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/**
 * 把日线压缩成策略需要的指标包。
 * bars 最后一根通常是"今天"（盘中为实时快照合成）。
 */
function buildContext(bars, livePrice) {
  if (!bars || bars.length < 20) return null;
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const volumes = bars.map((b) => b.volume);
  const last = bars[bars.length - 1];
  const price = Number.isFinite(livePrice) ? livePrice : last.close;

  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const atr14 = atr(bars, 14);
  const high20 = highest(highs, 20);
  const high60 = highest(highs, 60);
  const low20 = lowest(lows, 20);
  const low60 = lowest(lows, 60);
  const vol5 = sma(volumes, 5);
  const vol20 = sma(volumes, 20);
  const refClose = bars.length >= 2 ? bars[bars.length - 2].close : null;

  const range = high60 !== null && low60 !== null ? high60 - low60 : null;
  const position = range ? (price - low60) / range : null; // 0=近60日低点 1=近60日高点

  return {
    price,
    ma5: round(ma5),
    ma10: round(ma10),
    ma20: round(ma20),
    ma60: round(ma60),
    atr14: round(atr14),
    atrPct: atr14 && price ? round((atr14 / price) * 100) : null,
    high20: round(high20),
    high60: round(high60),
    low20: round(low20),
    low60: round(low60),
    position: position === null ? null : round(position, 3),
    vol5: vol5 ? Math.round(vol5) : null,
    vol20: vol20 ? Math.round(vol20) : null,
    volRatio5: livePrice && vol5 && last.volume ? round(last.volume / vol5) : null,
    priceVsMa5Pct: ma5 ? round(pctChange(ma5, price)) : null,
    priceVsMa20Pct: ma20 ? round(pctChange(ma20, price)) : null,
    bullStack: [ma5, ma10, ma20].every(Number.isFinite) ? ma5 > ma10 && ma10 > ma20 : null,
    chg5Pct: bars.length > 5 ? round(pctChange(closes[closes.length - 6], price)) : null,
    chg20Pct: bars.length > 20 ? round(pctChange(closes[closes.length - 21], price)) : null,
    toHigh20Pct: high20 ? round(pctChange(price, high20)) : null,
    toLow20Pct: low20 ? round(pctChange(price, low20)) : null,
    lastDate: last.date,
    prevClose: round(refClose),
    bars: bars.length,
  };
}

/** 把实时快照合并成"今天的K线"，避免盘中指标落后一天 */
function mergeLiveBar(bars, quote) {
  if (!bars || !bars.length || !quote || !Number.isFinite(quote.price)) return bars;
  const out = bars.slice();
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
    today.getDate(),
  ).padStart(2, '0')}`;
  const last = out[out.length - 1];

  const bar = {
    date: last.date === todayStr ? last.date : todayStr,
    open: Number.isFinite(quote.open) ? quote.open : last.open,
    close: quote.price,
    high: Number.isFinite(quote.high) ? quote.high : Math.max(last.high, quote.price),
    low: Number.isFinite(quote.low) ? quote.low : Math.min(last.low, quote.price),
    volume: Number.isFinite(quote.volume) ? quote.volume : last.volume,
    amount: Number.isFinite(quote.amount) ? quote.amount : last.amount,
    changePct: quote.changePct,
    turnoverRate: quote.turnoverRate,
  };

  if (last.date === todayStr) out[out.length - 1] = bar;
  else out.push(bar);
  return out;
}

module.exports = { sma, highest, lowest, atr, pctChange, round, buildContext, mergeLiveBar };
