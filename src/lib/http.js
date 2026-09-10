'use strict';

const { USER_AGENT } = require('../config');

const DEFAULT_TIMEOUT = 12000;
const RETRY = 3;

/* ------------------------------------------------------------------ */
/* 全局限流：数据源对短时间内的并发很敏感，被限流后会直接断连。           */
/* 这里统一控制"同时在飞的请求数"和"请求最小间隔"。                      */
/* ------------------------------------------------------------------ */

const MAX_CONCURRENT = 5;
const MIN_INTERVAL_MS = 90;
let activeCount = 0;
let lastStartAt = 0;
const waitQueue = [];

function pump() {
  if (!waitQueue.length || activeCount >= MAX_CONCURRENT) return;
  const now = Date.now();
  const wait = Math.max(0, lastStartAt + MIN_INTERVAL_MS - now);
  if (wait > 0) {
    setTimeout(pump, wait);
    return;
  }
  const task = waitQueue.shift();
  activeCount += 1;
  lastStartAt = Date.now();
  task();
  pump();
}

function acquire() {
  return new Promise((resolve) => {
    waitQueue.push(resolve);
    pump();
  });
}

function release() {
  activeCount -= 1;
  pump();
}

async function fetchText(url, options = {}) {
  const { timeout = DEFAULT_TIMEOUT, headers = {} } = options;
  await acquire();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: 'https://quote.eastmoney.com/',
        ...headers,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
    release();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 带 UA / 超时 / 重试的 GET，返回文本。
 * 东方财富接口在部分网络下会偶发中断，重试能显著降低失败率。
 */
async function getText(url, options = {}) {
  const { retry = RETRY } = options;
  let lastErr;
  for (let attempt = 0; attempt <= retry; attempt += 1) {
    try {
      return await fetchText(url, options);
    } catch (err) {
      lastErr = new Error(`${err.message} <- ${shorten(url)}`);
      if (attempt < retry) {
        // 递增退避 + 抖动，避免多个失败请求同时重试再次触发限流
        const backoff = 400 * 2 ** attempt + Math.random() * 250;
        await sleep(backoff);
      }
    }
  }
  throw lastErr;
}

/** 取 JSON（自动兼容 JSONP 包裹与空响应） */
async function getJSON(url, options) {
  const text = await getText(url, options);
  return parseMaybeJSONP(text);
}

function parseMaybeJSONP(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
  const start = trimmed.indexOf('(');
  const end = trimmed.lastIndexOf(')');
  if (start >= 0 && end > start) {
    const body = trimmed.slice(start + 1, end).trim();
    if (!body) return null;
    return JSON.parse(body);
  }
  return null;
}

/** 固定并发上限的批量映射，避免被数据源限流 */
async function mapLimit(items, limit, worker) {
  const list = Array.from(items);
  const results = new Array(list.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, list.length || 1)).fill(0).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      try {
        results[index] = await worker(list[index], index);
      } catch (err) {
        results[index] = { __error: err.message };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

module.exports = { getText, getJSON, parseMaybeJSONP, mapLimit, sleep, fetchText };

function shorten(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}?${u.searchParams.toString().slice(0, 120)}`;
  } catch (_) {
    return String(url).slice(0, 120);
  }
}
