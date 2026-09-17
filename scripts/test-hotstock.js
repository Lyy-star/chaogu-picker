'use strict';

/**
 * 热门票自检。
 *
 *   node scripts/test-hotstock.js         # 用造出来的行情跑打分逻辑，不联网
 *   node scripts/test-hotstock.js --live  # 直接抓一次真实全市场快照，看今天的热门票
 */

const hot = require('../src/engine/hotstock');

const LIVE = process.argv.includes('--live');

function mkRow(code, name, opts) {
  return {
    code,
    name,
    price: opts.price === undefined ? 10 : opts.price,
    changePct: opts.changePct,
    amount: opts.amount,
    turnoverRate: opts.turnoverRate,
    volumeRatio: opts.volumeRatio,
    mainNetIn: opts.mainNetIn,
    mainNetInPct: opts.mainNetInPct,
    floatCap: 5e9,
    change60Pct: 10,
  };
}

function synthRows() {
  const rows = [];
  // 1800 只"闲票"：成交额从 1000 万到 3 亿按对数铺开，换手低、没人管
  for (let i = 0; i < 1800; i += 1) {
    rows.push(
      mkRow(`60${String(1000 + i).padStart(4, '0')}`, `闲票${i}`, {
        amount: 1e7 * Math.pow(30, i / 1800),
        turnoverRate: 0.8 + (i % 10) * 0.1,
        volumeRatio: 1,
        changePct: (i % 7) - 3,
        mainNetIn: -1e6,
        mainNetInPct: -1,
      }),
    );
  }
  // 一只各方面都热的票
  rows.push(
    mkRow('600519', '热门龙头', {
      amount: 48e8,
      turnoverRate: 12,
      volumeRatio: 3.2,
      changePct: 10.02,
      mainNetIn: 9e8,
      mainNetInPct: 15,
      price: 1680,
    }),
  );
  // 一只放量但资金在出的票
  rows.push(
    mkRow('000001', '放量出货', {
      amount: 30e8,
      turnoverRate: 18,
      volumeRatio: 2.5,
      changePct: -6.5,
      mainNetIn: -8e8,
      mainNetInPct: -12,
      price: 12,
    }),
  );
  // 换手失控的高位票
  rows.push(
    mkRow('002415', '换手失控', {
      amount: 25e8,
      turnoverRate: 42,
      volumeRatio: 4,
      changePct: 3,
      mainNetIn: 1e8,
      mainNetInPct: 3,
      price: 30,
    }),
  );
  // 不该出现的：ST、创业板、科创板
  rows.push(
    mkRow('600001', 'ST垃圾', {
      amount: 50e8, turnoverRate: 15, volumeRatio: 3, changePct: 5, mainNetIn: 5e8, mainNetInPct: 10,
    }),
  );
  rows.push(
    mkRow('300750', '创业板龙头', {
      amount: 60e8, turnoverRate: 12, volumeRatio: 3, changePct: 8, mainNetIn: 9e8, mainNetInPct: 12,
    }),
  );
  rows.push(
    mkRow('688111', '科创板龙头', {
      amount: 60e8, turnoverRate: 12, volumeRatio: 3, changePct: 8, mainNetIn: 9e8, mainNetInPct: 12,
    }),
  );
  return rows;
}

function check(ok, msg) {
  if (!ok) {
    console.error(`x ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`v ${msg}`);
  }
}

function show(items) {
  for (const it of items) {
    console.log(
      `\n#${it.rank} ${it.name}(${it.code}) 热度 ${it.score} ${it.verdict}  ` +
        `${it.price} ${it.changePct}%  成交额 ${(it.amount / 1e8).toFixed(1)}亿 换手 ${it.turnoverRate}%`,
    );
    console.log(`   因子 ${JSON.stringify(it.parts)}`);
    console.log(`   标签 ${(it.tags || []).join(' / ')}`);
    for (const r of it.reasons || []) console.log(`   理由 ${r}`);
    for (const r of it.risks || []) console.log(`   风险 ${r}`);
  }
}

async function live() {
  const em = require('../src/data/eastmoney');
  console.log('抓取全市场快照…');
  const snap = await em.marketSnapshot();
  const built = hot.buildHotList(snap.rows, { limit: 12 });
  console.log(`全市场 ${snap.rows.length} 只，候选 ${built.total} 只\n`);
  show(built.list);
  const { mapLimit } = require('../src/lib/http');
  const detailed = await mapLimit(built.list.slice(0, 5), 3, async (c) => {
    const k = await em.kline(c.code, { limit: 40 }).catch(() => null);
    return hot.finalize(c, { tech: null, streak: hot.limitUpStreak(k && k.bars) });
  });
  console.log('\n===== 前 5 名的连板提示 =====');
  for (const d of detailed) console.log(`${d.name}(${d.code}) 连板 ${d.streak} 标签 ${d.tags.join(' / ')}`);
}

function offline() {
  const rows = synthRows();
  const built = hot.buildHotList(rows, { limit: 12, lhbCodes: new Set(['600519']) });
  show(built.list);
  console.log('');

  const codes = built.list.map((x) => x.code);
  check(built.list[0].code === '600519', '各方面都热的票排第一');
  check(!codes.includes('600001'), 'ST 不进热门榜');
  check(!codes.includes('300750') && !codes.includes('688111'), '创业板 / 科创板不进热门榜');
  check(codes.includes('000001'), '放量出货的票仍在榜（热度榜只提示风险，不负责排除）');

  const amounts = rows.map((r) => r.amount).sort((a, b) => a - b);
  const cold = hot.heatOf(rows[0], { amounts });
  const hotRow = built.list.find((x) => x.code === '600519');
  const downRow = built.list.find((x) => x.code === '000001');
  check(hotRow.score >= 85, `热门龙头分数够高（${hotRow.score}）`);
  check(cold.score < 60, `闲票分数够低（${cold.score}）`);
  check(downRow.score < hotRow.score, `资金流出的票排在龙头后面（${downRow.score} < ${hotRow.score}）`);
  check(hotRow.tags.includes('涨停'), '涨停被标记出来');
  check(hotRow.tags.includes('近日上过龙虎榜'), '上过龙虎榜的票被标记出来');
  check(hotRow.risks.some((r) => r.includes('买不进')), '涨停买不进被写成风险提示');

  const streak = hot.limitUpStreak([
    { changePct: 2 }, { changePct: 9.9 }, { changePct: 10 }, { changePct: 9.98 },
  ]);
  check(streak === 3, `连板天数数得对（${streak}）`);
  console.log('');
}

(async () => {
  if (LIVE) await live();
  else offline();
})().catch((err) => {
  console.error('自检失败：', err && err.stack ? err.stack : err);
  process.exit(1);
});
