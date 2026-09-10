'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, '.cache');
const USER_DIR = path.join(ROOT, 'userdata');

for (const dir of [CACHE_DIR, USER_DIR]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    /* 只读环境下忽略 */
  }
}

module.exports = {
  ROOT,
  CACHE_DIR,
  USER_DIR,
  WEB_DIR: path.join(ROOT, 'web'),

  // 本地服务端口（Electron 与浏览器外壳共用）
  PORT: Number(process.env.CHAOGU_PORT || 8760),

  // 只做主板的股票池
  BOARD: {
    // 沪市主板 600/601/603/605，深市主板 000/001/002/003
    mainBoardPattern: /^(600|601|603|605|000|001|002|003)\d{3}$/,
    // 明确排除：科创板 688/689、创业板 300/301、北交所 4xx/8xx/920
    excludePattern: /^(688|689|300|301|8|4|920)/,
  },

  // 东方财富板块过滤串：深市主板 + 沪市主板
  EM_MAIN_BOARD_FS: 'm:0+t:6,m:1+t:2',
  EM_ALL_A_FS: 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23',
  // 东方财富数据中心的"主板口径"过滤串（沪市主板 + 深市主板），用来给基本面报表瘦身
  EM_MAIN_BOARD_MARKET: '(TRADE_MARKET_CODE in ("069001001001","069001002001"))',
  EM_MAIN_BOARD_TRADE: '(TRADE_MARKET in ("069001001001","069001002001"))',

  CACHE_TTL: {
    quote: 15 * 1000,        // 实时快照
    board: 60 * 1000,        // 板块排行
    snapshot: 60 * 1000,     // 全市场快照
    list: 5 * 60 * 1000,     // 个股列表
    kline: 10 * 60 * 1000,   // 日线
    trends: 60 * 1000,       // 分时
    flow: 3 * 60 * 1000,     // 资金流
    news: 3 * 60 * 1000,     // 快讯
    ann: 10 * 60 * 1000,     // 公告
    ztpool: 60 * 1000,       // 涨停池
  },

  // 选股参数（都可在界面上调，这里是默认值）
  SELECT: {
    perCategory: 12,          // 每类展示条数
    hotBoardCount: 6,         // 热点板块取前 N
    boardStockTop: 30,        // 每个热点板块取前 N 只主板股
    announcementPages: 8,     // 全市场公告翻页数（每页 100 条）
    newsPages: 3,             // 7x24 快讯翻页
    minTurnover: 8000,        // 最低成交额（万元），过滤僵尸股
    maxTurnoverRate: 35,      // 换手率上限，过滤过度炒作
    snapshotPages: 0,         // 全市场快照最多抓几页（0 = 全部，约 35 页）
    excludeST: true,
    excludeLimitUp: true,     // 排除已涨停（买不进）
    fundamentalMinUpside: 12, // 基本面类：目标二相对现价的最小空间（%），不足的优先剔除
  },

  // 大事件日历窗口（天）
  EVENT_WINDOW_DAYS: 60,

  USER_AGENT:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',

  HOSTNAME: os.hostname(),
};
