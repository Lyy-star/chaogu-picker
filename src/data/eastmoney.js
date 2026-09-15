'use strict';

/**
 * 东方财富公开行情接口封装。
 * 只依赖 Node 内置 fetch，无需 API Key。
 * 所有函数返回"已归一化"的对象，界面层不接触原始字段名。
 */

const { getJSON, mapLimit } = require('../lib/http');
const { cached } = require('../lib/cache');
const mirror = require('../lib/mirror');
const cfg = require('../config');
const backup = require('./sources');

const UT = 'fa5fd1943c7b386f172d6893dbfba10b';
const PUSH2 = 'https://push2.eastmoney.com/api/qt';
const PUSH2HIS = 'https://push2his.eastmoney.com/api/qt';
const PUSH2EX = 'https://push2ex.eastmoney.com';
const NEWS_API = 'https://np-listapi.eastmoney.com/comm/web/getFastNewsList';
const ANN_API = 'https://np-anotice-stock.eastmoney.com/api/security/ann';

/**
 * 统一出口：push2 / push2his / push2ex 走镜像池自动故障切换，
 * 其他域名（公告、快讯）直接请求。
 */
function emJSON(url, options) {
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return getJSON(url, options);
  }
  let pool = null;
  if (u.hostname.includes('push2his')) pool = 'push2his';
  else if (u.hostname.includes('push2ex')) pool = 'push2ex';
  else if (u.hostname.includes('push2')) pool = 'push2';
  if (!pool) return getJSON(url, options);
  return mirror.poolGetJSON(pool, `${u.pathname}${u.search}`, options);
}

/** 6 位代码 -> 东方财富 secid（1=沪市，0=深市） */
function toSecid(code) {
  const c = String(code).padStart(6, '0');
  const market = c.startsWith('6') ? 1 : 0;
  return `${market}.${c}`;
}

function secidToCode(secid) {
  return String(secid).split('.')[1] || '';
}

function num(v) {
  if (v === null || v === undefined || v === '-' || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function ymd(date = new Date()) {
  const d = new Date(date);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function diffRows(json) {
  const diff = json && json.data && json.data.diff;
  if (!diff) return [];
  return Array.isArray(diff) ? diff : Object.values(diff);
}

/* ------------------------------------------------------------------ */
/* 行情                                                                */
/* ------------------------------------------------------------------ */

const QUOTE_FIELDS = [
  'f43', 'f44', 'f45', 'f46', 'f47', 'f48', 'f50', 'f57', 'f58', 'f60',
  'f107', 'f116', 'f117', 'f162', 'f167', 'f168', 'f169', 'f170', 'f171',
].join(',');

/** 列表型接口（clist / ulist）用的是 f2/f3/f12/f14 这套字段编号 */
// f24 = 60 个交易日涨跌幅（判断"有没有启动"用，省掉一次 K 线请求）
const LIST_FIELDS = 'f2,f3,f4,f5,f6,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f23,f24,f62,f184';

function normalizeListRow(r) {
  return {
    code: String(r.f12 || ''),
    name: String(r.f14 || ''),
    price: num(r.f2),
    changePct: num(r.f3),
    change: num(r.f4),
    volume: num(r.f5),
    amount: num(r.f6),
    turnoverRate: num(r.f8),
    pe: num(r.f9),
    volumeRatio: num(r.f10),
    high: num(r.f15),
    low: num(r.f16),
    open: num(r.f17),
    preClose: num(r.f18),
    marketCap: num(r.f20),
    floatCap: num(r.f21),
    pb: num(r.f23),
    change60Pct: num(r.f24),
    mainNetIn: num(r.f62),
    mainNetInPct: num(r.f184),
  };
}

function normalizeQuote(d) {
  const price = num(d.f43);
  const preClose = num(d.f60);
  let changePct = num(d.f170);
  if (changePct === null && price !== null && preClose) {
    changePct = ((price - preClose) / preClose) * 100;
  }
  return {
    code: String(d.f57 || ''),
    name: String(d.f58 || ''),
    price,
    preClose,
    open: num(d.f46),
    high: num(d.f44),
    low: num(d.f45),
    changePct,
    change: num(d.f169),
    amplitude: num(d.f171),
    volume: num(d.f47),
    amount: num(d.f48),
    turnoverRate: num(d.f168),
    volumeRatio: num(d.f50),
    marketCap: num(d.f116),
    floatCap: num(d.f117),
    pe: num(d.f162),
    pb: num(d.f167),
  };
}

/** 单只个股实时快照 */
async function quote(code, options = {}) {
  const secid = toSecid(code);
  return cached(`q_${secid}`, cfg.CACHE_TTL.quote, async () => {
    const url = `${PUSH2}/stock/get?ut=${UT}&invt=2&fltt=2&secid=${secid}&fields=${QUOTE_FIELDS}`;
    const json = await emJSON(url);
    const d = json && json.data;
    if (!d) return null;
    return normalizeQuote(d);
  }, options);
}

/** 批量快照 */
async function quotesBatch(codes) {
  const list = [...new Set(codes.map((c) => String(c).padStart(6, '0')))];
  const out = new Map();
  const chunks = [];
  for (let i = 0; i < list.length; i += 40) chunks.push(list.slice(i, i + 40));

  await mapLimit(chunks, 3, async (chunk) => {
    const secids = chunk.map(toSecid).join(',');
    const url = `${PUSH2}/ulist.np/get?ut=${UT}&invt=2&fltt=2&secids=${secids}&fields=${LIST_FIELDS}`;
    const json = await emJSON(url);
    for (const row of diffRows(json)) {
      const q = normalizeListRow(row);
      if (q.code) out.set(q.code, q);
    }
  });
  return out;
}

/**
 * 最新行情时间（f86 = 最后一笔行情的时间戳）。
 * 用它判断"今天到底有没有开市"——比猜节假日靠谱：
 * 交易日 15:00 之后 f86 会变成当天，节假日则一直停在上一个交易日。
 */
async function marketClock(options = {}) {
  return cached(
    'market_clock',
    20 * 1000,
    async () => {
      const probes = ['1.000001', '1.600519', '0.000001'];
      for (const secid of probes) {
        try {
          const url = `${PUSH2}/stock/get?ut=${UT}&invt=2&fltt=2&secid=${secid}&fields=f12,f14,f43,f86,f170`;
          const json = await emJSON(url, { timeout: 6000 });
          const d = json && json.data;
          const ts = num(d && d.f86);
          if (!ts) continue;
          const t = new Date(ts * 1000 + 8 * 3600 * 1000);
          const p = (n) => String(n).padStart(2, '0');
          return {
            at: ts * 1000,
            date: `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`,
            time: `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`,
            index: {
              name: '上证指数',
              price: num(d.f43),
              changePct: num(d.f170),
            },
            source: '东方财富',
          };
        } catch (_) {
          /* 换下一个探针 */
        }
      }
      return null;
    },
    { disk: false, ...options },
  );
}

/** 市场概览：三大指数 */
async function marketOverview(options = {}) {
  return cached('market_overview', 20 * 1000, async () => {
    const secids = ['1.000001', '0.399001', '0.399006'].join(',');
    const url = `${PUSH2}/ulist.np/get?ut=${UT}&invt=2&fltt=2&secids=${secids}&fields=f2,f3,f4,f6,f12,f13,f14`;
    const json = await emJSON(url);
    const list = diffRows(json).map((r) => ({
      code: String(r.f12),
      name: String(r.f14),
      price: num(r.f2),
      changePct: num(r.f3),
      change: num(r.f4),
      amount: num(r.f6),
    }));
    return { indexes: list, at: Date.now() };
  }, options);
}

/**
 * 全主板快照（约 3500 只，分页并发拉取，缓存 60 秒）。
 * 有了它，选股引擎不需要再逐只请求，既快又不触发限流。
 */
async function marketSnapshot(options = {}) {
  const PAGE = 100;
  const CONCURRENCY = 3;
  const maxPages = cfg.SELECT.snapshotPages || Infinity;

  return cached('snapshot_main_board', cfg.CACHE_TTL.snapshot, async () => {
    const fetchPage = async (pn) => {
      const url =
        `${PUSH2}/clist/get?ut=${UT}&invt=2&fltt=2&np=1&pn=${pn}&pz=${PAGE}&po=1&fid=f3` +
        `&fs=${encodeURIComponent(cfg.EM_MAIN_BOARD_FS)}&fields=${LIST_FIELDS}`;
      const json = await emJSON(url);
      return { rows: diffRows(json), total: num(json && json.data && json.data.total) || 0 };
    };

    const first = await fetchPage(1);
    const totalPages = Math.max(1, Math.ceil(first.total / PAGE));
    const pages = Math.min(totalPages, maxPages);
    const rest = pages > 1
      ? await mapLimit(Array.from({ length: pages - 1 }, (_, i) => i + 2), CONCURRENCY, (pn) => fetchPage(pn))
      : [];

    const all = [...first.rows];
    let failed = 0;
    for (const page of rest) {
      if (page && page.rows && page.rows.length) all.push(...page.rows);
      else failed += 1;
    }
    if (all.length < first.total * 0.5) {
      throw new Error(`行情快照抓取不足（${all.length}/${first.total}），请稍后重试`);
    }

    const rows = all
      .filter((r) => String(r.f12 || '').length === 6)
      .map(normalizeListRow)
      .filter((r) => cfg.BOARD.mainBoardPattern.test(r.code));

    return { rows, total: first.total, pages, failedPages: failed, partial: failed > 0, at: Date.now() };
  }, { disk: true, ...options });
}

/** 主板涨跌家数 */
async function marketBreadth(options = {}) {
  const snap = await marketSnapshot(options);
  let up = 0;
  let down = 0;
  let flat = 0;
  for (const r of snap.rows) {
    if (r.changePct === null) { flat += 1; continue; }
    if (r.changePct > 0) up += 1;
    else if (r.changePct < 0) down += 1;
    else flat += 1;
  }
  return { up, down, flat, total: snap.rows.length, partial: snap.partial, at: snap.at };
}

/* ------------------------------------------------------------------ */
/* 板块                                                                */
/* ------------------------------------------------------------------ */

const BOARD_TYPES = { concept: 'm:90+t:3', industry: 'm:90+t:2' };

/** 板块排行：sortBy = change | flow | amount */
async function boardRank(type = 'concept', sortBy = 'change', size = 60, options = {}) {
  const fs = BOARD_TYPES[type] || BOARD_TYPES.concept;
  const fid = { change: 'f3', flow: 'f62', amount: 'f6' }[sortBy] || 'f3';
  const key = `board_${type}_${sortBy}_${size}`;
  return cached(key, cfg.CACHE_TTL.board, async () => {
    const fields = 'f1,f2,f3,f4,f6,f8,f12,f14,f62,f104,f105,f128,f136,f140,f141,f207,f208,f222';
    const url = `${PUSH2}/clist/get?ut=${UT}&invt=2&fltt=2&np=1&pn=1&pz=${size}&po=1&fid=${fid}&fs=${encodeURIComponent(
      fs,
    )}&fields=${fields}`;
    const json = await emJSON(url);
    return diffRows(json).map((r) => ({
      code: String(r.f12 || ''),
      name: String(r.f14 || ''),
      changePct: num(r.f3),
      amount: num(r.f6),
      turnoverRate: num(r.f8),
      mainNetIn: num(r.f62),
      upCount: num(r.f104),
      downCount: num(r.f105),
      leaderName: r.f128 ? String(r.f128) : '',
      leaderChangePct: num(r.f136),
      leaderCode: r.f140 ? String(r.f140) : '',
    }));
  }, options);
}

/** 板块成分股 */
async function boardStocks(boardCode, size = 60, options = {}) {
  const key = `board_stocks_${boardCode}_${size}`;
  return cached(key, cfg.CACHE_TTL.board, async () => {
    const fields = 'f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f14,f15,f16,f17,f18,f20,f21,f22,f23,f24,f25,f62,f184';
    const url = `${PUSH2}/clist/get?ut=${UT}&invt=2&fltt=2&np=1&pn=1&pz=${size}&po=1&fid=f3&fs=${encodeURIComponent(
      `b:${boardCode}`,
    )}&fields=${fields}`;
    const json = await emJSON(url);
    return diffRows(json).map((r) => ({
      code: String(r.f12 || ''),
      name: String(r.f14 || ''),
      price: num(r.f2),
      changePct: num(r.f3),
      change: num(r.f4),
      volume: num(r.f5),
      amount: num(r.f6),
      amplitude: num(r.f7),
      turnoverRate: num(r.f8),
      pe: num(r.f9),
      volumeRatio: num(r.f10),
      high: num(r.f15),
      low: num(r.f16),
      open: num(r.f17),
      preClose: num(r.f18),
      floatCap: num(r.f21),
      mainNetIn: num(r.f62),
      mainNetInPct: num(r.f184),
    }));
  }, options);
}

/** 个股主力资金流排行（主板），用于"资金热点" */
async function moneyFlowRank(size = 80, boards = cfg.EM_MAIN_BOARD_FS, options = {}) {
  const key = `flow_rank_${size}_${boards}`;
  return cached(key, cfg.CACHE_TTL.board, async () => {
    const fields = 'f2,f3,f6,f8,f12,f14,f62,f66,f69,f72,f75,f78,f81,f84,f87,f184';
    const url = `${PUSH2}/clist/get?ut=${UT}&invt=2&fltt=2&np=1&pn=1&pz=${size}&po=1&fid=f62&fs=${encodeURIComponent(
      boards,
    )}&fields=${fields}`;
    const json = await emJSON(url);
    return diffRows(json).map((r) => ({
      code: String(r.f12 || ''),
      name: String(r.f14 || ''),
      price: num(r.f2),
      changePct: num(r.f3),
      amount: num(r.f6),
      turnoverRate: num(r.f8),
      mainNetIn: num(r.f62),
      mainNetInPct: num(r.f184),
      superNetIn: num(r.f66),
      bigNetIn: num(r.f72),
    }));
  }, options);
}

/* ------------------------------------------------------------------ */
/* 分时 / 日线 / 资金流历史                                             */
/* ------------------------------------------------------------------ */

/** 当日分时（含均价线），东财失败时自动切腾讯 */
async function minuteTrends(code, days = 1, options = {}) {
  const secid = toSecid(code);
  const key = `trends_${secid}_${days}`;
  return cached(key, cfg.CACHE_TTL.trends, async () => {
    try {
      const url =
        `${PUSH2HIS}/stock/trends2/get?ut=${UT}&iscr=0&iscca=0&ndays=${days}&secid=${secid}` +
        '&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13' +
        '&fields2=f51,f52,f53,f54,f55,f56,f57,f58';
      const json = await emJSON(url);
      const d = json && json.data;
      if (!d || !(d.trends || []).length) throw new Error('东财分时无数据');
      const points = (d.trends || []).map((line) => {
        const p = String(line).split(',');
        return {
          time: String(p[0]).slice(11),
          price: num(p[2]),
          high: num(p[3]),
          low: num(p[4]),
          volume: num(p[5]),
          amount: num(p[6]),
          avg: num(p[7]),
        };
      });
      return { code: String(code), preClose: num(d.preClose), points, source: '东方财富' };
    } catch (_) {
      return backup.tencentMinute(code);
    }
  }, options);
}

/** 日线 / 周线 / 月线，多源兜底：东方财富 -> 腾讯 -> 新浪 */
// 东方财富的日线接口在部分网络下会被重置。连续失败后先"熔断" 10 分钟，
// 直接走备用源，避免每个股票都白等一次超时。
let klineDownUntil = 0;

async function kline(code, { klt = 101, limit = 250, fqt = 1 } = {}, options = {}) {
  const secid = toSecid(code);
  const key = `kline_${secid}_${klt}_${limit}_${fqt}`;
  return cached(key, cfg.CACHE_TTL.kline, async () => {
    try {
      if (Date.now() < klineDownUntil) throw new Error('东方财富日线接口熔断中');
      const url =
        `${PUSH2HIS}/stock/kline/get?ut=${UT}&secid=${secid}&klt=${klt}&fqt=${fqt}&end=20500101&lmt=${limit}` +
        '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61';
      const json = await emJSON(url, { timeout: 6000 });
      const d = json && json.data;
      if (!d || !(d.klines || []).length) throw new Error('东财日线为空');
      const bars = (d.klines || []).map((line) => {
        const p = String(line).split(',');
        return {
          date: p[0],
          open: num(p[1]),
          close: num(p[2]),
          high: num(p[3]),
          low: num(p[4]),
          volume: num(p[5]),
          amount: num(p[6]),
          amplitude: num(p[7]),
          changePct: num(p[8]),
          change: num(p[9]),
          turnoverRate: num(p[10]),
        };
      });
      return { code: String(d.code || code), name: String(d.name || ''), bars, source: '东方财富' };
    } catch (_) {
      klineDownUntil = Date.now() + 10 * 60 * 1000;
      const period = klt === 102 ? 'week' : klt === 103 ? 'month' : 'day';
      try {
        return await backup.tencentKline(code, limit, period);
      } catch (_) {
        // 新浪的接口只有日线：拿日线冒充周线/月线会算出完全错误的统计量，
        // 所以非日线周期宁可失败，也不要返回错的数据。
        if (period !== 'day') throw new Error(`东方财富和腾讯的${period === 'month' ? '月' : '周'}线都取不到`);
        return backup.sinaKline(code, limit);
      }
    }
  }, options);
}

/**
 * 月线（季节性统计用）。
 *
 * 东方财富的月线接口在不少网络下会先超时 6 秒才失败，几十只票一起算就是几分钟，
 * 所以这里反过来：先问腾讯（快且稳），失败了再退东方财富。月线一天只变一次，缓存 6 小时。
 */
let monthSource = 'tencent'; // 记住哪家的月线好用（两家都时不时抽风，别每次都白等一遍）
let monthPrimaryFails = 0;

async function monthlyKline(code, limit = 120, options = {}) {
  const secid = toSecid(code);
  // 月线一天最多变一次，缓存 24 小时，避免反复去上游拉几十只票
  return cached(`mkline_${secid}_${limit}`, 24 * 60 * 60 * 1000, async () => {
    const viaTencent = () => backup.tencentKline(code, limit, 'month', { timeout: 4000 });
    const viaEm = async () => {
      const url =
        `${PUSH2HIS}/stock/kline/get?ut=${UT}&secid=${secid}&klt=103&fqt=1&end=20500101&lmt=${limit}` +
        '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61';
      const json = await emJSON(url, { timeout: 5000 });
      const d = json && json.data;
      if (!d || !(d.klines || []).length) throw new Error('东财月线为空');
      return {
        code: String(d.code || code),
        name: String(d.name || ''),
        source: '东方财富',
        bars: (d.klines || []).map((line) => {
          const p = String(line).split(',');
          return {
            date: p[0],
            open: num(p[1]),
            close: num(p[2]),
            high: num(p[3]),
            low: num(p[4]),
            volume: num(p[5]),
            amount: num(p[6]),
          };
        }),
      };
    };

    const primary = monthSource === 'tencent' ? ['tencent', viaTencent] : ['em', viaEm];
    const secondary = monthSource === 'tencent' ? ['em', viaEm] : ['tencent', viaTencent];

    try {
      const out = await primary[1]();
      if (!out || !out.bars || !out.bars.length) throw new Error('月线为空');
      monthPrimaryFails = 0;
      return out;
    } catch (errPrimary) {
      // 首选连续失败两次就换另一家当首选，避免每次都白等一遍超时
      monthPrimaryFails += 1;
      if (monthPrimaryFails >= 2) {
        monthSource = secondary[0];
        monthPrimaryFails = 0;
      }
      try {
        const out2 = await secondary[1]();
        if (!out2 || !out2.bars || !out2.bars.length) throw new Error('月线为空');
        monthSource = secondary[0];
        monthPrimaryFails = 0;
        return out2;
      } catch (_) {
        throw errPrimary;
      }
    }
  }, options);
}

/** 指数日线（交易日历 + 大盘快照用）。东方财富不稳时自动切腾讯 / 新浪 */
const INDEX_SECID = { '000001': '1.000001', '399001': '0.399001', '399006': '0.399006' };
let indexKlineDownUntil = 0;

async function indexKline(code = '000001', { klt = 101, limit = 300 } = {}, options = {}) {
  const c = String(code).padStart(6, '0');
  const key = `idxk_${c}_${klt}_${limit}`;
  return cached(key, cfg.CACHE_TTL.kline, async () => {
    if (Date.now() >= indexKlineDownUntil) {
      try {
        const secid = INDEX_SECID[c] || `1.${c}`;
        const url =
          `${PUSH2HIS}/stock/kline/get?ut=${UT}&secid=${secid}&klt=${klt}&fqt=1&end=20500101&lmt=${limit}` +
          '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61';
        const json = await emJSON(url, { timeout: 6000 });
        const d = json && json.data;
        if (!d || !(d.klines || []).length) throw new Error('东财指数日线为空');
        const bars = (d.klines || []).map((line) => {
          const p = String(line).split(',');
          return {
            date: p[0],
            open: num(p[1]),
            close: num(p[2]),
            high: num(p[3]),
            low: num(p[4]),
            volume: num(p[5]),
            amount: num(p[6]),
            changePct: num(p[8]),
          };
        });
        return { code: c, name: String(d.name || ''), bars, source: '东方财富' };
      } catch (_) {
        indexKlineDownUntil = Date.now() + 10 * 60 * 1000;
      }
    }
    const symbol = backup.toIndexSymbol(c);
    try {
      return await backup.tencentIndexKline(symbol, limit);
    } catch (_) {
      return backup.sinaKlineBySymbol(symbol, limit);
    }
  }, { disk: true, ...options });
}

/** 个股主力资金流历史（日线） */
async function stockFlow(code, { klt = 101, limit = 60 } = {}, options = {}) {
  const secid = toSecid(code);
  const key = `sflow_${secid}_${klt}_${limit}`;
  return cached(key, cfg.CACHE_TTL.flow, async () => {
    const url =
      `${PUSH2HIS}/stock/fflow/daykline/get?ut=${UT}&secid=${secid}&klt=${klt}&lmt=${limit}` +
      '&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65';
    const json = await emJSON(url);
    const d = json && json.data;
    if (!d) return [];
    return (d.klines || []).map((line) => {
      const p = String(line).split(',');
      return {
        date: p[0],
        mainNetIn: num(p[1]),
        smallNetIn: num(p[2]),
        midNetIn: num(p[3]),
        bigNetIn: num(p[4]),
        superNetIn: num(p[5]),
      };
    });
  }, options);
}

/* ------------------------------------------------------------------ */
/* 情绪：涨停 / 跌停 / 炸板池                                           */
/* ------------------------------------------------------------------ */

async function pool(kind, date = new Date(), options = {}) {
  const map = {
    zt: ['getTopicZTPool', 'wz.ztzt'],
    dt: ['getTopicDTPool', 'wz.dtzt'],
    zb: ['getTopicZBPool', 'wz.zbt'],
  };
  const [api, dpt] = map[kind] || map.zt;
  const day = ymd(date);
  const key = `pool_${kind}_${day}`;
  return cached(key, cfg.CACHE_TTL.ztpool, async () => {
    const url = `${PUSH2EX}/${api}?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=${dpt}&Pageindex=0&pagesize=200&sort=fbt%3Aasc&date=${day}`;
    const json = await emJSON(url);
    const rows = (json && json.data && json.data.pool) || [];
    return rows.map((r) => ({
      code: String(r.c || ''),
      name: String(r.n || ''),
      price: num(r.p) === null ? null : num(r.p) / 1000,
      changePct: num(r.zdp),
      amount: num(r.amount),
      floatCap: num(r.ltsz),
      turnoverRate: num(r.hs),
      limitUpCount: num(r.lbc),
      firstSealTime: r.fbt ? String(r.fbt) : '',
      lastSealTime: r.lbt ? String(r.lbt) : '',
      sealFund: num(r.fund),
      openTimes: num(r.zbc),
      industry: r.hybk ? String(r.hybk) : '',
    }));
  }, options);
}

/** 市场情绪温度 */
async function sentimentGauge(options = {}) {
  return cached('sentiment_gauge', 60 * 1000, async () => {
    const [zt, dt, zb] = await Promise.all([
      pool('zt', new Date(), options).catch(() => []),
      pool('dt', new Date(), options).catch(() => []),
      pool('zb', new Date(), options).catch(() => []),
    ]);
    const maxStreak = zt.reduce((m, r) => Math.max(m, r.limitUpCount || 1), 0);
    const sealRate = zt.length + zb.length > 0 ? zt.length / (zt.length + zb.length) : null;
    let level = '中性';
    let score = 55;
    if (zt.length >= 80) { level = '亢奋'; score = 85; }
    else if (zt.length >= 50) { level = '偏暖'; score = 70; }
    else if (zt.length >= 25) { level = '中性'; score = 55; }
    else if (zt.length >= 10) { level = '偏冷'; score = 38; }
    else { level = '冰点'; score = 22; }
    if (maxStreak >= 5) score += 5;
    if (sealRate !== null && sealRate < 0.6) score -= 10;
    score = Math.max(0, Math.min(100, score));
    return {
      limitUp: zt.length,
      limitDown: dt.length,
      brokenLimit: zb.length,
      maxStreak,
      sealRate,
      level,
      score,
      at: Date.now(),
    };
  }, options);
}

/* ------------------------------------------------------------------ */
/* 消息面：7x24 快讯 + 公告                                             */
/* ------------------------------------------------------------------ */

/**
 * 7x24 快讯。该接口用 sortEnd 游标翻页（不是页码），
 * 所以这里串行往下翻，并把结果缓存在一起。
 */
async function newsFlash(pageIndex = 1, pageSize = 50) {
  const key = `news_${pageIndex}_${pageSize}`;
  return cached(key, cfg.CACHE_TTL.news, async () => {
    const pages = Math.max(1, pageIndex);
    let sortEnd = '';
    const out = [];
    for (let i = 0; i < pages; i += 1) {
      const url =
        `${NEWS_API}?client=web&biz=web_724&fastColumn=102&sortEnd=${encodeURIComponent(sortEnd)}` +
        `&pageSize=${pageSize}&req_trace=${Date.now()}`;
      const json = await emJSON(url);
      const data = (json && json.data) || {};
      const list = data.fastNewsList || [];
      for (const r of list) {
        out.push({
          code: String(r.code || ''),
          time: String(r.showTime || ''),
          title: String(r.title || '').trim(),
          summary: String(r.summary || '').trim(),
          url: r.code ? `https://finance.eastmoney.com/a/${r.code}.html` : '',
          stocks: (r.stockList || []).map((s) => ({ code: String(s.code || ''), name: String(s.name || '') })),
          source: '东方财富 7x24',
        });
      }
      if (!data.sortEnd) break;
      sortEnd = data.sortEnd;
    }
    return out;
  });
}

/** 全市场公告；传 stockCode 则查单只个股公告 */
async function announcements(pageIndex = 1, pageSize = 100, stockCode = '') {
  const key = `ann_${stockCode || 'all'}_${pageIndex}_${pageSize}`;
  return cached(key, cfg.CACHE_TTL.ann, async () => {
    const stockPart = stockCode ? `&stock_list=${stockCode}` : '';
    const url =
      `${ANN_API}?sr=-1&page_size=${pageSize}&page_index=${pageIndex}&ann_type=A&client_source=web` +
      `${stockPart}&f_node=0&s_node=0`;
    const json = await emJSON(url);
    const list = (json && json.data && json.data.list) || [];
    return list.map((r) => {
      const codes = (r.codes || []).map((c) => ({
        code: String(c.stock_code || ''),
        name: String(c.short_name || ''),
      }));
      return {
        artCode: String(r.art_code || ''),
        title: String(r.title || '').trim(),
        date: String(r.notice_date || '').slice(0, 10),
        codes,
        columns: (r.columns || []).map((c) => String(c.column_name || '')),
        url: r.art_code && codes[0]
          ? `https://data.eastmoney.com/notices/detail/${codes[0].code}/${r.art_code}.html`
          : '',
      };
    });
  });
}

/** 个股近期新闻（东财搜索接口） */
async function stockNews(keyword, pageSize = 10) {
  const key = `snews_${keyword}_${pageSize}`;
  return cached(key, cfg.CACHE_TTL.news, async () => {
    const param = {
      uid: '',
      keyword,
      type: ['cmsArticleWebOld'],
      client: 'web',
      clientType: 'web',
      clientVersion: 'curr',
      param: {
        cmsArticleWebOld: {
          searchScope: 'default',
          sort: 'default',
          pageIndex: 1,
          pageSize,
          preTag: '<em>',
          postTag: '</em>',
        },
      },
    };
    const url = `https://search-api-web.eastmoney.com/search/jsonp?cb=cb&param=${encodeURIComponent(
      JSON.stringify(param),
    )}`;
    const json = await emJSON(url);
    const list = (json && json.result && json.result.cmsArticleWebOld) || [];
    return list.map((r) => ({
      title: String(r.title || '').replace(/<\/?em>/g, ''),
      summary: String(r.content || '').replace(/<\/?em>/g, '').slice(0, 200),
      time: String(r.date || ''),
      url: String(r.url || ''),
      source: String(r.mediaName || ''),
    }));
  });
}

/* ------------------------------------------------------------------ */
/* 基本面：财报 / 股东户数 / 机构与基金持仓 / 估值                        */
/* ------------------------------------------------------------------ */

const DC_WEB_API = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const DC_SEC_API = 'https://datacenter.eastmoney.com/securities/api/data/v1/get';
const F10_API = 'https://emweb.securities.eastmoney.com/PC_HSF10';

/**
 * 东方财富数据中心报表查询。
 * securities=true 走 F10 专用域名（主要财务指标等），否则走 datacenter-web。
 */
async function dcQuery(reportName, opts = {}) {
  const {
    filter = '',
    sortColumns = '',
    sortTypes = '-1',
    pageNumber = 1,
    pageSize = 500,
    columns = 'ALL',
    securities = false,
  } = opts;
  const params = new URLSearchParams();
  params.set('reportName', reportName);
  params.set('columns', columns);
  params.set('pageNumber', String(pageNumber));
  params.set('pageSize', String(pageSize));
  params.set('source', securities ? 'HSF10' : 'WEB');
  params.set('client', securities ? 'PC' : 'WEB');
  if (filter) params.set('filter', filter);
  if (sortColumns) {
    params.set('sortColumns', sortColumns);
    params.set('sortTypes', sortTypes);
  }
  const json = await getJSON(`${securities ? DC_SEC_API : DC_WEB_API}?${params}`, { timeout: 20000 });
  if (!json || json.success === false) {
    throw new Error((json && json.message) || `${reportName} 接口返回失败`);
  }
  const r = json.result || {};
  return { rows: r.data || [], count: num(r.count) || 0, pages: num(r.pages) || 1 };
}

/** 数据中心报表翻页取全量（每页 500 条，最多 maxPages 页） */
async function dcQueryAll(reportName, opts = {}) {
  const { maxPages = 40, concurrency = 3, pageSize = 500, ...rest } = opts;
  const first = await dcQuery(reportName, { ...rest, pageNumber: 1, pageSize });
  const totalPages = Math.min(
    Math.max(1, Math.ceil((first.count || first.rows.length || 1) / pageSize)),
    maxPages,
  );
  if (totalPages <= 1) return first.rows;
  const restPages = await mapLimit(
    Array.from({ length: totalPages - 1 }, (_, i) => i + 2),
    concurrency,
    (pn) => dcQuery(reportName, { ...rest, pageNumber: pn, pageSize }),
  );
  const out = [...first.rows];
  for (const page of restPages) {
    if (page && page.rows && page.rows.length) out.push(...page.rows);
  }
  return out;
}

const toPct = (v) => {
  const n = num(v);
  return n === null ? null : Math.round(n * 10000) / 10000;
};

const toDay = (v) => (v ? String(v).slice(0, 10) : null);

/** 最新财报期（业绩报表里最新的一期，如 2026-06-30） */
async function latestReportPeriod(options = {}) {
  return cached('fund_period', 6 * 3600 * 1000, async () => {
    const { rows } = await dcQuery('RPT_LICO_FN_CPD', {
      columns: 'REPORTDATE',
      sortColumns: 'REPORTDATE',
      sortTypes: '-1',
      pageSize: 1,
    });
    return toDay(rows[0] && rows[0].REPORTDATE);
  }, { disk: true, ...options });
}

/** 最新估值交易日（估值报表里最新的一天） */
async function latestValuationDate(options = {}) {
  return cached('fund_val_date', 30 * 60 * 1000, async () => {
    const { rows } = await dcQuery('RPT_VALUEANALYSIS_DET', {
      columns: 'TRADE_DATE',
      sortColumns: 'TRADE_DATE',
      sortTypes: '-1',
      pageSize: 1,
    });
    return toDay(rows[0] && rows[0].TRADE_DATE);
  }, { disk: true, ...options });
}

/**
 * 全市场业绩报表（单期）：营收/净利增速、ROE、毛利率、EPS、每股经营现金流。
 * 一次拿全市场，避免逐只请求。
 */
async function performanceReport(reportDate, options = {}) {
  const key = `fund_perf_${reportDate}`;
  return cached(key, 6 * 3600 * 1000, async () => {
    const rows = await dcQueryAll('RPT_LICO_FN_CPD', {
      columns:
        'SECURITY_CODE,SECURITY_NAME_ABBR,REPORTDATE,TRADE_MARKET,BASIC_EPS,DEDUCT_BASIC_EPS,BPS,' +
        'WEIGHTAVG_ROE,TOTAL_OPERATE_INCOME,PARENT_NETPROFIT,YSTZ,SJLTZ,XSMLL,MGJYXJJE,NOTICE_DATE',
      // 只取主板，能把分页数从 23 页压到 7 页
      filter: `(REPORTDATE='${reportDate}')${cfg.EM_MAIN_BOARD_MARKET}`,
    });
    return rows
      .map((r) => ({
        code: String(r.SECURITY_CODE || ''),
        name: String(r.SECURITY_NAME_ABBR || ''),
        market: String(r.TRADE_MARKET || ''),
        reportDate: toDay(r.REPORTDATE),
        noticeDate: toDay(r.NOTICE_DATE),
        eps: num(r.BASIC_EPS),
        bps: num(r.BPS),
        roe: num(r.WEIGHTAVG_ROE),
        revenue: num(r.TOTAL_OPERATE_INCOME),
        netProfit: num(r.PARENT_NETPROFIT),
        revenueYoy: num(r.YSTZ),
        profitYoy: num(r.SJLTZ),
        grossMargin: num(r.XSMLL),
        ocfPerShare: num(r.MGJYXJJE),
      }))
      .filter((r) => /^\d{6}$/.test(r.code));
  }, { disk: true, ...options });
}

/** 股东户数（单期）：户数变化率、户均持股市值，用来判断筹码集中/分散 */
async function holderNumberReport(endDate, options = {}) {
  const key = `fund_holder_${endDate}`;
  return cached(key, 6 * 3600 * 1000, async () => {
    const rows = await dcQueryAll('RPT_HOLDERNUM_DET', {
      columns:
        'SECURITY_CODE,SECURITY_NAME_ABBR,END_DATE,PRE_END_DATE,HOLDER_NUM,PRE_HOLDER_NUM,' +
        'HOLDER_NUM_CHANGE,HOLDER_NUM_RATIO,AVG_MARKET_CAP,AVG_HOLD_NUM,TOTAL_MARKET_CAP,' +
        'CLOSE_PRICE,HOLD_NOTICE_DATE,CHANGE_REASON',
      filter: `(END_DATE='${endDate}')${cfg.EM_MAIN_BOARD_MARKET}`,
    });
    return rows
      .map((r) => ({
        code: String(r.SECURITY_CODE || ''),
        name: String(r.SECURITY_NAME_ABBR || ''),
        endDate: toDay(r.END_DATE),
        prevEndDate: toDay(r.PRE_END_DATE),
        holderNum: num(r.HOLDER_NUM),
        prevHolderNum: num(r.PRE_HOLDER_NUM),
        holderNumChange: num(r.HOLDER_NUM_CHANGE),
        holderNumRatio: toPct(r.HOLDER_NUM_RATIO),
        avgMarketCap: num(r.AVG_MARKET_CAP),
        avgHoldNum: num(r.AVG_HOLD_NUM),
        closePrice: num(r.CLOSE_PRICE),
        noticeDate: toDay(r.HOLD_NOTICE_DATE),
        changeReason: r.CHANGE_REASON ? String(r.CHANGE_REASON) : '',
      }))
      .filter((r) => /^\d{6}$/.test(r.code));
  }, { disk: true, ...options });
}

/** 机构持仓（单期）：机构家数、家数变化、持股占流通股比例、标签（机构新进/增持/减持） */
async function orgHoldReport(reportDate, options = {}) {
  const key = `fund_org_${reportDate}`;
  return cached(key, 6 * 3600 * 1000, async () => {
    const rows = await dcQueryAll('RPT_F10_MAIN_ORGHOLD', {
      columns: 'ALL',
      filter: `(REPORT_DATE='${reportDate}')`,
      sortColumns: 'TOTAL_ORG_NUM_CHANGE',
      sortTypes: '-1',
    });
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      const code = String(r.SECURITY_CODE || '');
      if (!/^\d{6}$/.test(code) || seen.has(code)) continue;
      seen.add(code);
      out.push({
        code,
        name: String(r.SECURITY_NAME_ABBR || ''),
        reportDate: toDay(r.REPORT_DATE),
        orgNum: num(r.TOTAL_ORG_NUM),
        orgNumChange: num(r.TOTAL_ORG_NUM_CHANGE),
        orgSharesRatio: num(r.TOTAL_SHARES_RATIO),
        ratioChange: num(r.CHANGE_RATIO),
        ratioChangePct: num(r.CHANGE_RATIO_CHANGE),
        orgMarketCap: num(r.TOTAL_MARKET_CAP),
        label: r.LABEL_NAME ? String(r.LABEL_NAME) : '',
        isIncrease: num(r.IS_INCREASE),
      });
    }
    return out;
  }, { disk: true, ...options });
}

/** 估值（单交易日）：PE / PB / PS / PEG + 所属行业，用于行业内的相对贵贱 */
async function valuationReport(tradeDate, options = {}) {
  const key = `fund_val_${tradeDate}`;
  return cached(key, 60 * 60 * 1000, async () => {
    const rows = await dcQueryAll('RPT_VALUEANALYSIS_DET', {
      columns:
        'SECURITY_CODE,SECURITY_NAME_ABBR,BOARD_NAME,TRADE_DATE,TOTAL_MARKET_CAP,CLOSE_PRICE,' +
        'PE_TTM,PE_LAR,PB_MRQ,PCF_OCF_TTM,PS_TTM,PEG_CAR,TOTAL_SHARES,FREE_SHARES_A',
      filter: `(TRADE_DATE='${tradeDate}')${cfg.EM_MAIN_BOARD_TRADE}`,
    });
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      const code = String(r.SECURITY_CODE || '');
      if (!/^\d{6}$/.test(code) || seen.has(code)) continue;
      seen.add(code);
      out.push({
        code,
        name: String(r.SECURITY_NAME_ABBR || ''),
        industry: String(r.BOARD_NAME || ''),
        tradeDate: toDay(r.TRADE_DATE),
        marketCap: num(r.TOTAL_MARKET_CAP),
        close: num(r.CLOSE_PRICE),
        pe: num(r.PE_TTM),
        peLar: num(r.PE_LAR),
        pb: num(r.PB_MRQ),
        pcf: num(r.PCF_OCF_TTM),
        ps: num(r.PS_TTM),
        peg: num(r.PEG_CAR),
      });
    }
    return out;
  }, { disk: true, ...options });
}

/**
 * 主要财务指标（单期）：资产负债率、流动比率、ROIC 等。
 * 按 A 股口径全市场一次拉取。
 */
async function financeMainReport(reportDate, options = {}) {
  const key = `fund_main_${reportDate}`;
  return cached(key, 6 * 3600 * 1000, async () => {
    const rows = await dcQueryAll('RPT_F10_FINANCE_MAINFINADATA', {
      columns:
        'SECURITY_CODE,SECURITY_NAME_ABBR,REPORT_DATE,ROEJQ,ROIC,XSMLL,ZCFZL,LD,SD,' +
        'TOTALOPERATEREVETZ,PARENTNETPROFITTZ,MGJYXJJE,EPSJB,BPS',
      filter: `(REPORT_DATE='${reportDate}')(SECURITY_TYPE_CODE="058001001")`,
      securities: true,
      maxPages: 20,
    });
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      const code = String(r.SECURITY_CODE || '');
      if (!/^\d{6}$/.test(code) || seen.has(code)) continue;
      seen.add(code);
      out.push({
        code,
        reportDate: toDay(r.REPORT_DATE),
        roe: num(r.ROEJQ),
        roic: num(r.ROIC),
        grossMargin: num(r.XSMLL),
        debtRatio: num(r.ZCFZL),
        currentRatio: num(r.LD),
        quickRatio: num(r.SD),
      });
    }
    return out;
  }, { disk: true, ...options });
}

/** 6 位代码 -> F10 的带市场前缀代码（如 SH600519 / SZ000001） */
function toF10Code(code) {
  const c = String(code).padStart(6, '0');
  if (/^(6|9)/.test(c)) return `SH${c}`;
  if (/^(4|8)/.test(c)) return `BJ${c}`;
  return `SZ${c}`;
}

/** 6 位代码 -> 带市场后缀代码（如 600519.SH） */
function toSecuCode(code) {
  const c = String(code).padStart(6, '0');
  if (/^(6|9)/.test(c)) return `${c}.SH`;
  if (/^(4|8)/.test(c)) return `${c}.BJ`;
  return `${c}.SZ`;
}

const ORG_TYPE_NAMES = {
  '00': '机构合计',
  '01': '基金',
  '02': 'QFII',
  '03': '社保',
  '04': '券商',
  '05': '保险',
  '06': '信托',
  '07': '其他机构',
};

/** F10 股东研究：机构持仓（分类型）+ 基金持仓明细 + 股东户数历史 */
async function shareholderResearch(code, options = {}) {
  const c = String(code).padStart(6, '0');
  const key = `f10_holder_${c}`;
  return cached(key, 6 * 3600 * 1000, async () => {
    const url = `${F10_API}/ShareholderResearch/PageAjax?code=${toF10Code(c)}`;
    const json = await getJSON(url, {
      timeout: 15000,
      headers: { Referer: 'https://emweb.securities.eastmoney.com/' },
    });
    if (!json) throw new Error('F10 股东研究接口无数据');

    const jgcc = (json.jgcc || []).slice();
    const latestDate = jgcc.length && jgcc[0].REPORT_DATE ? toDay(jgcc[0].REPORT_DATE) : null;
    const latest = jgcc.filter((r) => toDay(r.REPORT_DATE) === latestDate);
    const orgTypes = latest.map((r) => ({
      type: String(r.ORG_TYPE || ''),
      typeName: ORG_TYPE_NAMES[String(r.ORG_TYPE || '')] || `类型${r.ORG_TYPE}`,
      orgCount: num(r.TOTAL_ORG_NUM),
      sharesRatio: num(r.TOTAL_SHARES_RATIO),
      freeShares: num(r.TOTAL_FREE_SHARES),
    }));
    const total = orgTypes.find((t) => t.type === '00') || orgTypes[0] || null;
    const fund = orgTypes.find((t) => t.type === '01') || null;

    const fundHolders = (json.jjcg || [])
      .filter((r) => !latestDate || toDay(r.REPORT_DATE) === latestDate)
      .slice(0, 10)
      .map((r) => ({
        name: String(r.HOLDER_NAME || ''),
        fundCompany: String(r.PARENT_ORG_NAME || ''),
        shares: num(r.TOTAL_SHARES),
        marketCap: num(r.FREE_MARKET_CAP) ?? num(r.HOLD_VALUE),
        sharesRatio: num(r.TOTALSHARES_RATIO),
        netValueRatio: num(r.NETVALUE_RATIO),
      }));

    const holderHistory = (json.gdrs || []).slice(0, 8).map((r) => ({
      endDate: toDay(r.END_DATE),
      holderNum: num(r.HOLDER_TOTAL_NUM),
      holderNumRatio: num(r.TOTAL_NUM_RATIO),
      avgHoldShares: num(r.AVG_FREE_SHARES),
      avgHoldAmount: num(r.AVG_HOLD_AMT),
      focus: r.HOLD_FOCUS ? String(r.HOLD_FOCUS) : '',
    }));

    return {
      code: c,
      reportDate: latestDate,
      orgTypes,
      orgTotal: total,
      fundCount: fund ? fund.orgCount : null,
      fundRatio: fund ? fund.sharesRatio : null,
      fundHolders,
      holderHistory,
      at: Date.now(),
    };
  }, { disk: false, ...options });
}

/**
 * 单只股票的基本面快照：业绩 / 股东户数 / 机构持仓 / 估值 / 主要财务指标。
 * 都按"代码过滤 + 倒序取最新一条"，不依赖全市场报表，详情页可以随点随取。
 */
async function stockFundamentalSnapshot(code, options = {}) {
  const c = String(code).padStart(6, '0');
  const key = `fund_one_${c}`;
  return cached(key, 60 * 60 * 1000, async () => {
    const filter = `(SECURITY_CODE="${c}")`;
    const [perf, holder, org, val, main] = await Promise.all([
      dcQuery('RPT_LICO_FN_CPD', {
        columns: 'ALL',
        filter,
        sortColumns: 'REPORTDATE',
        sortTypes: '-1',
        pageSize: 1,
      }).catch(() => ({ rows: [] })),
      dcQuery('RPT_HOLDERNUM_DET', {
        columns: 'ALL',
        filter,
        sortColumns: 'END_DATE',
        sortTypes: '-1',
        pageSize: 2,
      }).catch(() => ({ rows: [] })),
      dcQuery('RPT_F10_MAIN_ORGHOLD', {
        columns: 'ALL',
        filter,
        sortColumns: 'REPORT_DATE',
        sortTypes: '-1',
        pageSize: 2,
      }).catch(() => ({ rows: [] })),
      dcQuery('RPT_VALUEANALYSIS_DET', {
        columns: 'ALL',
        filter,
        sortColumns: 'TRADE_DATE',
        sortTypes: '-1',
        pageSize: 1,
      }).catch(() => ({ rows: [] })),
      dcQuery('RPT_F10_FINANCE_MAINFINADATA', {
        columns: 'ALL',
        filter: `(SECUCODE="${toSecuCode(c)}")`,
        sortColumns: 'REPORT_DATE',
        sortTypes: '-1',
        pageSize: 1,
        securities: true,
      }).catch(() => ({ rows: [] })),
    ]);

    const p = perf.rows[0] || null;
    const h = holder.rows[0] || null;
    const o = org.rows[0] || null;
    const v = val.rows[0] || null;
    const m = main.rows[0] || null;

    return {
      code: c,
      reportDate: p ? toDay(p.REPORTDATE) : null,
      performance: p
        ? {
            reportDate: toDay(p.REPORTDATE),
            noticeDate: toDay(p.NOTICE_DATE),
            eps: num(p.BASIC_EPS),
            bps: num(p.BPS),
            roe: num(p.WEIGHTAVG_ROE),
            revenue: num(p.TOTAL_OPERATE_INCOME),
            netProfit: num(p.PARENT_NETPROFIT),
            revenueYoy: num(p.YSTZ),
            profitYoy: num(p.SJLTZ),
            grossMargin: num(p.XSMLL),
            ocfPerShare: num(p.MGJYXJJE),
          }
        : null,
      holder: h
        ? {
            endDate: toDay(h.END_DATE),
            prevEndDate: toDay(h.PRE_END_DATE),
            holderNum: num(h.HOLDER_NUM),
            prevHolderNum: num(h.PRE_HOLDER_NUM),
            holderNumChange: num(h.HOLDER_NUM_CHANGE),
            holderNumRatio: toPct(h.HOLDER_NUM_RATIO),
            avgMarketCap: num(h.AVG_MARKET_CAP),
            closePrice: num(h.CLOSE_PRICE),
            noticeDate: toDay(h.HOLD_NOTICE_DATE),
          }
        : null,
      org: o
        ? {
            reportDate: toDay(o.REPORT_DATE),
            orgNum: num(o.TOTAL_ORG_NUM),
            orgNumChange: num(o.TOTAL_ORG_NUM_CHANGE),
            orgSharesRatio: num(o.TOTAL_SHARES_RATIO),
            ratioChange: num(o.CHANGE_RATIO),
            label: o.LABEL_NAME ? String(o.LABEL_NAME) : '',
          }
        : null,
      valuation: v
        ? {
            tradeDate: toDay(v.TRADE_DATE),
            industry: String(v.BOARD_NAME || ''),
            pe: num(v.PE_TTM),
            pb: num(v.PB_MRQ),
            ps: num(v.PS_TTM),
            peg: num(v.PEG_CAR),
            marketCap: num(v.TOTAL_MARKET_CAP),
          }
        : null,
      finance: m
        ? {
            reportDate: toDay(m.REPORT_DATE),
            roe: num(m.ROEJQ),
            roic: num(m.ROIC),
            grossMargin: num(m.XSMLL),
            debtRatio: num(m.ZCFZL),
            currentRatio: num(m.LD),
            quickRatio: num(m.SD),
          }
        : null,
    };
  }, { disk: false, ...options });
}

/* ------------------------------------------------------------------ */
/* 搜索：代码 / 名称 / 拼音首字母                                        */
/* ------------------------------------------------------------------ */

const SUGGEST_API = 'https://searchapi.eastmoney.com/api/suggest/get';
// 这是东方财富搜索框用的公开 token，不是账号密钥
const SUGGEST_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8';

/**
 * 联想搜索。支持 6 位代码、中文名称、拼音首字母（如 gzmt）。
 * 只保留 A 股（沪深北），过滤掉基金 / 债券 / 指数 / 港股美股。
 */
async function searchStocks(keyword, options = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  return cached(`search_${kw.toLowerCase()}`, 10 * 60 * 1000, async () => {
    const url =
      `${SUGGEST_API}?input=${encodeURIComponent(kw)}&type=14&token=${SUGGEST_TOKEN}&count=20`;
    const json = await getJSON(url);
    const list = (json && json.QuotationCodeTable && json.QuotationCodeTable.Data) || [];
    return list
      .filter((r) => r && /^\d{6}$/.test(String(r.Code || '')) && String(r.Classify || '') === 'AStock')
      .map((r) => ({
        code: String(r.Code),
        name: String(r.Name || ''),
        pinyin: String(r.PinYin || ''),
        secTypeName: String(r.SecurityTypeName || ''),
        market: String(r.MktNum || ''),
      }));
  }, options);
}

module.exports = {
  toSecid,
  secidToCode,
  quote,
  quotesBatch,
  searchStocks,
  marketOverview,
  marketClock,
  marketSnapshot,
  marketBreadth,
  boardRank,
  boardStocks,
  moneyFlowRank,
  minuteTrends,
  kline,
  monthlyKline,
  indexKline,
  stockFlow,
  pool,
  sentimentGauge,
  newsFlash,
  announcements,
  stockNews,
  latestReportPeriod,
  latestValuationDate,
  performanceReport,
  holderNumberReport,
  orgHoldReport,
  valuationReport,
  financeMainReport,
  shareholderResearch,
  stockFundamentalSnapshot,
  toF10Code,
  toSecuCode,
  num,
  ymd,
  BOARD_TYPES,
};
