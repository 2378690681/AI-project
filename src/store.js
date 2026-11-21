import { createHash, randomBytes } from 'node:crypto';
import { q, tx, now, newId, qs, jsonParse, slugify, ensureInstance as dbEnsureInstance, instanceId } from './db.js';
import { tdb, ttx } from './tenant-db.js';
import { config } from './config.js';

const KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const ALL_SCOPES = ['search', 'read', 'write', 'admin'];

/** 单实例：无论调用方传什么 tenantId，实际都落到本企业的标记上 */
const TID = () => instanceId();

function randomKey(len = 36) {
  const bytes = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += KEY_ALPHABET[bytes[i] % 62];
  return s;
}

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

// ---------------- 企业实例 ----------------

/**
 * 本实例代表哪个企业。一个部署只服务一个企业，所以这里永远只有一行。
 * 保留 getTenant 这个名字是为了不牵动几十处调用点。
 */
export function getInstance() {
  const r = q.get(`SELECT * FROM instance WHERE id = ?`, TID());
  if (!r) return null;
  return { ...r, meta: jsonParse(r.meta, {}) };
}

export const getTenant = (_id) => getInstance();

export function ensureInstance({ name } = {}) {
  dbEnsureInstance({ name });
  ensureSpace(TID(), 'default', '默认空间');
  return getInstance();
}

export const listTenants = () => {
  const i = getInstance();
  return i ? [{ id: i.id, name: i.name, plan: i.plan, status: i.status, created_at: i.created_at }] : [];
};

/** 暂停/恢复本实例（暂停后所有密钥失效） */
export function setInstanceStatus(status) {
  q.run(`UPDATE instance SET status = ?, updated_at = ? WHERE id = ?`, status, now(), TID());
}

export const setTenantStatus = (_id, status) => setInstanceStatus(status);

// ---------------- 空间 ----------------

export function ensureSpace(tenantId, slugOrName, name) {
  tenantId = TID();
  const d = tdb(tenantId);
  const slug = slugify(slugOrName || 'default') || 'default';
  const found = d.get(`SELECT * FROM spaces WHERE tenant_id = ? AND slug = ?`, tenantId, slug);
  if (found) return found;
  const id = newId('s_');
  d.run(
    `INSERT INTO spaces(id, tenant_id, slug, name, description, created_at) VALUES(?,?,?,?,?,?)`,
    id, tenantId, slug, name || slugOrName || slug, null, now(),
  );
  return d.get(`SELECT * FROM spaces WHERE id = ?`, id);
}

export function listSpaces(tenantId) {
  tenantId = TID();
  return tdb(tenantId).all(
    `SELECT s.*, (SELECT COUNT(*) FROM documents d WHERE d.space_id = s.id AND d.status = 'active') AS doc_count
     FROM spaces s WHERE s.tenant_id = ? ORDER BY s.created_at`,
    tenantId,
  );
}

// ---------------- API Key ----------------

export function createApiKey({ tenantId, name, scopes = ['search', 'read', 'write'], rateLimit, expiresAt, readerLevel = 5 }) {
  tenantId = TID();
  for (const s of scopes) {
    if (!ALL_SCOPES.includes(s)) throw new Error(`未知 scope: ${s}`);
  }
  const lvl = Math.max(1, Math.min(5, Number(readerLevel) || 5));
  const plain = `kb_live_${randomKey()}`;
  const id = newId('k_');
  const ts = now();
  q.run(
    `INSERT INTO api_keys(id, tenant_id, name, key_hash, key_prefix, scopes, rate_limit, reader_level, expires_at, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    id, tenantId, name || '默认密钥', sha256(plain), plain.slice(0, 16) + '…',
    qs(scopes), Number(rateLimit) || 120, lvl, expiresAt || null, ts,
  );
  return { id, plaintext: plain, keyPrefix: plain.slice(0, 16) + '…', scopes, tenantId, readerLevel: lvl };
}

export function listApiKeys(tenantId) {
  tenantId = TID();
  return q.all(
    `SELECT id, tenant_id, name, key_prefix, scopes, rate_limit, reader_level, last_used_at, expires_at, revoked_at, created_at
     FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC`,
    tenantId,
  );
}

export function revokeApiKey(id) {
  q.run(`UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, now(), id);
  return q.get(`SELECT id, tenant_id, revoked_at FROM api_keys WHERE id = ?`, id);
}

/** 校验明文 key，返回身份信息或 null */
export function verifyApiKey(plain) {
  if (!plain) return null;
  const row = q.get(`SELECT * FROM api_keys WHERE key_hash = ?`, sha256(plain));
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
  // 单实例：只认本企业的标记，旧库里其他企业遗留的密钥一律无效
  if (row.tenant_id !== TID()) return null;
  const tenant = getInstance();
  if (!tenant || tenant.status !== 'active') return null;
  return {
    keyId: row.id,
    tenantId: TID(),
    tenantName: tenant.name,
    scopes: jsonParse(row.scopes, []),
    rateLimit: Number(row.rate_limit) || 120,
    readerLevel: Number(row.reader_level) || 5,
  };
}

export function touchApiKey(id) {
  q.run(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`, now(), id);
}

/** 管理根密钥（config.rootKey / 环境变量 KB_ROOT_KEY），不属于任何租户 */
export function isRootKey(plain) {
  const root = config.rootKey || process.env.KB_ROOT_KEY;
  if (!root || !plain) return false;
  const a = createHash('sha256').update(root).digest();
  const b = createHash('sha256').update(plain).digest();
  return a.equals(b);
}

// ---------------- 文档查询 ----------------

export function listDocuments(tenantId, { spaceId, tag, limit = 20, offset = 0, q: kw, uploader, minLevel = null, status = 'active' } = {}) {
  tenantId = TID();
  const d = tdb(tenantId);
  const where = [`tenant_id = ?`, `status = ?`];
  const args = [tenantId, status || 'active'];
  if (spaceId) { where.push('space_id = ?'); args.push(spaceId); }
  if (tag) { where.push(`tags LIKE ?`); args.push(`%"${tag}"%`); }
  if (kw) { where.push('title LIKE ?'); args.push(`%${kw}%`); }
  if (uploader) { where.push('uploader = ?'); args.push(uploader); }
  // minLevel 为 null 表示不按密级筛选（后台 owner / CLI 运维视角）；
  // 传 1~5 则只返回不高于该等级的文档。注意不能把 1 当成「不筛选」，
  // 否则 L2 及以上的机密文档会漏到只有 L1 权限的调用方面前。
  if (minLevel != null && minLevel !== '') {
    where.push('min_level <= ?');
    args.push(Math.max(1, Math.min(5, Number(minLevel) || 1)));
  }

  const total = d.get(`SELECT COUNT(*) AS n FROM documents WHERE ${where.join(' AND ')}`, ...args).n;
  const rows = d.all(
    `SELECT id, space_id, title, doc_type, source_type, source_uri, tags, visibility,
            min_level, version, char_count, chunk_count, created_at, updated_at,
            uploader, original_name, file_id, parse_status
     FROM documents WHERE ${where.join(' AND ')}
     ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    ...args, Math.min(200, Number(limit) || 20), Math.max(0, Number(offset) || 0),
  );
  return { total: Number(total), items: rows.map(withParsedTags) };
}

export function getDocument(tenantId, docId, { withChunks = false } = {}) {
  tenantId = TID();
  const d = tdb(tenantId);
  const doc = d.get(`SELECT * FROM documents WHERE id = ? AND tenant_id = ?`, docId, tenantId);
  if (!doc) return null;
  const out = withParsedTags(doc);
  out.allowed_roles = jsonParse(doc.allowed_roles, []);
  if (withChunks) {
    out.chunks = d.all(
      `SELECT id, seq, heading, content FROM chunks WHERE doc_id = ? ORDER BY seq`,
      docId,
    );
  }
  return out;
}

function withParsedTags(r) {
  if (!r) return r;
  return { ...r, tags: jsonParse(r.tags, []) };
}

// ---------------- FAQ ----------------

export function createFaq({ tenantId, spaceId = null, question, answer, tags = [], minLevel = 1 }) {
  tenantId = TID();
  if (!String(question || '').trim() || !String(answer || '').trim()) {
    throw new Error('question 与 answer 均不能为空');
  }
  const d = tdb(tenantId);
  const id = newId('f_');
  const ts = now();
  d.run(
    `INSERT INTO faqs(id, tenant_id, space_id, question, answer, tags, min_level, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    id, tenantId, spaceId, String(question).trim(), String(answer).trim(), qs(tags),
    Math.max(1, Math.min(5, Number(minLevel) || 1)), ts, ts,
  );
  return getFaq(tenantId, id);
}

export function getFaq(tenantId, id) {
  tenantId = TID();
  const r = tdb(tenantId).get(`SELECT * FROM faqs WHERE id = ? AND tenant_id = ?`, id, tenantId);
  return withParsedTags(r);
}

export function listFaqs(tenantId, { limit = 50, offset = 0, minLevel = null, enabled = null } = {}) {
  tenantId = TID();
  const d = tdb(tenantId);
  const where = ['tenant_id = ?'];
  const args = [tenantId];
  // 密级过滤同样不能省：FAQ 里也可能写着不能全员可见的口径
  if (minLevel != null && minLevel !== '') {
    where.push('min_level <= ?');
    args.push(Math.max(1, Math.min(5, Number(minLevel) || 1)));
  }
  if (enabled != null) { where.push('enabled = ?'); args.push(enabled ? 1 : 0); }
  const w = where.join(' AND ');
  const total = d.get(`SELECT COUNT(*) AS n FROM faqs WHERE ${w}`, ...args).n;
  const items = d.all(
    `SELECT * FROM faqs WHERE ${w} ORDER BY hit_count DESC, created_at DESC LIMIT ? OFFSET ?`,
    ...args, Math.min(200, Number(limit) || 50), Math.max(0, Number(offset) || 0),
  );
  return { total: Number(total), items: items.map(withParsedTags) };
}

export function deleteFaq(tenantId, id) {
  tenantId = TID();
  const d = tdb(tenantId);
  const r = d.get(`SELECT * FROM faqs WHERE id = ? AND tenant_id = ?`, id, tenantId);
  if (!r) return null;
  d.run(`DELETE FROM faqs WHERE id = ?`, id);
  return r;
}

export function bumpFaqHit(tenantId, ids) {
  tenantId = TID();
  const d = tdb(tenantId);
  for (const id of ids) d.run(`UPDATE faqs SET hit_count = hit_count + 1 WHERE id = ?`, id);
}

/** 设置文档的阅读等级门槛（管理后台用） */
export function setDocumentLevel(tenantId, docId, minLevel) {
  tenantId = TID();
  const lvl = Math.max(1, Math.min(5, Number(minLevel) || 1));
  const d = tdb(tenantId);
  d.run(`UPDATE documents SET min_level = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
    lvl, now(), docId, tenantId);
  return getDocument(tenantId, docId);
}
