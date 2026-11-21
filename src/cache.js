/**
 * 进程内 LRU + TTL 缓存。
 *
 * 检索结果高度重复 —— 一个企业里「年假几天」这种问题一天能被问几十次，
 * 每次都走一遍倒排 + 打分是纯浪费。缓存命中直接把 P95 从毫秒级压到微秒级。
 *
 * 失效策略用「写操作递增 epoch」而不是逐条删：
 * 只要有文档入库/删除/重建索引，epoch+1，旧 key 天然再也命中不到，
 * 省掉维护依赖关系图，也不会因为漏删而返回过期结果。
 */

const MAX_ENTRIES = 2000;
const SEARCH_TTL_MS = 120_000; // 检索结果 2 分钟
const ASK_TTL_MS = 180_000;    // 问答结果 3 分钟（含 FAQ 点击计数，不宜过长）

function createLru(max, ttlMs) {
  const map = new Map();
  let hits = 0;
  let misses = 0;

  return {
    get(key) {
      const e = map.get(key);
      if (!e) { misses++; return undefined; }
      if (Date.now() > e.exp) { map.delete(key); misses++; return undefined; }
      // 命中后移到队尾，保证 Map 头部始终是最久未用的
      map.delete(key);
      map.set(key, e);
      hits++;
      return e.value;
    },
    set(key, value, ttl = ttlMs) {
      if (map.size >= max && !map.has(key)) {
        const oldest = map.keys().next().value;
        map.delete(oldest);
      }
      map.set(key, { value, exp: Date.now() + ttl });
    },
    clear() { map.clear(); },
    stats() {
      const total = hits + misses;
      return {
        size: map.size,
        max,
        hits,
        misses,
        hit_rate: total ? Number((hits / total).toFixed(3)) : 0,
      };
    },
  };
}

export const searchCache = createLru(MAX_ENTRIES, SEARCH_TTL_MS);
export const askCache = createLru(MAX_ENTRIES, ASK_TTL_MS);

let epoch = 0;

/** 写操作后调用：整体失效 */
export function bumpEpoch() {
  epoch += 1;
  searchCache.clear();
  askCache.clear();
  return epoch;
}

export function getEpoch() {
  return epoch;
}

/** 缓存 key：把影响结果的条件全部拼进去，避免不同过滤条件互相污染 */
export function cacheKey(parts) {
  return `${epoch}|${parts.map((p) => (p == null ? '' : typeof p === 'object' ? JSON.stringify(p) : String(p))).join('¦')}`;
}

export function cacheStats() {
  return {
    epoch,
    search: searchCache.stats(),
    ask: askCache.stats(),
  };
}
