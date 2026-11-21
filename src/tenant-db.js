import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { getDb, prep, tx, now, instanceId } from './db.js';

/**
 * 单实例数据访问层。
 *
 * 历史背景：早期版本是「一套服务托管多个企业」，每个企业一个
 * data/tenants/<id>/kb.db。现在改成一企一部署 —— 一个企业跑一套服务，
 * 通过 config.database（或环境变量 KB_DB）指向自己的数据库文件。
 *
 * 为了不重写几百条 SQL，这里保留 tdb(tenantId) 的函数签名，但内部
 * 忽略 tenantId，统一走同一个连接；tenant_id 列固定等于 config.instance.id。
 *
 * 旧目录（data/tenants/<id>/）下的数据由 migrateLegacyLayout() 在启动时
 * 一次性并入单库，之后可以整个删掉。
 */

export const TENANT_ID = config.instance.id;

/** 数据目录（原先是 data/tenants/<id>，现在是 data 本身） */
export const tenantDir = (_tenantId) => config.dataDir;
export const tenantDbPath = (_tenantId) => config.database;
/** 向量表已在主库里，保留此函数只为兼容旧调用点 */
export const tenantVecPath = (_tenantId) => config.database;
export const tenantFilesDir = (_tenantId) => config.filesDir;

export function tdb(_tenantId) {
  return {
    get: (sql, ...args) => prep(sql).get(...args),
    all: (sql, ...args) => prep(sql).all(...args),
    run: (sql, ...args) => prep(sql).run(...args),
    exec: (sql) => getDb().exec(sql),
    prepare: (sql) => prep(sql),
    raw: () => getDb(),
    path: config.database,
  };
}

export function ttx(_tenantId, fn) {
  return tx(fn);
}

export const tenantDbExists = (_tenantId) => existsSync(config.database);
export const closeTenantDb = (_tenantId) => { /* 单库常驻，无需关闭 */ };
export const openTenants = () => [TENANT_ID];

// ---------------- 旧目录迁移 ----------------

const BUSINESS_TABLES = [
  'spaces', 'documents', 'chunks', 'terms', 'corpus_stats',
  'faqs', 'doc_files', 'document_versions', 'sync_cursors',
];

function legacyDirs() {
  const root = join(config.dataDir, 'tenants');
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try {
      if (!statSync(join(dir, 'kb.db')).isFile()) continue;
    } catch { continue; }
    out.push({ id: name, dir });
  }
  return out;
}

function tableCols(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  } catch {
    return [];
  }
}

function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    const d = join(dest, name);
    const st = statSync(s);
    if (st.isDirectory()) copyTree(s, d);
    else if (st.isFile() && !existsSync(d)) copyFileSync(s, d);
  }
}

function importBusinessTables(db, srcPath, TID) {
  const src = new DatabaseSync(srcPath);
  const ts = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const t of BUSINESS_TABLES) {
      const destCols = tableCols(db, t);
      if (!destCols.length) continue;
      let rows = [];
      try { rows = src.prepare(`SELECT * FROM ${t}`).all(); } catch { continue; }
      for (const row of rows) {
        if (Object.hasOwn(row, 'tenant_id')) row.tenant_id = TID;
        const use = destCols.filter((c) => row[c] !== undefined);
        if (!use.length) continue;
        db.prepare(
          `INSERT OR REPLACE INTO ${t}(${use.join(',')}) VALUES(${use.map(() => '?').join(',')})`,
        ).run(...use.map((c) => row[c]));
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    src.close();
    throw e;
  }
  src.close();

  // 向量
  const vecPath = join(dirname(srcPath), 'vectors.db');
  if (existsSync(vecPath)) {
    try {
      const vdb = new DatabaseSync(vecPath);
      const rows = vdb.prepare(
        `SELECT chunk_id, doc_id, space_id, dim, model, vec, updated_at FROM vectors`,
      ).all();
      if (rows.length) {
        const stmt = db.prepare(
          `INSERT OR REPLACE INTO vectors(chunk_id, doc_id, space_id, dim, model, vec, updated_at)
           VALUES(?,?,?,?,?,?,?)`,
        );
        db.exec('BEGIN IMMEDIATE');
        for (const r of rows) {
          const buf = r.vec instanceof Uint8Array ? r.vec : new Uint8Array(r.vec);
          stmt.run(r.chunk_id, r.doc_id, r.space_id || null, Number(r.dim) || 0,
            r.model, buf, r.updated_at || ts);
        }
        db.exec('COMMIT');
      }
      const meta = vdb.prepare(`SELECT key, value FROM vec_meta`).all();
      for (const m of meta) {
        db.prepare(
          `INSERT INTO vec_meta(key,value) VALUES(?,?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        ).run(m.key, m.value);
      }
      vdb.close();
    } catch (e) {
      console.error(`[db] 旧向量库导入失败（不影响原文）: ${e.message}`);
    }
  }

  // 原件目录
  const srcFiles = join(dirname(srcPath), 'files');
  if (existsSync(srcFiles)) {
    try { copyTree(srcFiles, config.filesDir); } catch (e) {
      console.error(`[db] 旧原件目录复制失败: ${e.message}`);
    }
  }
}

/** 清空全部业务表（只用于「从旧目录重建单库」这一步，旧目录本身不动） */
function clearBusinessTables(db) {
  const order = [
    'terms', 'chunks', 'document_versions', 'doc_files', 'faqs',
    'sync_cursors', 'corpus_stats', 'documents', 'spaces',
    'vectors', 'vec_meta',
  ];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const t of order) {
      try { db.exec(`DELETE FROM ${t}`); } catch { /* 老库可能缺表 */ }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * 把旧的 data/tenants/<id>/ 数据并入单库。
 *
 * 规则（按优先级选一个「主企业」）：
 *   1. config.instance.legacyTenant 显式指定
 *   2. 旧控制库 tenants 表里最早创建的那一行（正式企业通常先建，评测/测试租户后建）
 *   3. 旧目录中文档最多的那个
 *
 * 选定后：清空单库业务表 → 从该目录导入 → 其他旧租户的密钥撤销、账号禁用、
 * 业务数据从单库移除（原目录仍在 data/tenants/ 下，不会被删）。
 */
export function migrateLegacyLayout() {
  const db = getDb();
  const TID = instanceId();
  const dirs = legacyDirs();

  // ---- 1. 选主企业 ----
  let pickId = config.instance.legacyTenant || '';
  if (!pickId) {
    try {
      const row = db.prepare(`SELECT id FROM tenants ORDER BY created_at LIMIT 1`).get();
      if (row) pickId = row.id;
    } catch { /* 没有 tenants 表就是全新安装 */ }
  }

  let dir = pickId ? dirs.find((d) => d.id === pickId) : null;

  if (!dir && dirs.length) {
    let best = -1;
    let bestDir = null;
    for (const d of dirs) {
      let n = 0;
      try {
        const src = new DatabaseSync(join(d.dir, 'kb.db'));
        n = Number(src.prepare(`SELECT COUNT(*) AS n FROM documents`).get()?.n || 0);
        src.close();
      } catch { /* 坏库跳过 */ }
      if (n > best) { best = n; bestDir = d; }
    }
    if (bestDir) { dir = bestDir; pickId = bestDir.id; }
  }

  if (!pickId) return { imported: null };

  // ---- 2. 有旧目录就从它重建；没有就只把控制库里的行归一 ----
  let imported = null;
  const ownCount = Number(
    db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE tenant_id = ?`).get(TID)?.n || 0,
  );

  if (dir) {
    const srcCount = (() => {
      try {
        const src = new DatabaseSync(join(dir.dir, 'kb.db'));
        const n = Number(src.prepare(`SELECT COUNT(*) AS n FROM documents`).get()?.n || 0);
        src.close();
        return n;
      } catch { return -1; }
    })();

    // 目录是权威来源：单库里若没有本企业数据，或旧控制库还混着多租户遗留，
    // 就整段重建一次（幂等：第二次启动时 ownCount 已 > 0 且无其他租户残留则跳过）
    const mixed = Number(
      db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE tenant_id != ?`).get(TID)?.n || 0,
    ) > 0;

    if (srcCount > 0 && (ownCount === 0 || mixed)) {
      clearBusinessTables(db);
      importBusinessTables(db, join(dir.dir, 'kb.db'), TID);
      imported = { from: pickId, path: dir.dir, documents: srcCount };
    }
  }

  // ---- 3. 归一账号/密钥/会话/审计 ----
  const ts = now();
  for (const t of ['api_keys', 'admin_users', 'admin_sessions', 'audit_logs']) {
    if (!tableCols(db, t).length) continue;
    db.prepare(`UPDATE ${t} SET tenant_id = ? WHERE tenant_id = ?`).run(TID, pickId);
  }

  // ---- 4. 清掉其他旧租户的业务数据（原始目录保留） ----
  let removed = 0;
  for (const t of ['terms', 'chunks', 'document_versions', 'doc_files', 'faqs',
    'sync_cursors', 'corpus_stats', 'documents', 'spaces']) {
    if (!tableCols(db, t).length) continue;
    const r = db.prepare(`DELETE FROM ${t} WHERE tenant_id != ?`).run(TID);
    removed += Number(r.changes || 0);
  }
  try {
    db.exec(`DELETE FROM vectors WHERE doc_id NOT IN (SELECT id FROM documents)`);
  } catch { /* 表不存在时忽略 */ }

  const otherUsers = db.prepare(`SELECT COUNT(*) AS n FROM admin_users WHERE tenant_id != ? AND status='active'`).get(TID);
  if (Number(otherUsers?.n || 0) > 0) {
    db.prepare(`UPDATE admin_users SET status='disabled', updated_at=? WHERE tenant_id != ?`).run(ts, TID);
  }
  const otherKeys = db.prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE tenant_id != ? AND revoked_at IS NULL`).get(TID);
  if (Number(otherKeys?.n || 0) > 0) {
    db.prepare(`UPDATE api_keys SET revoked_at=? WHERE tenant_id != ? AND revoked_at IS NULL`).run(ts, TID);
  }

  if (imported) {
    console.log(`[db] 已从旧目录 ${imported.from} 重建单库：${imported.documents} 篇文档 → ${config.database}`);
  }
  if (removed) {
    console.log(`[db] 单实例化：已从库中移除其他旧租户的 ${removed} 条业务记录（原始目录 data/tenants/ 未删除）`);
  }
  return { imported };
}

/** 让 files 目录一定存在（首次启动时） */
export function ensureFilesDir() {
  mkdirSync(config.filesDir, { recursive: true });
  return config.filesDir;
}
