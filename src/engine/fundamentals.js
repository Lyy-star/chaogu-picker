'use strict';

/**
 * 基本面类选股引擎。
 *
 * 和另外三类最大的区别：数据来自"财报 + 股东结构"，而不是当天的盘面。
 * 五个维度打分：
 *   成长  —— 营收/净利同比增速
 *   质量  —— ROE、毛利率、经营现金流、资产负债率
 *   估值  —— PE/PB 在所属行业内的相对分位（越低越便宜）
 *   筹码  —— 股东户数变化（户数减少 = 筹码集中）+ 户均持股市值
 *   机构  —— 机构家数变化、机构持股占流通比、"机构新进/增持"标签
 *
 * 最后再和技术位置（距 60 日高点还有多少空间、是否已经炒高）合成，
 * 用来筛"基本面在改善、股价还没兑现"的票，也就是上涨空间相对大的。
 */

const em = require('../data/eastmoney');
const { round } = require('./indicators');

const FINANCIAL_RE = /银行|保险|证券|多元金融|信托|期货|租赁/;

function clamp(v, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, v));
}

function norm(v, min, max) {
  if (!Number.isFinite(v)) return 50;
  if (max === min) return 50;
  return clamp(((v - min) / (max - min)) * 100);
}

function isFinancial(industry) {
  return FINANCIAL_RE.test(String(industry || ''));
}

/* ------------------------------------------------------------------ */
/* 数据加载                                                            */
/* ------------------------------------------------------------------ */

/** 行业内百分位：0 = 行业内最便宜，1 = 行业内最贵 */
function buildIndustryPercentile(rows, valueOf, { minSamples = 5 } = {}) {
  const groups = new Map();
  for (const r of rows) {
    const v = valueOf(r);
    if (!Number.isFinite(v) || v <= 0) continue;
    const key = r.industry || '未分类';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ code: r.code, value: v });
  }
  const out = new Map();
  for (const list of groups.values()) {
    if (list.length < minSamples) continue;
    list.sort((a, b) => a.value - b.value);
    const last = list.length - 1;
    list.forEach((item, i) => out.set(item.code, last ? i / last : 0.5));
  }
  return out;
}

/**
 * 拉取基本面全量数据（全市场，一次到位，之后按代码索引）。
 * 任何一路失败都不影响其它维度，只是对应维度退化为"中性 50 分"。
 */
async function loadFundamentalData({ force = false } = {}) {
  const [reportPeriod, valuationDate] = await Promise.all([
    em.latestReportPeriod({ force }),
    em.latestValuationDate({ force }),
  ]);

  const [perfRows, holderRows, orgRows, valRows, mainRows] = await Promise.all([
    em.performanceReport(reportPeriod, { force }).catch(() => []),
    em.holderNumberReport(reportPeriod, { force }).catch(() => []),
    em.orgHoldReport(reportPeriod, { force }).catch(() => []),
    em.valuationReport(valuationDate, { force }).catch(() => []),
    em.financeMainReport(reportPeriod, { force }).catch(() => []),
  ]);

  const index = (rows) => {
    const m = new Map();
    for (const r of rows) m.set(r.code, r);
    return m;
  };

  return {
    reportPeriod,
    valuationDate,
    perf: index(perfRows),
    holders: index(holderRows),
    orgs: index(orgRows),
    vals: index(valRows),
    mains: index(mainRows),
    industryPe: buildIndustryPercentile(valRows, (r) => r.pe),
    industryPb: buildIndustryPercentile(valRows, (r) => r.pb),
    counts: {
      perf: perfRows.length,
      holders: holderRows.length,
      orgs: orgRows.length,
      vals: valRows.length,
      mains: mainRows.length,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 五个维度打分                                                        */
/* ------------------------------------------------------------------ */

/** 成长：营收 + 净利同比增速 */
function growthScore(perf) {
  if (!perf) return 50;
  let s = 50;
  const py = perf.profitYoy;
  if (Number.isFinite(py)) {
    if (py >= 100) s += 24;
    else if (py >= 50) s += 20;
    else if (py >= 20) s += 14;
    else if (py >= 5) s += 7;
    else if (py >= 0) s += 2;
    else if (py >= -20) s -= 10;
    else if (py >= -50) s -= 18;
    else s -= 26;
  }
  const ry = perf.revenueYoy;
  if (Number.isFinite(ry)) {
    if (ry >= 30) s += 16;
    else if (ry >= 15) s += 11;
    else if (ry >= 5) s += 6;
    else if (ry >= 0) s += 1;
    else if (ry >= -10) s -= 8;
    else s -= 16;
  }
  return clamp(s);
}

/** 质量：ROE、毛利率、经营现金流、资产负债率（金融股不看负债率/毛利率） */
function qualityScore(perf, main, financial) {
  let s = 50;
  const roe = (main && main.roe) ?? (perf && perf.roe);
  if (Number.isFinite(roe)) {
    if (roe >= 20) s += 18;
    else if (roe >= 12) s += 14;
    else if (roe >= 8) s += 8;
    else if (roe >= 5) s += 2;
    else if (roe >= 0) s -= 8;
    else s -= 20;
  }
  const gm = (main && main.grossMargin) ?? (perf && perf.grossMargin);
  if (!financial && Number.isFinite(gm)) {
    if (gm >= 40) s += 10;
    else if (gm >= 25) s += 6;
    else if (gm >= 15) s += 2;
    else if (gm >= 0) s -= 4;
  }
  const debt = main && main.debtRatio;
  if (!financial && Number.isFinite(debt)) {
    if (debt >= 85) s -= 16;
    else if (debt >= 70) s -= 9;
    else if (debt >= 55) s -= 3;
    else if (debt <= 40) s += 5;
  }
  const ocf = perf && perf.ocfPerShare;
  if (Number.isFinite(ocf)) {
    if (ocf < 0) s -= 12;
    else if (Number.isFinite(perf.eps) && perf.eps > 0 && ocf >= perf.eps) s += 8;
    else s += 2;
  }
  const roic = main && main.roic;
  if (Number.isFinite(roic) && roic >= 12) s += 5;
  return clamp(s);
}

/** 估值：行业 PE/PB 分位 + 绝对水平，越低越便宜 */
function valueScore(val, pePct, pbPct) {
  let s = 50;
  if (!val) return 50;
  if (Number.isFinite(pePct)) s += (0.5 - pePct) * 56;
  if (Number.isFinite(pbPct)) s += (0.5 - pbPct) * 36;
  const pe = val.pe;
  if (!Number.isFinite(pe) || pe <= 0) s -= 18;
  else if (pe >= 80) s -= 10;
  else if (pe <= 15) s += 6;
  const pb = val.pb;
  if (Number.isFinite(pb) && pb > 10) s -= 6;
  else if (Number.isFinite(pb) && pb > 0 && pb < 1.5) s += 5;
  const peg = val.peg;
  if (Number.isFinite(peg) && peg > 0 && peg < 1) s += 8;
  else if (Number.isFinite(peg) && peg > 3) s -= 6;
  return clamp(s);
}

/** 筹码：股东户数减少 = 筹码集中；户均持股市值高 = 大户/机构占比高 */
function chipsScore(holder) {
  if (!holder || !Number.isFinite(holder.holderNumRatio)) return 50;
  const r = holder.holderNumRatio;
  let s;
  if (r <= -30) s = 92;
  else if (r <= -20) s = 85;
  else if (r <= -10) s = 76;
  else if (r <= -5) s = 68;
  else if (r < 0) s = 58;
  else if (r < 5) s = 48;
  else if (r < 15) s = 38;
  else if (r < 30) s = 28;
  else s = 18;
  const avg = holder.avgMarketCap;
  if (Number.isFinite(avg)) {
    if (avg >= 1e6) s += 8;
    else if (avg >= 3e5) s += 4;
    else if (avg < 3e4) s -= 4;
  }
  return clamp(s);
}

/** 机构：家数变化 + 持股占流通比 + 标签 */
function institutionScore(org) {
  if (!org) return 50;
  let s = 50;
  // 机构持股数量的环比变化：比"机构家数"更能反映真实增减持
  // （中报/年报会披露全部基金，家数天然比一季报多，只看家数会系统性高估）
  const rc = org.ratioChange;
  if (Number.isFinite(rc)) {
    if (rc >= 30) s += 14;
    else if (rc >= 10) s += 10;
    else if (rc >= 3) s += 7;
    else if (rc > 0) s += 4;
    else if (rc > -3) s -= 2;
    else if (rc > -10) s -= 8;
    else if (rc > -30) s -= 12;
    else s -= 16;
  }
  // 机构持股占流通股比例的变化（百分点）
  const rcp = org.ratioChangePct;
  if (Number.isFinite(rcp)) {
    if (rcp >= 2) s += 8;
    else if (rcp >= 0.5) s += 5;
    else if (rcp >= 0) s += 2;
    else if (rcp > -0.5) s -= 2;
    else if (rcp > -2) s -= 6;
    else s -= 10;
  }
  // 机构家数变化：受披露口径影响大，只给小权重
  const chg = org.orgNumChange;
  if (Number.isFinite(chg)) {
    if (chg >= 50) s += 6;
    else if (chg >= 10) s += 4;
    else if (chg > 0) s += 2;
    else if (chg > -10) s -= 2;
    else s -= 6;
  }
  const ratio = org.orgSharesRatio;
  if (Number.isFinite(ratio)) {
    if (ratio >= 50) s += 6;
    else if (ratio >= 25) s += 4;
    else if (ratio >= 10) s += 2;
    else if (ratio < 3) s -= 4;
  }
  const label = String(org.label || '');
  if (/新进/.test(label)) s += 6;
  else if (/增持|加仓/.test(label)) s += 4;
  else if (/减持/.test(label)) s -= 6;
  return clamp(s);
}

/* ------------------------------------------------------------------ */
/* 中文说明构造                                                        */
/* ------------------------------------------------------------------ */

function yi(v) {
  if (!Number.isFinite(v)) return '-';
  return `${(v / 1e8).toFixed(2)}亿`;
}

function wan(v) {
  if (!Number.isFinite(v)) return '-';
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(2)}万`;
  return v.toFixed(0);
}

function signedPct(v, digits = 2) {
  if (!Number.isFinite(v)) return '-';
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

function pctText(v, digits = 0) {
  if (!Number.isFinite(v)) return '-';
  return `${(v * 100).toFixed(digits)}%`;
}

/** 维度分 -> 中文档位，让理由读起来是"话"而不是"分" */
function grade(score, labels) {
  const [high, mid, low] = labels;
  if (score >= 72) return high;
  if (score >= 52) return mid;
  return low;
}

function buildReasonParts({ perf, holder, org, val, main, score, pePct, pbPct, financial }) {
  const parts = [];

  if (perf) {
    parts.push(
      `基本面（${perf.reportDate}）：营收 ${yi(perf.revenue)}（同比 ${signedPct(perf.revenueYoy)}），` +
        `净利 ${yi(perf.netProfit)}（同比 ${signedPct(perf.profitYoy)}），` +
        `加权 ROE ${Number.isFinite(perf.roe) ? `${perf.roe.toFixed(2)}%` : '-'}` +
        (financial ? '' : `，毛利率 ${Number.isFinite(perf.grossMargin) ? `${perf.grossMargin.toFixed(1)}%` : '-'}`),
    );
  }

  if (val) {
    const peTxt = Number.isFinite(val.pe) && val.pe > 0 ? val.pe.toFixed(1) : Number.isFinite(val.pe) ? '亏损(PE为负)' : '-';
    parts.push(
      `估值：PE(TTM) ${peTxt}、PB ${Number.isFinite(val.pb) ? val.pb.toFixed(2) : '-'}` +
        (val.industry ? `，所属「${val.industry}」行业` : '') +
        (Number.isFinite(pePct) ? ` PE 分位 ${pctText(pePct)}` : '') +
        (Number.isFinite(pbPct) ? `、PB 分位 ${pctText(pbPct)}` : '') +
        `（分位越低越便宜，0=行业最便宜）` +
        (Number.isFinite(val.peg) && val.peg > 0 ? `，PEG ${val.peg.toFixed(2)}` : ''),
    );
  }

  if (holder) {
    const dir = holder.holderNumRatio < 0 ? '户数减少、筹码趋于集中' : holder.holderNumRatio > 0 ? '户数增加、筹码趋于分散' : '户数基本持平';
    parts.push(
      `股东户数（${holder.endDate}）：${wan(holder.holderNum)} 户，环比 ${signedPct(holder.holderNumRatio)}（${dir}），` +
        `户均持股市值 ${Number.isFinite(holder.avgMarketCap) ? `${(holder.avgMarketCap / 1e4).toFixed(1)}万元` : '-'}`,
    );
  }

  if (org) {
    const chgTxt = Number.isFinite(org.orgNumChange)
      ? `环比${org.orgNumChange > 0 ? '增加' : org.orgNumChange < 0 ? '减少' : '持平'} ${Math.abs(org.orgNumChange)} 家`
      : '家数变化未知';
    parts.push(
      `机构持仓（${org.reportDate}）：共 ${Number.isFinite(org.orgNum) ? org.orgNum : '-'} 家机构持有，${chgTxt}，` +
        `机构持股总量环比 ${signedPct(org.ratioChange)}、占流通股 ` +
        `${Number.isFinite(org.orgSharesRatio) ? `${org.orgSharesRatio.toFixed(2)}%` : '-'}` +
        (Number.isFinite(org.ratioChangePct) ? `（较上期 ${org.ratioChangePct > 0 ? '+' : ''}${org.ratioChangePct.toFixed(2)} 个百分点）` : '') +
        (org.label ? `，标签「${org.label}」` : ''),
    );
    parts.push(
      '机构家数变化只作参考：中报/年报要求披露全部基金，家数天然比一季报多，看"持股数量与占比变化"更可靠',
    );
  }

  if (main && !financial) {
    parts.push(
      `财务质量：资产负债率 ${Number.isFinite(main.debtRatio) ? `${main.debtRatio.toFixed(1)}%` : '-'}，` +
        `流动比率 ${Number.isFinite(main.currentRatio) ? main.currentRatio.toFixed(2) : '-'}，` +
        `ROIC ${Number.isFinite(main.roic) ? `${main.roic.toFixed(1)}%` : '-'}`,
    );
  } else if (main && financial) {
    parts.push(`金融股口径：ROE ${Number.isFinite(main.roe) ? `${main.roe.toFixed(2)}%` : '-'}、ROIC ${Number.isFinite(main.roic) ? `${main.roic.toFixed(1)}%` : '-'}（银行保险的负债率天然偏高，不参与扣分）`);
  }

  parts.push(
    `综合：成长 ${Math.round(score.growth)} / 质量 ${Math.round(score.quality)} / 估值 ${Math.round(score.value)}` +
      ` / 筹码 ${Math.round(score.chips)} / 机构 ${Math.round(score.institution)}，` +
      `其中${grade(score.value, ['估值处于行业低位、还有修复空间', '估值处于行业中等水平', '估值已经偏贵'])}`,
  );
  return parts;
}

function buildBadges({ perf, holder, org, val, pePct }) {
  const out = [];
  if (holder && Number.isFinite(holder.holderNumRatio)) out.push(`户数 ${signedPct(holder.holderNumRatio, 1)}`);
  if (org && Number.isFinite(org.ratioChange)) out.push(`机构持股 ${signedPct(org.ratioChange, 1)}`);
  else if (org && Number.isFinite(org.orgNumChange)) out.push(`机构家数 ${org.orgNumChange > 0 ? '+' : ''}${org.orgNumChange}`);
  if (Number.isFinite(pePct)) out.push(`PE分位 ${pctText(pePct)}`);
  if (perf && Number.isFinite(perf.roe)) out.push(`ROE ${perf.roe.toFixed(1)}%`);
  if (val && val.industry) out.push(val.industry);
  return out;
}

function buildRisks({ perf, holder, org, val, main, pePct, pbPct, financial }) {
  const risks = [];
  if (holder && Number.isFinite(holder.holderNumRatio) && holder.holderNumRatio > 10) {
    risks.push(`股东户数环比 ${signedPct(holder.holderNumRatio, 1)}，筹码在分散，通常意味着散户接盘、主力派发`);
  }
  if (org && Number.isFinite(org.orgNumChange) && org.orgNumChange < 0) {
    risks.push(`机构家数环比减少 ${Math.abs(org.orgNumChange)} 家，注意机构在撤退（若同时"持股总量"也在降，则更确定）`);
  }
  if (org && Number.isFinite(org.ratioChange) && org.ratioChange < -10) {
    risks.push(`机构持股总量环比 ${signedPct(org.ratioChange)}，机构在明显减仓，短期缺少资金推动`);
  }
  if (perf && Number.isFinite(perf.profitYoy) && perf.profitYoy < 0) {
    risks.push(`最新财报净利同比 ${signedPct(perf.profitYoy)}，业绩还在下滑，基本面改善尚未出现拐点`);
  }
  if (val && Number.isFinite(val.pe) && val.pe <= 0) {
    risks.push('PE 为负（当前处于亏损状态），估值指标失效，只能看 PB 和现金流');
  }
  if (!financial && main && Number.isFinite(main.debtRatio) && main.debtRatio >= 70) {
    risks.push(`资产负债率 ${main.debtRatio.toFixed(1)}%，杠杆偏高，注意财务费用与偿债压力`);
  }
  if (Number.isFinite(pePct) && Number.isFinite(pbPct) && pePct >= 0.85 && pbPct >= 0.85) {
    risks.push('PE、PB 双双处于行业 85% 以上分位，属于"好公司但不便宜"，上涨空间主要靠业绩兑现');
  }
  if (perf && Number.isFinite(perf.ocfPerShare) && perf.ocfPerShare < 0) {
    risks.push('每股经营现金流为负，利润没有变成现金，注意应收/存货占用');
  }
  return risks;
}

/* ------------------------------------------------------------------ */
/* 候选构建                                                            */
/* ------------------------------------------------------------------ */

/**
 * 用全市场数据 + 实时快照构建基本面候选。
 * 返回的每一条都带 score / reasonParts / risks / badges / fundamental 指标。
 */
function buildCandidates({ snapshot, data, minScore = 42 }) {
  const out = [];
  for (const row of snapshot.rows) {
    const code = row.code;
    const perf = data.perf.get(code) || null;
    const holder = data.holders.get(code) || null;
    const org = data.orgs.get(code) || null;
    const val = data.vals.get(code) || null;
    const main = data.mains.get(code) || null;

    // 没有财报、也没有机构持仓的，谈不上"公司基本面"
    if (!perf && !org) continue;

    const financial = isFinancial(val && val.industry);
    const pePct = data.industryPe.has(code) ? data.industryPe.get(code) : null;
    const pbPct = data.industryPb.has(code) ? data.industryPb.get(code) : null;

    const score = {
      growth: growthScore(perf),
      quality: qualityScore(perf, main, financial),
      value: valueScore(val, pePct, pbPct),
      chips: chipsScore(holder),
      institution: institutionScore(org),
    };
    const base =
      0.24 * score.growth + 0.22 * score.quality + 0.2 * score.value + 0.16 * score.chips + 0.18 * score.institution;

    if (base < minScore) continue;

    const fundamental = {
      reportPeriod: (perf && perf.reportDate) || (org && org.reportDate) || data.reportPeriod,
      industry: (val && val.industry) || '',
      roe: (perf && perf.roe) ?? (main && main.roe) ?? null,
      revenue: perf ? perf.revenue : null,
      netProfit: perf ? perf.netProfit : null,
      revenueYoy: perf ? perf.revenueYoy : null,
      profitYoy: perf ? perf.profitYoy : null,
      grossMargin: (perf && perf.grossMargin) ?? (main && main.grossMargin) ?? null,
      eps: perf ? perf.eps : null,
      bps: perf ? perf.bps : null,
      ocfPerShare: perf ? perf.ocfPerShare : null,
      debtRatio: main ? main.debtRatio : null,
      currentRatio: main ? main.currentRatio : null,
      roic: main ? main.roic : null,
      pe: val ? val.pe : null,
      pb: val ? val.pb : null,
      peg: val ? val.peg : null,
      pePct,
      pbPct,
      holderNum: holder ? holder.holderNum : null,
      prevHolderNum: holder ? holder.prevHolderNum : null,
      holderNumChange: holder ? holder.holderNumChange : null,
      holderNumRatio: holder ? holder.holderNumRatio : null,
      avgMarketCap: holder ? holder.avgMarketCap : null,
      holderEndDate: holder ? holder.endDate : null,
      orgNum: org ? org.orgNum : null,
      orgNumChange: org ? org.orgNumChange : null,
      orgSharesRatio: org ? org.orgSharesRatio : null,
      orgRatioChange: org ? org.ratioChange : null,
      orgRatioChangePct: org ? org.ratioChangePct : null,
      orgLabel: org ? org.label : '',
      subScores: {
        growth: round(score.growth, 1),
        quality: round(score.quality, 1),
        value: round(score.value, 1),
        chips: round(score.chips, 1),
        institution: round(score.institution, 1),
      },
      financial,
    };

    out.push({
      ...row,
      score: round(base, 1),
      fundScore: round(base, 1),
      reasonParts: buildReasonParts({ perf, holder, org, val, main, score, pePct, pbPct, financial }),
      risks: buildRisks({ perf, holder, org, val, main, pePct, pbPct, financial }),
      badges: buildBadges({ perf, holder, org, val, pePct }),
      fundamental,
      sources: [`财报 ${data.reportPeriod || '-'}`, `估值 ${data.valuationDate || '-'}`],
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 个股基本面详情（给详情抽屉用）                                        */
/* ------------------------------------------------------------------ */

async function fundamentalDetail(code, options = {}) {
  const [snap, f10] = await Promise.all([
    em.stockFundamentalSnapshot(code, options).catch(() => null),
    em.shareholderResearch(code, options).catch(() => null),
  ]);
  if (!snap) return null;
  return {
    ...snap,
    fundCount: f10 ? f10.fundCount : null,
    fundRatio: f10 ? f10.fundRatio : null,
    fundHolders: f10 ? f10.fundHolders : [],
    holderHistory: f10 ? f10.holderHistory : [],
    orgTypes: f10 ? f10.orgTypes : [],
  };
}

module.exports = {
  loadFundamentalData,
  buildCandidates,
  fundamentalDetail,
  growthScore,
  qualityScore,
  valueScore,
  chipsScore,
  institutionScore,
  isFinancial,
};
