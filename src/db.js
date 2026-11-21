import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let _db = null;
const _stmt = new Map();

/**
 * 增量迁移：老库升级时补列。
 * 不做版本号体系 —— 加一列就在这张表里加一行，执行时按实际情况判断。
 */
const ADDED_COLUMNS = [
  ['api_keys', 'reader_level', 'INTEGER NOT NULL DEFAULT 5'],
  ['audit_logs', 'actor', 'TEXT'],
  // 兼容老库（升级前业务表还在控制库里）——新装不会命中这些分支
  ['documents', 'file_id', 'TEXT'],
  ['documents', 'uploader', 'TEXT'],
  ['documents', 'original_name', 'TEXT'],
  ['documents', 'parse_status', "TEXT NOT NULL DEFAULT 'ok'"],
  ['documents', 'parse_error', 'TEXT'],
  ['documents', 'min_level', 'INTEGER NOT NULL DEFAULT 1'],
  ['faqs', 'min_level', 'INTEGER NOT NULL DEFAULT 1'],
];

function migrate(db) {
  for (const [table, col, decl] of ADDED_COLUMNS) {
    let cols;
    try {
      cols = db.prepare(`PRAGMA table_info(${table})`).all();
    } catch {
      continue; // 表还不存在时 schema 已建好，无需迁移
    }
    if (!cols.length) continue;
    if (!cols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
    }
  }
}

export function getDb() {
  if (_db) return _db;
  mkdirSync(dirname(config.database), { recursive: true });
  _db = new DatabaseSync(config.database);
  _db.exec('PRAGMA journal_mode = WAL;');
  _db.exec('PRAGMA foreign_keys = ON;');
  _db.exec('PRAGMA busy_timeout = 8000;');
  _db.exec('PRAGMA synchronous = NORMAL;');
  // 读多写少的检索服务，把页缓存和临时表都放内存，减少 IO
  _db.exec('PRAGMA cache_size = -32000;');   // 约 32MB
  _db.exec('PRAGMA temp_store = MEMORY;');
  _db.exec('PRAGMA mmap_size = 268435456;'); // 256MB，大库随机读明显更快
  // 先补列再执行 schema：schema 里可能给新列建索引，
  // 老库如果先建索引会因为「no such column」直接起不来
  migrate(_db);
  _db.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));
  migrate(_db);
  _stmt.clear();
  return _db;
}

function prep(sql) {
  let s = _stmt.get(sql);
  if (!s) {
    s = getDb().prepare(sql);
    _stmt.set(sql, s);
  }
  return s;
}

export { prep };

export const q = {
  get: (sql, ...args) => prep(sql).get(...args),
  all: (sql, ...args) => prep(sql).all(...args),
  run: (sql, ...args) => prep(sql).run(...args),
};

/** 同步事务；fn 内抛错则回滚 */
export function tx(fn) {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

export const now = () => new Date().toISOString();

/** 本实例固定使用的数据标记（保留 tenant_id 列是为了 SQL 不用重写） */
export const instanceId = () => config.instance.id;

/**
 * 确保 instance 表里有本实例那一行。
 * 顺带兼容旧库：如果 tenants 表还在（旧版多租户结构），也补一行同 id，
 * 否则旧的外键约束会让「新建密钥」直接失败。
 */
export function ensureInstance({ name } = {}) {
  const db = getDb();
  const id = config.instance.id;
  const ts = now();
  const nm = name || config.instance.name;
  db.prepare(
    `INSERT INTO instance(id, name, plan, status, meta, created_at, updated_at)
     VALUES(?,?,?,'active','{}',?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at`,
  ).run(id, nm, 'standard', ts, ts);

  try {
    const legacy = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='tenants'`)
      .get();
    if (legacy) {
      db.prepare(
        `INSERT OR IGNORE INTO tenants(id, name, plan, status, meta, created_at, updated_at)
         VALUES(?,?,?,'active','{}',?,?)`,
      ).run(id, nm, 'standard', ts, ts);
    }
  } catch { /* 旧表结构不一致时忽略，不影响主流程 */ }

  return { ...config.instance, name: nm };
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
export function newId(prefix = '') {
  const bytes = randomBytes(10);
  let s = '';
  for (let i = 0; i < 10; i++) s += ALPHABET[bytes[i] % 36];
  return prefix + s;
}

export function jsonParse(v, fallback) {
  if (v == null || v === '') return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

export function qs(v) {
  return JSON.stringify(v ?? []);
}

/** 把外部传入的 slug 规范化 */
export function slugify(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\-\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}
