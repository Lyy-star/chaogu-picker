'use strict';

/**
 * 历史规律（详情页里的“我的看法”）。
 *
 * 原则：只做统计，不做预测，也不编故事。每条结论都能对回原始数据：
 *   - 月度季节性：每个自然月的平均涨跌幅、上涨年份占比、样本年数
 *   - 当前所处位置：现价在历史区间里的分位
 *   - 波动特征：日均绝对波动
 * 最后拼成中文结论，并且带上“样本多少年”这种前提，避免把巧合当规律。
 */

const MONTH_CN = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

function round(v, digits = 2) {
  if (!Number.isFinite(v)) return null;
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  const v = arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(v);
}

/** 按月聚合：月涨幅 = 本月最后收盘 / 上月最后收盘 - 1 */
/**
 * 月线 -> 每个月相对上个月的涨跌幅。
 *
 * 当月那根月线还没走完，它的"月涨幅"其实只是月内涨幅，
 * 混进历史平均里会把规律带偏（半个月涨 3% 和整月涨 3% 不是一回事），
 * 所以默认把当前月剔除。需要看实时的月内涨幅时传 includePartialMonth。
 */
function monthlyReturns(bars, { includePartialMonth = false, now = new Date() } = {}) {
  const byMonth = new Map();
  for (const b of bars || []) {
    const d = String(b && b.date ? b.date : '');
    if (d.length < 7 || !Number.isFinite(b.close)) continue;
    byMonth.set(d.slice(0, 7), {
      close: b.close,
      year: Number(d.slice(0, 4)),
      month: Number(d.slice(5, 7)),
    });
  }

  const keys = [...byMonth.keys()].sort();
  const out = [];
  for (let i = 1; i < keys.length; i += 1) {
    const prev = byMonth.get(keys[i - 1]);
    const cur = byMonth.get(keys[i]);
    if (!prev || !cur || !prev.close) continue;
    out.push({
      key: keys[i],
      year: cur.year,
      month: cur.month,
      pct: ((cur.close - prev.close) / prev.close) * 100,
    });
  }

  if (!includePartialMonth && out.length) {
    const curKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    if (out[out.length - 1].key === curKey) out.pop();
  }
  return out;
}

function monthSummary(rows, month) {
  const picks = rows.filter((r) => r.month === month);
  if (!picks.length) return { month, name: MONTH_CN[month - 1], total: 0 };

  const pcts = picks.map((r) => r.pct);
  const up = picks.filter((r) => r.pct > 0).length;
  const best = picks.reduce((a, b) => (b.pct > a.pct ? b : a));
  const worst = picks.reduce((a, b) => (b.pct < a.pct ? b : a));

  return {
    month,
    name: MONTH_CN[month - 1],
    total: picks.length,
    avgPct: round(mean(pcts), 2),
    winRate: round((up / picks.length) * 100, 1),
    up,
    best: { year: best.year, pct: round(best.pct, 2) },
    worst: { year: worst.year, pct: round(worst.pct, 2) },
  };
}

/** 从最近一次往前数，连续上涨的年数（给“下个月历史上常涨”这种结论用） */
function consecutiveUpYears(rows, month) {
  const picks = rows.filter((r) => r.month === month).sort((a, b) => b.year - a.year);
  let n = 0;
  for (const r of picks) {
    if (r.pct > 0) n += 1;
    else break;
  }
  return n;
}

function analyze(bars, { name, price } = {}) {
  const list = Array.isArray(bars) ? bars.filter((b) => b && Number.isFinite(b.close)) : [];
  if (list.length < 60) {
    return { ok: false, reason: '历史数据太少，暂时算不出规律', notes: [] };
  }

  const monthly = monthlyReturns(list);
  const months = [];
  for (let m = 1; m <= 12; m += 1) months.push(monthSummary(monthly, m));

  const rated = months.filter((x) => x.total >= 2);
  const byAvg = [...rated].sort((a, b) => b.avgPct - a.avgPct);
  const bestMonths = byAvg.slice(0, 3);
  const worstMonths = byAvg.slice(-3).reverse();

  const closes = list.map((b) => b.close);
  const low = Math.min(...closes);
  const high = Math.max(...closes);
  const last = Number.isFinite(price) ? price : closes[closes.length - 1];
  const posPct = high > low ? round(((last - low) / (high - low)) * 100, 1) : null;

  const dailyPct = [];
  for (let i = 1; i < list.length; i += 1) {
    if (list[i - 1].close) {
      dailyPct.push(Math.abs((list[i].close - list[i - 1].close) / list[i - 1].close) * 100);
    }
  }
  const avgDailyMove = round(mean(dailyPct), 2);
  const vol = round(stddev(dailyPct), 2);

  const nowMonth = new Date().getMonth() + 1;
  const nextMonth = nowMonth === 12 ? 1 : nowMonth + 1;
  const cur = monthSummary(monthly, nowMonth);
  const next = monthSummary(monthly, nextMonth);
  const nextUpYears = consecutiveUpYears(monthly, nextMonth);

  const from = list[0].date;
  const to = list[list.length - 1].date;
  const years = new Set(monthly.map((r) => r.year)).size;
  const notes = [];

  notes.push(
    `统计区间 ${from} ~ ${to}，覆盖 ${years} 个年份、${monthly.length} 个月的样本。` +
      '样本越长越可信，短周期里的“规律”很可能是巧合。',
  );

  if (bestMonths.length) {
    const b = bestMonths[0];
    notes.push(
      `历史上最强的是 ${b.name}：平均 ${b.avgPct > 0 ? '+' : ''}${b.avgPct}%，` +
        `${b.total} 年里有 ${b.up} 年上涨（${b.winRate}%）` +
        (b.best ? `，最好的一年 ${b.best.year} 涨 ${b.best.pct}%` : '') +
        '。',
    );
    if (bestMonths[1] && bestMonths[2]) {
      notes.push(
        `其次是 ${bestMonths[1].name}（平均 ${bestMonths[1].avgPct}%、上涨概率 ${bestMonths[1].winRate}%）` +
          `和 ${bestMonths[2].name}（平均 ${bestMonths[2].avgPct}%）。` +
          '这三个月份是它的“季节性顺风期”，可以多留意。',
      );
    }
  }

  if (worstMonths.length) {
    const w = worstMonths[0];
    notes.push(
      `最弱的是 ${w.name}：平均 ${w.avgPct}%、上涨概率只有 ${w.winRate}%` +
        (w.worst ? `，最差的一年 ${w.worst.year} 跌 ${Math.abs(w.worst.pct)}%` : '') +
        '。落到这些月份时，仓位和止损都要更严一点。',
    );
  }

  if (cur.total) {
    notes.push(
      `现在是 ${cur.name}，历史上这个月平均 ${cur.avgPct > 0 ? '+' : ''}${cur.avgPct}%、` +
        `上涨概率 ${cur.winRate}%（${cur.up}/${cur.total}）。` +
        (cur.avgPct >= 0 ? '算是它的相对顺风月，可以正常参与，但照样按计划执行。' : '是它的弱势月，别在这个月把仓位加太重。'),
    );
  }

  if (next.total) {
    notes.push(
      `下个月是 ${next.name}：历史平均 ${next.avgPct > 0 ? '+' : ''}${next.avgPct}%、上涨概率 ${next.winRate}%` +
        (nextUpYears >= 2 ? `，而且已经连续 ${nextUpYears} 年上涨` : '') +
        '。这是我提前布局的参考依据，但别只凭季节性下单。',
    );
  }

  if (posPct !== null) {
    notes.push(
      `现价 ${round(last)} 处在样本区间（${round(low)} ~ ${round(high)}）的 ${posPct}% 分位。` +
        (posPct >= 80
          ? '位置偏高，这个位置买进去，回撤空间往往比上涨空间大。'
          : posPct <= 20
            ? '位置偏低，往下空间相对有限；但低有低的理由，先确认基本面没坏。'
            : '位置居中，性价比一般，等它回到计划区间再说。'),
    );
  }

  if (avgDailyMove !== null) {
    notes.push(
      `波动特征：日均绝对波动 ${avgDailyMove}%（标准差 ${vol}%）。` +
        (avgDailyMove >= 3
          ? '属于很活跃的品种，仓位要按“能扛住一根大阴线”来定。'
          : avgDailyMove >= 1.8
            ? '属于中等偏活跃，止损位别贴太近。'
            : '波动相对温和，适合按均线做波段。'),
    );
  }

  return {
    ok: true,
    name: name || '',
    from,
    to,
    years,
    sampleMonths: monthly.length,
    months,
    bestMonths,
    worstMonths,
    current: cur,
    next,
    position: { pct: posPct, low: round(low), high: round(high), price: round(last) },
    volatility: { avgDailyMove, stddev: vol },
    notes,
  };
}

module.exports = { analyze, monthlyReturns, monthSummary, consecutiveUpYears, MONTH_CN };
