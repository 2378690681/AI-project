-- ============================================================
-- 单实例数据库（默认 data/kb.db，可用 config.database / KB_DB 指定）
--
-- 一个企业一套服务、一个数据库文件：
--   业务表 + 后台账号 + API 密钥 + 审计 + 向量 全在这一个文件里。
--
-- 为什么不再分库：
--   项目不再做「一套服务托管多个企业」。每个企业单独部署，各自指向
--   自己的 .db 文件（可以在不同机器、不同磁盘、不同加密卷上）。
--   隔离由部署边界保证，比库内 tenant_id 过滤更彻底，也更好运维：
--   备份 = 拷一个文件 + files/ 目录，迁移 = 换一条路径。
--
-- 仍然保留 tenant_id 列（固定等于 config.instance.id，默认 default）：
--   一是历史数据升级平滑，二是所有 SQL 不用重写，三是留一层显式防御。
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 本实例代表的企业（永远只有一行）
CREATE TABLE IF NOT EXISTS instance (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  plan        TEXT NOT NULL DEFAULT 'standard',
  status      TEXT NOT NULL DEFAULT 'active',   -- active | suspended
  meta        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- ---------------- 接入凭证 ----------------

-- API Key（只存哈希，明文仅创建时返回一次）
CREATE TABLE IF NOT EXISTS api_keys (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  name           TEXT,
  key_hash       TEXT NOT NULL UNIQUE,
  key_prefix     TEXT NOT NULL,
  scopes         TEXT NOT NULL,
  rate_limit     INTEGER NOT NULL DEFAULT 120,
  -- 该密钥可读取的最高文档等级：防止「服务侧集成」越级拿到机密文档
  reader_level   INTEGER NOT NULL DEFAULT 5,
  last_used_at   TEXT,
  expires_at     TEXT,
  revoked_at     TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_keys_tenant ON api_keys(tenant_id);

-- 企业后台账号：按角色 + 员工等级区分权限
CREATE TABLE IF NOT EXISTS admin_users (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  email         TEXT NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,               -- scrypt$N$salt$hash
  role          TEXT NOT NULL DEFAULT 'viewer',
  level         INTEGER NOT NULL DEFAULT 1,  -- 员工等级 1~5
  department    TEXT,
  status        TEXT NOT NULL DEFAULT 'active', -- active | disabled
  must_change   INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE(tenant_id, email)
);
CREATE INDEX IF NOT EXISTS idx_admin_tenant ON admin_users(tenant_id, status);

-- 后台会话：Cookie 只存随机 id，服务端比对，可随时吊销
CREATE TABLE IF NOT EXISTS admin_sessions (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_user ON admin_sessions(user_id, expires_at DESC);

-- 审计日志
CREATE TABLE IF NOT EXISTS audit_logs (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT,
  api_key_id TEXT,
  actor      TEXT,                            -- 后台账号 email 或 key id
  action     TEXT NOT NULL,
  target     TEXT,
  query      TEXT,
  status     INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  ip         TEXT,
  error      TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_time ON audit_logs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at DESC);

-- ---------------- 知识内容 ----------------

-- 知识空间（部门/主题分区）
CREATE TABLE IF NOT EXISTS spaces (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE(tenant_id, slug)
);

CREATE TABLE IF NOT EXISTS documents (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  space_id     TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  doc_type     TEXT NOT NULL,
  source_type  TEXT NOT NULL DEFAULT 'http',
  source_uri   TEXT,
  source_hash  TEXT,
  tags         TEXT NOT NULL DEFAULT '[]',
  visibility   TEXT NOT NULL DEFAULT 'internal',  -- internal | restricted
  allowed_roles TEXT NOT NULL DEFAULT '[]',
  -- 阅读等级门槛：员工等级 >= min_level 才能检索到本文档
  min_level    INTEGER NOT NULL DEFAULT 1,
  version      INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'active',
  char_count   INTEGER NOT NULL DEFAULT 0,
  chunk_count  INTEGER NOT NULL DEFAULT 0,
  file_id       TEXT,
  uploader      TEXT,
  original_name TEXT,
  parse_status  TEXT NOT NULL DEFAULT 'ok',
  parse_error   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  indexed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_docs_space ON documents(space_id, status);
CREATE INDEX IF NOT EXISTS idx_docs_source ON documents(source_uri);
CREATE INDEX IF NOT EXISTS idx_docs_uploader ON documents(uploader);
CREATE INDEX IF NOT EXISTS idx_docs_level ON documents(min_level, status);

CREATE TABLE IF NOT EXISTS chunks (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  doc_id      TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  space_id    TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  heading     TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL,
  n_terms     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);
CREATE INDEX IF NOT EXISTS idx_chunks_space ON chunks(space_id);

-- 倒排表：词 -> 块
CREATE TABLE IF NOT EXISTS terms (
  tenant_id TEXT NOT NULL,
  term      TEXT NOT NULL,
  chunk_id  TEXT NOT NULL,
  tf        INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, term, chunk_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_terms_chunk ON terms(chunk_id);

CREATE TABLE IF NOT EXISTS corpus_stats (
  tenant_id   TEXT PRIMARY KEY,
  n_chunks    INTEGER NOT NULL DEFAULT 0,
  total_terms INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS faqs (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  space_id   TEXT,
  question   TEXT NOT NULL,
  answer     TEXT NOT NULL,
  tags       TEXT NOT NULL DEFAULT '[]',
  min_level  INTEGER NOT NULL DEFAULT 1,
  hit_count  INTEGER NOT NULL DEFAULT 0,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_faqs_level ON faqs(min_level, enabled);

-- 原始件元数据（文件本身在 data/files/ 下，按 sha256 去重）
CREATE TABLE IF NOT EXISTS doc_files (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  size         INTEGER NOT NULL,
  mime         TEXT,
  ext          TEXT,
  filename     TEXT,
  storage_path TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE(tenant_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_files_created ON doc_files(created_at DESC);

CREATE TABLE IF NOT EXISTS document_versions (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  doc_id      TEXT NOT NULL,
  version     INTEGER NOT NULL,
  file_id     TEXT,
  title       TEXT,
  char_count  INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  source_hash TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE(doc_id, version)
);
CREATE INDEX IF NOT EXISTS idx_versions_doc ON document_versions(doc_id, version DESC);

CREATE TABLE IF NOT EXISTS sync_cursors (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref  TEXT NOT NULL,
  cursor      TEXT,
  last_run_at TEXT,
  last_status TEXT,
  stats       TEXT,
  UNIQUE(tenant_id, source_type, source_ref)
);

-- ---------------- 向量索引 ----------------

-- 每块一条，Float32 BLOB。256 维 ≈ 1KB/块，10 万块约 100MB。
-- 放在主库而不是单独 vectors.db：单实例部署下少一个文件要备份。
CREATE TABLE IF NOT EXISTS vectors (
  chunk_id   TEXT PRIMARY KEY,
  doc_id     TEXT NOT NULL,
  space_id   TEXT,
  dim        INTEGER NOT NULL,
  model      TEXT NOT NULL,
  vec        BLOB NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vec_doc ON vectors(doc_id);

-- 向量索引元信息（维度、模型、是否就绪）
CREATE TABLE IF NOT EXISTS vec_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
