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
  const { force = false, allowStale = true, disk = true } = options;
  const now = Date.now();
  const hit = memory.get(key);
  if (!force && hit && now - hit.at < ttl) return hit.value;

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
