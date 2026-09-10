'use strict';

/**
 * 镜像与故障切换。
 *
 * 东方财富的行情接口分布在多个 CDN 节点（push2 / push2his / push2ex 及其编号镜像）上，
 * 不同网络环境下部分节点会连不上。这里维护一个"镜像池"：
 *   1. 记住最近成功的节点，优先复用（黏性）
 *   2. 连续失败的节点进入冷却，暂时不再尝试
 *   3. 单次请求按健康度顺序最多试 N 个节点
 * 这样单点故障不会让整个应用瘫痪。
 */

const { getText, parseMaybeJSONP } = require('./http');

const NUMBERED = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 17, 21, 25, 29, 33, 40, 48, 60, 82, 99];

function buildPool(base, extra = []) {
  return [base, ...extra, ...NUMBERED.map((n) => `${n}.${base}`)];
}

const POOLS = {
  push2: buildPool('push2.eastmoney.com', ['push2delay.eastmoney.com']),
  push2his: buildPool('push2his.eastmoney.com'),
  push2ex: buildPool('push2ex.eastmoney.com'),
};

/**
 * 每个池子最多试几个节点。
 * push2 有大量真实存在的编号镜像，值得多试几个；
 * push2his / push2ex 的编号镜像多数并不存在，多试只是白等，所以只试主域名，
 * 失败就直接走备用数据源（腾讯 / 新浪）。
 */
const POOL_MAX_HOSTS = { push2: 4, push2his: 1, push2ex: 2 };

const health = new Map();

function getHealth(host) {
  if (!health.has(host)) health.set(host, { fails: 0, lastOk: 0, blockedUntil: 0 });
  return health.get(host);
}

function orderedHosts(pool) {
  const now = Date.now();
  const list = POOLS[pool] || POOLS.push2;
  const usable = list.filter((h) => getHealth(h).blockedUntil < now);
  const candidates = usable.length ? usable : list;
  return candidates.slice().sort((a, b) => {
    const ha = getHealth(a);
    const hb = getHealth(b);
    if (ha.fails !== hb.fails) return ha.fails - hb.fails;
    return hb.lastOk - ha.lastOk;
  });
}

function markOk(host) {
  const h = getHealth(host);
  h.fails = 0;
  h.lastOk = Date.now();
  h.blockedUntil = 0;
}

function markFail(host) {
  const h = getHealth(host);
  h.fails += 1;
  if (h.fails >= 2) h.blockedUntil = Date.now() + 45000;
}

function buildUrl(host, path) {
  const cleaned = path.startsWith('/') ? path : `/${path}`;
  return `https://${host}${cleaned}`;
}

/**
 * 在镜像池里找一个能用的节点取文本。
 * @param {'push2'|'push2his'|'push2ex'} pool
 * @param {string} path 形如 /api/qt/clist/get?...
 */
async function poolGetText(pool, path, options = {}) {
  const { maxHosts = POOL_MAX_HOSTS[pool] || 3, ...httpOptions } = options;
  const hosts = orderedHosts(pool).slice(0, maxHosts);
  let lastErr;
  for (const host of hosts) {
    try {
      const text = await getText(buildUrl(host, path), { retry: 0, ...httpOptions });
      markOk(host);
      return text;
    } catch (err) {
      markFail(host);
      lastErr = err;
    }
  }
  throw lastErr || new Error(`${pool} 无可用镜像`);
}

async function poolGetJSON(pool, path, options = {}) {
  const text = await poolGetText(pool, path, options);
  return parseMaybeJSONP(text);
}

/** 供界面展示：当前各节点健康状况 */
function status() {
  const out = {};
  const now = Date.now();
  for (const [pool, hosts] of Object.entries(POOLS)) {
    out[pool] = hosts
      .map((h) => ({ host: h, ...getHealth(h) }))
      .filter((h) => h.fails > 0 || h.lastOk > 0)
      .map((h) => ({ host: h.host, ok: h.blockedUntil < now && h.lastOk > 0, fails: h.fails }));
  }
  return out;
}

module.exports = { poolGetText, poolGetJSON, status, POOLS };
