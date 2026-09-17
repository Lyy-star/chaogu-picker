'use strict';

/**
 * 每日复盘：等龙虎榜数据出来后，回看最近几个交易日的上榜个股，
 * 用"当时能看到的信息"按当前口径打分，再用后来的真实涨跌（D1/D5）检验，
 * 最后按因子的实际表现微调权重——下一次推荐会真的跟着变。
 *
 * 注意：单日样本很小，所以调整是"小步、有上下限、需要最小样本量"的启发式，
 * 不是训练模型，也不保证越调越准。
 */

const shortterm = require('./shortterm');

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function round(v, d = 2) {
  if (!Number.isFinite(v)) return null;
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

function groupByDate(rows) {
  const m = new Map();
  for (const r of rows || []) {
    const d = String(r.TRADE_DATE || '').slice(0, 10);
    if (!d) continue;
    if (!m.has(d)) m.set(d, []);
    m.get(d).push(r);
  }
  return m;
}

function statsOf(rows) {
  const d1 = rows.map((r) => r.d1).filter(Number.isFinite);
  const d5 = rows.map((r) => r.d5).filter(Number.isFinite);
  return {
    count: rows.length,
    d1Samples: d1.length,
    d1Win: d1.length ? round((d1.filter((x) => x > 0).length / d1.length) * 100, 1) : null,
    d1Avg: round(mean(d1), 2),
    d5Samples: d5.length,
    d5Win: d5.length ? round((d5.filter((x) => x > 0).length / d5.length) * 100, 1) : null,
    d5Avg: round(mean(d5), 2),
  };
}

/** 按当前口径回测最近若干交易日的上榜个股 */
function backtest({ boardRows, seatRows, weights, days = 10 }) {
  const byDate = groupByDate(boardRows);
  const dates = [...byDate.keys()].sort().slice(-(days + 1));

  const seatMap = new Map();
  for (const s of seatRows || []) {
    const k = `${s.SECURITY_CODE}|${String(s.TRADE_DATE || '').slice(0, 10)}`;
    if (!seatMap.has(k)) seatMap.set(k, []);
    seatMap.get(k).push(s);
  }

  const all = boardRows || [];
  const entries = [];

  for (const date of dates) {
    for (const row of byDate.get(date) || []) {
      const code = String(row.SECURITY_CODE || '');
      const name = String(row.SECURITY_NAME_ABBR || '');
      if (!shortterm.isMainBoard(code) || shortterm.isST(name)) continue;

      const d1 = Number(row.D1_CLOSE_ADJCHRATE);
      const d5 = Number(row.D5_CLOSE_ADJCHRATE);
      const history = all.filter(
        (r) => String(r.SECURITY_CODE) === code && String(r.TRADE_DATE || '').slice(0, 10) < date,
      );
      const winRate = shortterm.winRateOf(history);
      const seat = shortterm.seatProfile(seatMap.get(`${code}|${date}`) || []);
      const scored = shortterm.scoreBase(row, { winRate, seat, sellSeat: null, weights });

      entries.push({
        date,
        code,
        name,
        score: scored.score,
        verdict: scored.verdict,
        parts: scored.parts,
        d1: Number.isFinite(d1) ? d1 : null,
        d5: Number.isFinite(d5) ? d5 : null,
        limitUp: (Number(row.CHANGE_RATE) || 0) >= 9.8,
      });
    }
  }

  return entries;
}

/** 分档统计 + 因子归因 */
function summarize(entries) {
  const done = (entries || []).filter((e) => Number.isFinite(e.d1) || Number.isFinite(e.d5));
  const ranges = [
    ['重点关注（≥78 分）', 78, 999],
    ['可低吸（66-77 分）', 66, 78],
    ['观察（52-65 分）', 52, 66],
    ['回避（<52 分）', -1, 52],
  ];
  const buckets = ranges.map(([label, min, max]) => ({
    label,
    ...statsOf(done.filter((e) => e.score >= min && e.score < max)),
  }));

  const defs = [
    ['money', '资金面（净买入）'],
    ['seat', '席位（机构 / 活跃游资）'],
    ['win', '历史胜率'],
  ];
  const factors = defs.map(([key, label]) => {
    const rows = done.filter((e) => Number.isFinite(e.parts[key]) && Number.isFinite(e.d5));
    if (rows.length < 8) return { key, label, samples: rows.length, edge: null };
    const sorted = [...rows].sort((a, b) => b.parts[key] - a.parts[key]);
    const cut = Math.max(3, Math.floor(sorted.length * 0.4));
    const high = statsOf(sorted.slice(0, cut));
    const low = statsOf(sorted.slice(-cut));
    return {
      key,
      label,
      samples: rows.length,
      highAvg: high.d5Avg,
      lowAvg: low.d5Avg,
      highWin: high.d5Win,
      lowWin: low.d5Win,
      edge: round((high.d5Avg || 0) - (low.d5Avg || 0), 2),
    };
  });

  const rows5 = done.filter((e) => Number.isFinite(e.d5));
  const upGroup = statsOf(rows5.filter((e) => e.limitUp));
  const flatGroup = statsOf(rows5.filter((e) => !e.limitUp));
  factors.push({
    key: 'limitUp',
    label: '当日涨停上榜',
    samples: rows5.length,
    highAvg: upGroup.d5Avg,
    lowAvg: flatGroup.d5Avg,
    highWin: upGroup.d5Win,
    lowWin: flatGroup.d5Win,
    edge: round((upGroup.d5Avg || 0) - (flatGroup.d5Avg || 0), 2),
  });

  return { total: (entries || []).length, evaluated: done.length, buckets, factors };
}

/** 按因子表现微调权重：小步、有上下限、样本不足就不动 */
function suggestWeights(weights, factors, { minSamples = 40, damp = 0.25, min = 0.1, max = 0.45 } = {}) {
  const usable = (factors || []).filter((f) => Number.isFinite(f.edge) && Number.isFinite(f.samples));
  const samples = usable.reduce((a, f) => a + f.samples, 0);
  if (samples < minSamples) {
    return {
      weights,
      changed: false,
      reason: `这次可评估的样本只有 ${samples} 条（少于 ${minSamples}），权重先不动，免得被一两天的偶然结果带偏。`,
    };
  }

  const maxAbs = Math.max(0.5, ...usable.map((f) => Math.abs(f.edge)));
  const next = { ...weights };
  const moved = [];
  for (const f of usable) {
    if (!(f.key in next)) continue;
    const norm = f.edge / maxAbs;
    next[f.key] = next[f.key] * (1 + damp * norm);
    moved.push({ label: f.label, edge: f.edge, dir: norm >= 0 ? 'up' : 'down' });
  }

  const keys = Object.keys(next);
  const sum1 = keys.reduce((a, k) => a + next[k], 0) || 1;
  for (const k of keys) next[k] = Math.min(max, Math.max(min, next[k] / sum1));
  const sum2 = keys.reduce((a, k) => a + next[k], 0) || 1;
  for (const k of keys) next[k] = Math.round((next[k] / sum2) * 1000) / 1000;

  const delta = {};
  for (const k of keys) delta[k] = round(next[k] - weights[k], 3);

  return {
    weights: next,
    delta,
    moved,
    changed: keys.some((k) => Math.abs(delta[k]) >= 0.005),
    reason: '按「高分组平均 5 日收益 − 低分组平均 5 日收益」排序：表现好的因子小幅加权，表现差的减权，并做上下限约束。',
  };
}

module.exports = { backtest, summarize, suggestWeights, statsOf };
