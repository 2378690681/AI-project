import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './bootstrap.js';

// 企业内部的同义改写非常频繁（限流 / 频率限制 / 流控），
// 词法检索对这类改写天然无能为力，这里在分词前做一次字符串归一。
// 可在 data/synonyms.json 覆盖/追加，格式：{ "标准词": ["变体1","变体2"] }
const DEFAULT_SYNONYMS = {
  限流: ['频率限制', '限速', '流控', '调用频率超限', 'qps 超限'],
  密钥: ['api key', 'apikey', 'api-key', '令牌', 'token', '访问密钥'],
  退款: ['退钱', '退回款项', '退费'],
  发票: ['开票', '票据'],
  入库: ['导入', '上传文档'],
  故障: ['报错', '异常', '挂了', '不可用'],
  备份: ['容灾', '灾备'],
  数据库: ['db', 'sqlite', 'mysql', 'postgres'],
  租户: ['企业', '客户', '账号主体'],
  检索: ['搜索', '查询', '查找'],
};

const FILE = join(ROOT, 'data', 'synonyms.json');
const TTL_MS = 5000;

let cache = { at: 0, list: [] };

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPairs() {
  let raw = DEFAULT_SYNONYMS;
  if (existsSync(FILE)) {
    try {
      raw = { ...DEFAULT_SYNONYMS, ...JSON.parse(readFileSync(FILE, 'utf8')) };
    } catch {
      raw = DEFAULT_SYNONYMS;
    }
  }
  const pairs = [];
  for (const [canon, alts] of Object.entries(raw)) {
    const target = String(canon).toLowerCase();
    for (const a of alts || []) {
      const v = String(a).toLowerCase().trim();
      if (!v || v === target) continue;
      pairs.push([v, target]);
    }
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  return pairs;
}

/** 把文本中的同义变体归一为标准词 */
export function applySynonyms(text) {
  const now = Date.now();
  if (now - cache.at > TTL_MS) {
    cache = { at: now, list: buildPairs() };
  }
  if (!cache.list.length) return text;

  let s = text;
  for (const [from, to] of cache.list) {
    if (!s.includes(from)) continue;
    if (/^[a-z0-9][a-z0-9 .+-]*$/.test(from)) {
      s = s.replace(new RegExp(`(^|[^a-z0-9])${escapeRe(from)}(?![a-z0-9])`, 'g'), (m, p1) => p1 + to);
    } else {
      s = s.split(from).join(to);
    }
  }
  return s;
}
