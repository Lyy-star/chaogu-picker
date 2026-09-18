'use strict';

const fs = require('fs');
const path = require('path');
const { CACHE_DIR } = require('../config');

const memory = new Map();
const inflight = new Map();

function diskPath(key) {
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return path.join(CACHE_DIR, `${safe}.json`);
}

/**
 * 结果缓存 + 请求合并：
 * - 同 key 并发只打一次上游
 * - 过期后先返回旧值（stale-while-revalidate 的简化版由调用方决定）
 * - 落盘，重启后仍可离线查看上次数据
 */
async function cached(key, ttl, producer, options = {}) {
  const {
    force = false,
    allowStale = true,
    disk = true,
    // 过期但还没超过 background 毫秒时：先把旧值返回去，同时在后台刷新
    // （首页"打开就要等几十秒"就是靠这个解决的：先显示上次结果，再悄悄更新）
    background = 0,
    // 调用方传一个对象进来，用来知道这次到底是不是旧值、旧到什么时候
    staleFlag = null,
  } = options;
  const now = Date.now();
  let hit = memory.get(key);
  // 内存里没有的时候先看一眼磁盘：否则"缓存 24 小时"只对当前进程有效，
  // 每次重开应用都要把两百多只票的月线重新拉一遍（实测要 3 分钟）。
  if (!force && !hit && disk) {
    if (loadFromDisk(key) !== undefined) hit = memory.get(key);
  }
  if (!force && hit && now - hit.at < ttl) return hit.value;

  if (!force && hit && background > 0 && now - hit.at < background) {
    if (staleFlag) {
      staleFlag.stale = true;
      staleFlag.at = hit.at;
    }
    // 后台刷新：同一个 key 只跑一次，失败就当没这回事，下次再试
    if (!inflight.has(key)) {
      const refresh = (async () => {
        const value = await producer();
        memory.set(key, { at: Date.now(), value });
        if (disk) saveToDisk(key, value);
        return value;
      })();
      inflight.set(key, refresh);
      refresh.catch(() => {}).finally(() => inflight.delete(key));
    }
    return hit.value;
  }

  if (inflight.has(key)) {
    try {
      return await inflight.get(key);
    } catch (err) {
      // 合并中的请求失败：优先回退旧数据，实在没有就把错误抛出去，
      // 绝不能返回 undefined（否则调用方会拿到"空成功"）。
      if (allowStale && hit) return hit.value;
      const stale = loadFromDisk(key);
      if (stale !== undefined) return stale;
      throw err;
    }
  }

  const task = (async () => {
    const value = await producer();
    memory.set(key, { at: Date.now(), value });
    if (disk) saveToDisk(key, value);
    return value;
  })();

  inflight.set(key, task);
  try {
    return await task;
  } catch (err) {
    if (allowStale) {
      if (hit) return hit.value;
      const fromDisk = loadFromDisk(key);
      if (fromDisk !== undefined) return fromDisk;
    }
    throw err;
  } finally {
    inflight.delete(key);
  }
}

function saveToDisk(key, value) {
  try {
    fs.writeFileSync(diskPath(key), JSON.stringify({ at: Date.now(), value }));
  } catch (_) {
    /* 忽略磁盘写入失败 */
  }
}

function loadFromDisk(key) {
  try {
    const raw = fs.readFileSync(diskPath(key), 'utf8');
    const parsed = JSON.parse(raw);
    memory.set(key, { at: parsed.at, value: parsed.value });
    return parsed.value;
  } catch (_) {
    return undefined;
  }
}

function clearMemory() {
  memory.clear();
}

/** 让某个 key 立刻失效（例如模拟盘重置后） */
function invalidate(key) {
  memory.delete(key);
  try {
    fs.unlinkSync(diskPath(key));
  } catch (_) {
    /* 文件不存在就忽略 */
  }
}

module.exports = { cached, clearMemory, invalidate, loadFromDisk, saveToDisk };
