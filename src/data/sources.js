'use strict';

/**
 * 备用行情源（腾讯 / 新浪）。
 * 用途：东方财富个别接口在部分网络环境下会被重置，这里做多源兜底，
 * 保证"日线 / 分时"这类核心图表永远有数据。
 */

const { getText, getJSON } = require('../lib/http');

function toSymbol(code) {
  const c = String(code).padStart(6, '0');
  return c.startsWith('6') ? `sh${c}` : `sz${c}`;
}

/** 指数代码 -> 行情源符号（上证 000001 是 sh000001，不是深市的平安银行 sz000001） */
const INDEX_SYMBOL = {
  '000001': 'sh000001',
  '399001': 'sz399001',
  '399006': 'sz399006',
};

function toIndexSymbol(code) {
  const c = String(code).padStart(6, '0');
  return INDEX_SYMBOL[c] || (c.startsWith('39') ? `sz${c}` : `sh${c}`);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 腾讯日线（前复权），返回与 eastmoney.kline 相同的结构 */
async function tencentKline(code, limit = 250, period = 'day', options = {}) {
  const symbol = toSymbol(code);
  const key = period === 'week' ? 'qfqweek' : period === 'month' ? 'qfqmonth' : 'qfqday';
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},${period},,,${limit},qfq`;
  const json = await getJSON(url, { timeout: 10000, ...options });
  const node = json && json.data && json.data[symbol];
  if (!node) throw new Error('腾讯日线无数据');
  const rows = node[key] || node[period] || [];
  const bars = rows.map((r) => {
    const [date, open, close, high, low, volume] = r;
    return {
      date: String(date),
      open: num(open),
      close: num(close),
      high: num(high),
      low: num(low),
      volume: num(volume),   // 手
      amount: num(r[6]) || null,
      changePct: null,
      amplitude: null,
      turnoverRate: num(r[7]) || null,
    };
  });
  // 腾讯不返回涨跌幅，自行补齐（图表需要）
  for (let i = 1; i < bars.length; i += 1) {
    const prev = bars[i - 1].close;
    const cur = bars[i].close;
    if (prev && cur) {
      bars[i].changePct = Number((((cur - prev) / prev) * 100).toFixed(2));
      bars[i].change = Number((cur - prev).toFixed(2));
      bars[i].amplitude = Number((((bars[i].high - bars[i].low) / prev) * 100).toFixed(2));
    }
  }
  return { code: String(code), name: '', bars, source: '腾讯财经' };
}

/** 新浪日线（不复权），作为第三兜底 */
async function sinaKline(code, limit = 250) {
  const symbol = toSymbol(code);
  return sinaKlineBySymbol(symbol, limit);
}

/**
 * 新浪日线（按完整符号取，指数也能用）。
 * 上证指数 = sh000001，深证成指 = sz399001。
 */
async function sinaKlineBySymbol(symbol, limit = 250) {
  const url =
    'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData' +
    `?symbol=${symbol}&scale=240&ma=no&datalen=${limit}`;
  const json = await getJSON(url, { timeout: 10000 });
  if (!Array.isArray(json)) throw new Error('新浪日线无数据');
  const bars = json.map((r) => ({
    date: String(r.day),
    open: num(r.open),
    close: num(r.close),
    high: num(r.high),
    low: num(r.low),
    volume: num(r.volume) === null ? null : Math.round(num(r.volume) / 100), // 股 -> 手
    amount: null,
    changePct: null,
    amplitude: null,
    turnoverRate: null,
  }));
  for (let i = 1; i < bars.length; i += 1) {
    const prev = bars[i - 1].close;
    const cur = bars[i].close;
    if (prev && cur) {
      bars[i].changePct = Number((((cur - prev) / prev) * 100).toFixed(2));
      bars[i].amplitude = Number((((bars[i].high - bars[i].low) / prev) * 100).toFixed(2));
    }
  }
  return { code: String(symbol), name: '', bars, source: '新浪财经' };
}

/**
 * 腾讯指数日线（kline/kline 接口，不需要复权参数）。
 * 用来算"交易日历"——成分指数开市的那天，全市场就开市。
 */
async function tencentIndexKline(symbol = 'sh000001', limit = 250) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${symbol},day,,,${limit}`;
  const json = await getJSON(url, { timeout: 10000 });
  const node = json && json.data && json.data[symbol];
  const rows = (node && (node.day || node.qfqday)) || [];
  if (!rows.length) throw new Error('腾讯指数日线无数据');
  const bars = rows.map((r) => {
    const [date, open, close, high, low, volume] = r;
    return {
      date: String(date),
      open: num(open),
      close: num(close),
      high: num(high),
      low: num(low),
      volume: num(volume),
      amount: null,
      changePct: null,
      amplitude: null,
      turnoverRate: null,
    };
  });
  for (let i = 1; i < bars.length; i += 1) {
    const prev = bars[i - 1].close;
    const cur = bars[i].close;
    if (prev && cur) {
      bars[i].changePct = Number((((cur - prev) / prev) * 100).toFixed(2));
      bars[i].amplitude = Number((((bars[i].high - bars[i].low) / prev) * 100).toFixed(2));
    }
  }
  return { code: String(symbol), name: '', bars, source: '腾讯财经' };
}

/** 腾讯分时，返回与 eastmoney.minuteTrends 相同结构 */
async function tencentMinute(code) {
  const symbol = toSymbol(code);
  const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${symbol}`;
  const json = await getJSON(url, { timeout: 10000 });
  const node = json && json.data && json.data[symbol];
  const payload = node && node.data;
  const rows = (payload && payload.data) || [];
  if (!rows.length) throw new Error('腾讯分时无数据');
  const preClose = num(node.qt && node.qt[symbol] && node.qt[symbol][4]);
  let cumAmount = 0;
  const points = rows.map((line) => {
    const [hhmm, price, volume, amount] = String(line).split(' ');
    cumAmount = num(amount) || cumAmount;
    const vol = num(volume);
    return {
      time: `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`,
      price: num(price),
      volume: vol,
      amount: num(amount),
      avg: vol && cumAmount ? Number((cumAmount / (vol * 100)).toFixed(3)) : null,
    };
  });
  return { code: String(code), preClose, points, source: '腾讯财经' };
}

module.exports = {
  tencentKline,
  sinaKline,
  tencentMinute,
  toSymbol,
  toIndexSymbol,
  sinaKlineBySymbol,
  tencentIndexKline,
};
