'use strict';

/**
 * 大事件日历引擎：
 *  1) 周期规律推算的事件（种子库）
 *  2) 用户自定义事件（userdata/events.json）
 *  3) 从 7×24 快讯里实时抽取的事件（带来源链接）
 * 合并后按"影响力 x 时间临近度 x 主题热度"排序。
 */

const fs = require('fs');
const path = require('path');
const { USER_DIR, EVENT_WINDOW_DAYS } = require('../config');
const seed = require('../data/events.seed');
const { EVENT_WORDS, EVENT_TIME_PATTERNS, themesOf, THEME_MAP, NOISE_BOARD } = require('./keywords');

const CUSTOM_FILE = path.join(USER_DIR, 'events.json');

function pad(n) {
  return String(n).padStart(2, '0');
}

function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function daysBetween(a, b) {
  const d1 = new Date(`${a}T00:00:00`);
  const d2 = new Date(`${b}T00:00:00`);
  return Math.round((d2 - d1) / 86400000);
}

/** 由 recurring 规则推算"下一次"发生的日期 */
function nextOccurrence(rule, today = new Date()) {
  const year = today.getFullYear();
  const build = (y) => {
    const d = new Date(y, rule.month - 1, rule.day);
    return d;
  };
  let d = build(year);
  const end = new Date(d.getTime() + (rule.spanDays || 1) * 86400000);
  if (end < today) d = build(year + 1);
  if (rule.everyOtherYear && (d.getFullYear() - 2024) % 2 !== 0) {
    d = build(d.getFullYear() + 1);
  }
  const endDate = new Date(d.getTime() + (rule.spanDays || 1) * 86400000);
  return { date: toDateStr(d), endDate: toDateStr(endDate) };
}

function expandSeed(today = new Date()) {
  const out = [];
  for (const e of seed.recurring) {
    const occ = nextOccurrence(e.recurring, today);
    out.push({ ...e, ...occ, source: '周期规律推算', sourceUrl: '', custom: false });
  }
  for (const e of seed.fixed) {
    out.push({ ...e, source: '公开日程（待核实）', sourceUrl: '', custom: false });
  }
  return out;
}

function loadCustom() {
  try {
    const raw = fs.readFileSync(CUSTOM_FILE, 'utf8');
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.map((e) => ({ ...e, source: e.source || '自定义', custom: true })) : [];
  } catch (_) {
    return [];
  }
}

function saveCustom(list) {
  try {
    fs.writeFileSync(CUSTOM_FILE, JSON.stringify(list, null, 2), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

/** 从快讯文本中抽取带有明确时间的事件 */
function extractFromNews(newsList, today = new Date()) {
  const out = [];
  const seen = new Set();
  for (const n of newsList) {
    const text = `${n.title || ''} ${n.summary || ''}`;
    if (!text || !EVENT_WORDS.some((w) => text.includes(w))) continue;
    const themes = themesOf(text);
    if (!themes.length) continue;

    let date = null;
    let endDate = null;
    for (const re of EVENT_TIME_PATTERNS) {
      const m = text.match(re);
      if (!m) continue;
      if (m.length >= 5 && m[3] && m[4]) {
        const y = today.getFullYear();
        date = `${y}-${pad(Number(m[1]))}-${pad(Number(m[2]))}`;
        endDate = `${y}-${pad(Number(m[3]))}-${pad(Number(m[4]))}`;
      } else if (m.length >= 4 && m[1] && m[2] && m[3]) {
        date = `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`;
      } else if (m.length >= 4 && m[1] && m[2]) {
        const y = today.getFullYear();
        date = `${y}-${pad(Number(m[1]))}-${pad(Number(m[2]))}`;
      } else if (m[1]) {
        const offsets = { 今日: 0, 明日: 1, 后天: 2 };
        const off = offsets[m[1]];
        if (off !== undefined) date = toDateStr(new Date(today.getTime() + off * 86400000));
      }
      if (date) break;
    }
    if (!date) continue;

    const id = `news-${n.code || n.title.slice(0, 12)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: (n.title || '').slice(0, 40),
      date,
      endDate: endDate || date,
      category: '实时事件',
      level: 3,
      verify: false,
      themes: themes.map((t) => t.theme),
      impact: (n.summary || n.title || '').slice(0, 160),
      source: n.source || '7×24 快讯',
      sourceUrl: n.url || '',
      custom: false,
    });
  }
  return out;
}

/**
 * 汇总未来窗口内的事件。
 * @param {Array} newsList 7×24 快讯原始列表
 */
function upcoming(newsList = [], { windowDays = EVENT_WINDOW_DAYS, today = new Date() } = {}) {
  const todayStr = toDateStr(today);
  const all = [...expandSeed(today), ...loadCustom(), ...extractFromNews(newsList, today)];
  const out = [];
  const seen = new Set();
  for (const e of all) {
    if (!e.date) continue;
    const start = daysBetween(todayStr, e.date);
    const end = e.endDate ? daysBetween(todayStr, e.endDate) : start;
    // 已结束的直接扔掉；正在进行的保留（end >= 0）
    if (end < 0) continue;
    if (start > windowDays) continue;
    const key = `${e.name}-${e.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...e,
      daysUntil: start,
      daysToEnd: end,
      ongoing: start <= 0 && end >= 0,
    });
  }
  out.sort((a, b) => a.daysUntil - b.daysUntil || (b.level || 0) - (a.level || 0));
  return out;
}

/** 事件 -> 匹配到的东方财富概念板块 */
function matchBoards(event, boards) {
  const hits = new Set();
  const themes = event.themes || [];
  const hints = new Set();
  for (const t of themes) {
    const entry = THEME_MAP.find((x) => x.theme === t);
    if (entry) for (const h of entry.boardHints) hints.add(h);
  }
  for (const b of boards) {
    if (NOISE_BOARD.test(b.name)) continue;
    for (const h of hints) {
      // 精确匹配优先；包含匹配要求板块名足够长，避免"保险"命中"参股保险"
      const exact = b.name === h || b.name === `${h}概念`;
      const contains = h.length >= 3 && b.name.length >= 3 && (b.name.includes(h) || h.includes(b.name));
      if (exact || contains) {
        hits.add(b);
        break;
      }
    }
  }
  // 精确命中的排前面
  return [...hits].sort((a, b) => {
    const ae = [...hints].some((h) => a.name === h || a.name === `${h}概念`) ? 0 : 1;
    const be = [...hints].some((h) => b.name === h || b.name === `${h}概念`) ? 0 : 1;
    return ae - be;
  });
}

/** 事件时效分：越临近分越高，事件期间略降（买预期卖事实） */
function timingScore(daysUntil) {
  if (daysUntil < 0) return 55;      // 进行中
  if (daysUntil === 0) return 60;
  if (daysUntil <= 3) return 85;
  if (daysUntil <= 7) return 100;
  if (daysUntil <= 15) return 80;
  if (daysUntil <= 30) return 60;
  return 40;
}

module.exports = {
  upcoming,
  matchBoards,
  timingScore,
  extractFromNews,
  loadCustom,
  saveCustom,
  expandSeed,
  toDateStr,
  daysBetween,
};
