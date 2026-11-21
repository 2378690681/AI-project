import http from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { config, llmEnabled } from './config.js';
import { q, now, jsonParse, instanceId } from './db.js';
import { tdb } from './tenant-db.js';
import {
  verifyApiKey, isRootKey, touchApiKey,
  ensureInstance, listTenants, getTenant, setTenantStatus,
  ensureSpace, listSpaces, createApiKey, listApiKeys, revokeApiKey,
  listDocuments, getDocument, createFaq, listFaqs, deleteFaq,
} from './store.js';
import { search, getStats } from './indexer.js';
import { ask } from './answer.js';
import { ingestDocument, ingestBinary, deleteDocument, reindexTenant } from './ingest.js';
import { parseDocxBuffer, parseHtml, detectType, guessTitle, SUPPORTED_EXTENSIONS } from './parsers.js';
import { parseMultipart, isMultipart } from './multipart.js';
import { getFileRecord, readFileBuffer, storageStats } from './storage.js';
import { cacheStats } from './cache.js';
import { vectorStats } from './vectors.js';
import { embedQuery } from './embed.js';
import { ensureOwner, LEVELS, DOC_LEVELS, ROLES, ROLE_KEYS } from './rbac.js';
import { handleAdmin } from './admin.js';

const VERSION = '0.1.0';

/**
 * 控制台页面在进程启动时读入内存。
 * 故意做成可选：文件缺失时 /console 返回提示而不是让整个服务起不来。
 */
const CONSOLE_HTML = (() => {
  try {
    return readFileSync(fileURLToPath(new URL('../public/console.html', import.meta.url)), 'utf8');
  } catch {
    return null;
  }
})();

/**
 * 接口契约也一起对外暴露：企业对接方拉一次就能生成 SDK / 导入 Postman / Apifox，
 * 不用再来找我们要文件。读不到就返回 null，接口 404 而不是让服务起不来。
 */
const OPENAPI_JSON = (() => {
  try {
    return readFileSync(fileURLToPath(new URL('../docs/openapi.json', import.meta.url)), 'utf8');
  } catch {
    return null;
  }
})();

class ApiError extends Error {
  constructor(status, code, message, headers) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers || {};
  }
}

// ---------------- 基础工具 ----------------

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > config.maxBodyBytes) {
        reject(new ApiError(413, 'payload_too_large', `请求体超过 ${Math.round(config.maxBodyBytes / 1048576)}MB`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    throw new Error('body 必须是 JSON 对象');
  } catch (e) {
    throw new ApiError(400, 'invalid_json', `请求体不是合法 JSON: ${e.message}`);
  }
}

/** 表单里的 tags 可能是 "a,b" 字符串，也可能是数组 */
function parseTags(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v).split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
}

/** 上传接口的公共响应片段，保证 multipart 与 JSON 两种入口返回一致 */
function uploadSummary(items) {
  const failed = items.filter((i) => i.status === 'failed').length;
  const parseFailed = items.filter((i) => i.parseStatus === 'failed').length;
  return {
    total: items.length,
    succeeded: items.length - failed,
    failed,
    parse_failed: parseFailed,
    items,
    ...(parseFailed
      ? { hint: '有文件未能抽出文字（可能是扫描件或纯图片）。原始件已保存，可下载查看，或上传可复制文本的版本。' }
      : {}),
  };
}

// ---------------- 认证与限流 ----------------
function extractToken(req) {
  const h = String(req.headers.authorization || '');
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  const k = req.headers['x-api-key'];
  if (k) return String(k).trim();
  return '';
}

function authenticate(req) {
  const token = extractToken(req);
  if (!token) {
    throw new ApiError(401, 'unauthorized', '缺少凭证：请传 Authorization: Bearer <API_KEY> 或 X-API-Key');
  }
  if (isRootKey(token)) {
    return { root: true, keyId: 'root', tenantId: null, scopes: ['*'], rateLimit: 100000 };
  }
  const id = verifyApiKey(token);
  if (!id) {
    throw new ApiError(401, 'unauthorized', 'API Key 无效、已吊销、已过期，或所属租户被停用');
  }
  touchApiKey(id.keyId);
  return id;
}

const buckets = new Map();
function checkRate(auth) {
  const limit = auth.rateLimit || config.defaultRateLimit;
  if (!limit) return;
  const t = Date.now();
  let b = buckets.get(auth.keyId);
  if (!b || t >= b.reset) {
    b = { count: 0, reset: t + 60000 };
    buckets.set(auth.keyId, b);
  }
  b.count += 1;
  if (b.count > limit) {
    const retry = Math.max(1, Math.ceil((b.reset - t) / 1000));
    throw new ApiError(429, 'rate_limited', `超出速率限制（${limit} 次/分钟），请 ${retry} 秒后重试`, {
      'Retry-After': String(retry),
      'X-RateLimit-Limit': String(limit),
      'X-RateLimit-Remaining': '0',
    });
  }
}

function requireScope(auth, scope) {
  if (auth.root) return;
  if (!auth.scopes.includes(scope)) {
    throw new ApiError(403, 'forbidden', `当前密钥缺少 ${scope} 权限（现有：${auth.scopes.join(',') || '无'}）`);
  }
}

function requireRoot(auth) {
  if (!auth.root) throw new ApiError(403, 'forbidden', '该接口仅限管理根密钥调用');
}

function requireTenant(auth) {
  // 单实例部署：根密钥和业务密钥都落在本企业上，不存在「需要指定租户」的情况
  return auth.tenantId || instanceId();
}

/**
 * 本次请求实际生效的数据等级。
 * 密钥自带 reader_level 是硬上限，调用方只能往下压——比如同一个企业里
 * 客服子系统用同一把密钥、但每次按员工等级传 level，不该看到更高密级的东西。
 */
function effectiveLevel(auth, raw) {
  const cap = Math.min(5, Math.max(1, Number(auth.readerLevel) || 5));
  const n = Number(raw);
  const want = Number.isFinite(n) && n >= 1 && n <= 5 ? n : 5;
  return Math.min(cap, want);
}

// ---------------- 审计 ----------------

function writeAudit(entry) {
  try {
    q.run(
      `INSERT INTO audit_logs(id, tenant_id, api_key_id, actor, action, target, query, status, latency_ms, ip, error, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      randomUUID(), entry.tenantId, entry.keyId, entry.actor || entry.keyId, entry.action, entry.target,
      entry.query, entry.status, entry.latency, entry.ip, entry.error, now(),
    );
  } catch {
    /* 审计失败不影响主流程 */
  }
}

// ---------------- 路由 ----------------

/** 本企业详情：给 /v1/admin/instance 与兼容的 /v1/admin/tenants 共用 */
function instanceDetail(tenantId) {
  const t = getTenant(tenantId);
  return {
    ...(t || { id: tenantId, name: config.instance.name }),
    database: config.database,
    database_bytes: (() => {
      try { return statSync(config.database).size; } catch { return 0; }
    })(),
    stats: getStats(tenantId),
    vectors: vectorStats(tenantId),
    storage: storageStats(tenantId),
    spaces: listSpaces(tenantId),
    keys: listApiKeys(tenantId),
    members: q.all(
      `SELECT id, email, name, role, level, department, status, last_login_at, created_at
       FROM admin_users ORDER BY level DESC, created_at`,
    ),
  };
}

async function route(req, url, auth, ctx) {
  const method = req.method.toUpperCase();
  const seg = url.pathname.split('/').filter(Boolean);

  if (method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    if (url.pathname === '/') {
      return {
        status: 200,
        raw: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>KB Hub</title>
<body style="font:14px/1.7 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;max-width:720px;margin:60px auto;padding:0 20px;color:#222">
<h1 style="font-size:20px">企业外置知识库 · KB Hub</h1>
<p>服务运行中（v${VERSION}）。这是一个开放接口服务，同时提供一个浏览器调试控制台。</p>
<p><a href="/console" style="display:inline-block;background:#2b5cf0;color:#fff;text-decoration:none;padding:9px 18px;border-radius:8px;font-weight:600">打开控制台 →</a></p>
<ul style="line-height:2">
<li><code>GET /health</code> — 健康检查</li>
<li><code>GET /v1/meta</code> — 当前租户信息与语料规模</li>
<li><code>POST /v1/search</code> — 检索原文片段</li>
<li><code>POST /v1/ask</code> — 问答（带引用）</li>
<li><code>POST /v1/documents</code> — 文档入库</li>
</ul>
<p style="color:#666">所有 /v1/* 接口需要 <code>Authorization: Bearer &lt;API_KEY&gt;</code>。</p>
</body></html>`,
        contentType: 'text/html; charset=utf-8',
      };
    }
    return {
      status: 200,
      body: {
        status: 'ok',
        version: VERSION,
        uptime_sec: Math.floor(process.uptime()),
        llm: llmEnabled() ? 'enabled' : 'disabled (extractive fallback)',
        time: now(),
      },
    };
  }

  // 内置调试控制台（无需鉴权：它本身只是个前端页面，数据仍要 API Key）
  if (method === 'GET' && (url.pathname === '/console' || url.pathname === '/console/')) {
    if (!CONSOLE_HTML) {
      return {
        status: 503,
        raw: '<meta charset="utf-8"><p>控制台页面缺失：public/console.html 未找到。</p>',
        contentType: 'text/html; charset=utf-8',
      };
    }
    return { status: 200, raw: CONSOLE_HTML, contentType: 'text/html; charset=utf-8' };
  }

  // 接口契约（OpenAPI 3.1）：对接方直接拉这个地址
  if (method === 'GET' && (url.pathname === '/openapi.json' || url.pathname === '/docs/openapi.json')) {
    if (!OPENAPI_JSON) throw new ApiError(404, 'not_found', '接口契约文件缺失：docs/openapi.json');
    return {
      status: 200,
      raw: OPENAPI_JSON,
      contentType: 'application/json; charset=utf-8',
      headers: { 'Cache-Control': 'no-cache' },
    };
  }

  if (!seg.length || seg[0] !== 'v1') {
    throw new ApiError(404, 'not_found', `未知路径: ${url.pathname}`);
  }

  // ---------- 租户自助接口 ----------
  if (seg[1] === 'meta' && method === 'GET') {
    const tenantId = requireTenant(auth);
    const tenant = getTenant(tenantId);
    const stats = getStats(tenantId);
    const d = tdb(tenantId);
    // 概览数字也按等级口径给：给客服看「10 篇文档」但只能查到 7 篇，会让人以为检索坏了
    const lv = Math.min(5, Math.max(1, Number(auth.readerLevel) || 5));
    const visDocs = `SELECT COUNT(*) AS n FROM documents WHERE tenant_id = ? AND status='active' AND min_level <= ?`;
    return {
      status: 200,
      body: {
        tenant: { id: tenant.id, name: tenant.name, plan: tenant.plan, status: tenant.status },
        scopes: auth.scopes,
        reader_level: lv,
        corpus: {
          chunks: d.get(
            `SELECT COUNT(*) AS n FROM chunks c JOIN documents doc ON doc.id = c.doc_id WHERE doc.min_level <= ?`,
            lv,
          ).n,
          documents: d.get(visDocs, tenantId, lv).n,
          faqs: d.get(`SELECT COUNT(*) AS n FROM faqs WHERE tenant_id = ? AND enabled=1 AND min_level <= ?`, tenantId, lv).n,
          avg_chunk_terms: Number(stats.avg_len.toFixed(1)),
          total_documents: d.get(`SELECT COUNT(*) AS n FROM documents WHERE tenant_id = ? AND status='active'`, tenantId).n,
          parse_failed: d.get(
            `SELECT COUNT(*) AS n FROM documents WHERE tenant_id = ? AND status='active' AND parse_status='failed' AND min_level <= ?`,
            tenantId, lv,
          ).n,
          storage: storageStats(tenantId),
          vectors: vectorStats(tenantId),
          database: d.path,
        },
        spaces: listSpaces(tenantId).map((s) => ({ id: s.id, slug: s.slug, name: s.name, doc_count: s.doc_count })),
        capabilities: {
          retrieval: 'hybrid-bm25-vector',
          answer_mode: llmEnabled() ? 'llm' : 'extractive',
          max_top_k: 50,
          max_body_mb: Math.round(config.maxBodyBytes / 1048576),
          max_upload_files: 20,
          supported_formats: SUPPORTED_EXTENSIONS,
          original_file_download: true,
          version_history: true,
          // 一个企业一套服务、一个数据库文件；隔离靠部署边界而不是库内 tenant_id
          isolation: 'single-instance-database',
          instance: { id: config.instance.id, name: config.instance.name },
          access_levels: LEVELS,
          doc_levels: DOC_LEVELS,
          roles: ROLE_KEYS.map((k) => ({ key: k, name: ROLES[k].name })),
        },
      },
    };
  }

  if (seg[1] === 'search' && method === 'POST') {
    requireScope(auth, 'search');
    const tenantId = requireTenant(auth);
    const body = await readJson(req);
    const query = String(body.query || body.q || '').trim();
    if (!query) throw new ApiError(400, 'bad_request', 'query 不能为空');
    ctx.query = query;
    // 调用方可以再压低等级（例如某个低权限子系统），但抬不过密钥自身的 reader_level
    const minLevel = effectiveLevel(auth, body.level);
    const queryVec = body.vector === false ? null : await embedQuery(query);
    const r = search(tenantId, {
      query,
      spaceId: body.space_id || null,
      tags: body.tags || [],
      topK: body.top_k,
      minScore: body.min_score,
      roles: body.roles || [],
      minLevel,
      queryVec,
      vector: body.vector !== false,
      plain: body.plain === true,
      // 带 debug 时绕开缓存，方便排查「为什么这条排在前面」
      debug: body.debug === true,
      expand: body.expand !== false,
    });
    return {
      status: 200,
      body: {
        query,
        total: r.total,
        took_ms: r.took_ms,
        cached: r.cached === true,
        query_terms: r.query_terms,
        reader_level: minLevel,
        retrieval: r.retrieval,
        hits: r.hits,
      },
    };
  }

  if (seg[1] === 'ask' && method === 'POST') {
    requireScope(auth, 'search');
    const tenantId = requireTenant(auth);
    const body = await readJson(req);
    const query = String(body.query || body.q || '').trim();
    if (!query) throw new ApiError(400, 'bad_request', 'query 不能为空');
    ctx.query = query;
    const minLevel = effectiveLevel(auth, body.level);
    const r = await ask({
      tenantId,
      query,
      spaceId: body.space_id || null,
      topK: body.top_k,
      roles: body.roles || [],
      minLevel,
      queryVec: await embedQuery(query),
      minConfidence: body.min_faq_confidence ?? 0.5,
    });
    return { status: 200, body: { query, reader_level: minLevel, ...r } };
  }

  // ---------- 文件上传（员工入口，支持 multipart 与 JSON base64） ----------
  if (seg[1] === 'uploads' && method === 'POST') {
    requireScope(auth, 'write');
    const tenantId = requireTenant(auth);
    const ct = String(req.headers['content-type'] || '');

    let files = [];
    let fields = {};

    if (isMultipart(ct)) {
      const body = await readBody(req);
      const parsed = parseMultipart(body, ct);
      files = parsed.files;
      fields = parsed.fields;
    } else {
      const body = await readJson(req);
      fields = body;
      if (Array.isArray(body.files)) {
        files = body.files.map((f) => ({
          field: 'file',
          filename: f.filename || 'unnamed.txt',
          data: Buffer.from(String(f.base64 || f.file_base64 || ''), 'base64'),
        }));
      } else {
        // 单文件：兼容 file_base64 / base64 两种写法
        const b64 = body.file_base64 || body.base64 || body.content_base64;
        if (b64) {
          files = [{
            field: 'file',
            filename: body.filename || 'unnamed.txt',
            data: Buffer.from(String(b64), 'base64'),
          }];
        }
      }
    }

    if (!files.length) {
      throw new ApiError(400, 'bad_request', `没有收到文件。支持格式：${SUPPORTED_EXTENSIONS.join(' ')}`);
    }
    if (files.length > 20) throw new ApiError(400, 'bad_request', '单次最多上传 20 个文件，请分批');

    const tags = parseTags(fields.tags);
    const items = [];

    for (const f of files) {
      if (!f.data.length) {
        items.push({ filename: f.filename, status: 'failed', error: '文件为空' });
        continue;
      }
      try {
        const r = ingestBinary({
          tenantId,
          buffer: f.data,
          filename: f.filename,
          spaceId: fields.space_id || null,
          space: fields.space || null,
          tags,
          uploader: fields.uploader || null,
          visibility: fields.visibility || null,
          minLevel: Math.min(effectiveLevel(auth, null), Math.max(1, Math.min(5, Number(fields.min_level) || 1))),
        });
        items.push({ filename: f.filename, bytes: f.data.length, ...r });
        if (ctx.target == null && r.docId) ctx.target = r.docId;
      } catch (e) {
        items.push({ filename: f.filename, bytes: f.data.length, status: 'failed', error: e.message });
      }
    }

    const summary = uploadSummary(items);
    return { status: summary.succeeded ? 201 : 400, body: summary };
  }

  if (seg[1] === 'documents') {
    const tenantId = requireTenant(auth);
    const id = seg[2];

    // 下载原始件：员工上传什么，就能原样拿回什么
    if (method === 'GET' && id && seg[3] === 'file') {
      requireScope(auth, 'read');
      const d = tdb(tenantId);
      const doc = d.get(
        `SELECT id, title, file_id, original_name, min_level FROM documents WHERE id = ? AND tenant_id = ?`,
        id, tenantId,
      );
      if (!doc) throw new ApiError(404, 'not_found', `文档不存在: ${id}`);
      if (Number(doc.min_level) > effectiveLevel(auth, url.searchParams.get('level'))) {
        throw new ApiError(403, 'forbidden', '该文档的密级高于当前读取等级');
      }
      if (!doc.file_id) {
        throw new ApiError(404, 'no_original', '该文档没有原始件（可能是通过正文接口录入的文本）');
      }
      const rec = getFileRecord(tenantId, doc.file_id);
      if (!rec) throw new ApiError(404, 'no_original', '原始件记录不存在或已被清理');

      const buf = readFileBuffer(rec, tenantId);
      const name = doc.original_name || rec.filename || `${doc.title}${rec.ext || ''}`;
      ctx.target = id;
      return {
        status: 200,
        buffer: buf,
        contentType: rec.mime,
        headers: {
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          'ETag': `"${rec.sha256}"`,
          'X-File-Sha256': rec.sha256,
        },
      };
    }

    // 版本历史：谁在什么时候传了个什么版本，能查能回溯
    if (method === 'GET' && id && seg[3] === 'versions') {
      requireScope(auth, 'read');
      const versions = tdb(tenantId).all(
        `SELECT id, version, file_id, title, char_count, chunk_count, source_hash, note, created_at
         FROM document_versions WHERE doc_id = ? AND tenant_id = ? ORDER BY version DESC`,
        id, tenantId,
      );
      if (!versions.length) throw new ApiError(404, 'not_found', `文档不存在或没有版本记录: ${id}`);
      return { status: 200, body: { doc_id: id, total: versions.length, versions } };
    }

    if (method === 'GET' && !id) {
      requireScope(auth, 'read');
      const r = listDocuments(tenantId, {
        spaceId: url.searchParams.get('space_id'),
        tag: url.searchParams.get('tag'),
        q: url.searchParams.get('q'),
        uploader: url.searchParams.get('uploader'),
        limit: url.searchParams.get('limit'),
        offset: url.searchParams.get('offset'),
        minLevel: effectiveLevel(auth, url.searchParams.get('level')),
      });
      return { status: 200, body: r };
    }

    if (method === 'GET' && id) {
      requireScope(auth, 'read');
      const doc = getDocument(tenantId, id, { withChunks: url.searchParams.get('with_chunks') === '1' });
      if (!doc) throw new ApiError(404, 'not_found', `文档不存在: ${id}`);
      if (Number(doc.min_level) > effectiveLevel(auth, url.searchParams.get('level'))) {
        throw new ApiError(403, 'forbidden', '该文档的密级高于当前读取等级');
      }
      return { status: 200, body: doc };
    }

    if (method === 'POST' && !id) {
      requireScope(auth, 'write');
      const body = await readJson(req);

      // 只给文件、不给正文：走统一的二进制入库（存原始件 + 多格式解析 + 解析失败兜底）
      if (body.file_base64 && !String(body.content || body.text || '').trim()) {
        const buf = Buffer.from(String(body.file_base64), 'base64');
        if (!buf.length) throw new ApiError(400, 'bad_request', 'file_base64 解码后为空');
        const r = ingestBinary({
          tenantId,
          buffer: buf,
          filename: body.filename || body.title || 'unnamed.txt',
          spaceId: body.space_id,
          space: body.space,
          tags: body.tags,
          uploader: body.uploader,
          visibility: body.visibility,
          minLevel: Math.min(effectiveLevel(auth, null), Math.max(1, Math.min(5, Number(body.min_level) || 1))),
        });
        ctx.target = r.docId;
        return { status: r.status === 'created' ? 201 : 200, body: r };
      }

      const text = String(body.content || body.text || '');
      if (!text.trim()) throw new ApiError(400, 'bad_request', 'content 或 file_base64 至少提供一个');

      const r = ingestDocument({
        tenantId,
        spaceId: body.space_id,
        spaceSlug: body.space,
        title: body.title || guessTitle(text),
        text,
        docType: body.doc_type || 'md',
        sourceType: body.source_type || 'http',
        sourceUri: body.source_uri || null,
        tags: body.tags || [],
        visibility: body.visibility,
        allowedRoles: body.allowed_roles || [],
        uploader: body.uploader || null,
        minLevel: Math.min(effectiveLevel(auth, null), Math.max(1, Math.min(5, Number(body.min_level) || 1))),
      });
      ctx.target = r.docId;
      return { status: r.status === 'created' ? 201 : 200, body: r };
    }

    if (method === 'DELETE' && id) {
      requireScope(auth, 'write');
      const r = deleteDocument(tenantId, id);
      if (!r) throw new ApiError(404, 'not_found', `文档不存在: ${id}`);
      ctx.target = id;
      return { status: 200, body: { deleted: true, doc_id: id, title: r.title } };
    }
  }

  if (seg[1] === 'spaces') {
    const tenantId = requireTenant(auth);
    if (method === 'GET') {
      requireScope(auth, 'read');
      return { status: 200, body: { items: listSpaces(tenantId) } };
    }
    if (method === 'POST') {
      requireScope(auth, 'admin');
      const body = await readJson(req);
      if (!body.slug && !body.name) throw new ApiError(400, 'bad_request', 'slug 或 name 至少提供一个');
      const s = ensureSpace(tenantId, body.slug || body.name, body.name);
      return { status: 201, body: s };
    }
  }

  if (seg[1] === 'faqs') {
    const tenantId = requireTenant(auth);
    const id = seg[2];
    if (method === 'GET' && !id) {
      requireScope(auth, 'read');
      return { status: 200, body: listFaqs(tenantId, {
        limit: url.searchParams.get('limit'),
        offset: url.searchParams.get('offset'),
        minLevel: effectiveLevel(auth, url.searchParams.get('level')),
      }) };
    }
    if (method === 'POST' && !id) {
      requireScope(auth, 'write');
      const body = await readJson(req);
      const f = createFaq({
        tenantId,
        spaceId: body.space_id || null,
        question: body.question,
        answer: body.answer,
        tags: body.tags || [],
        minLevel: Math.min(effectiveLevel(auth, null), Math.max(1, Math.min(5, Number(body.min_level) || 1))),
      });
      return { status: 201, body: f };
    }
    if (method === 'DELETE' && id) {
      requireScope(auth, 'write');
      const r = deleteFaq(tenantId, id);
      if (!r) throw new ApiError(404, 'not_found', `FAQ 不存在: ${id}`);
      return { status: 200, body: { deleted: true, id } };
    }
  }

  if (seg[1] === 'audit' && method === 'GET') {
    requireScope(auth, 'admin');
    const tenantId = requireTenant(auth);
    const limit = Math.min(200, Number(url.searchParams.get('limit')) || 50);
    const items = q.all(
      `SELECT id, action, target, query, status, latency_ms, ip, created_at
       FROM audit_logs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`,
      tenantId, limit,
    );
    return { status: 200, body: { items } };
  }

  // ---------- 管理接口（根密钥） ----------
  if (seg[1] === 'admin') {
    requireRoot(auth);
    const TID = instanceId();

    // 本企业信息。单实例部署，没有「切换企业」这一说。
    if (seg[2] === 'instance') {
      if (method === 'GET' && !seg[3]) {
        return { status: 200, body: instanceDetail(TID) };
      }
      if (method === 'PATCH' && !seg[3]) {
        const body = await readJson(req);
        if (body.name) ensureInstance({ name: String(body.name).slice(0, 80) });
        if (body.status) {
          if (!['active', 'suspended'].includes(body.status)) {
            throw new ApiError(400, 'bad_request', 'status 只能是 active 或 suspended');
          }
          setTenantStatus(TID, body.status);
        }
        return { status: 200, body: instanceDetail(TID) };
      }
    }

    // 接入密钥
    if (seg[2] === 'keys') {
      if (method === 'GET' && !seg[3]) {
        return { status: 200, body: { items: listApiKeys(TID) } };
      }
      if (method === 'POST' && !seg[3]) {
        const body = await readJson(req);
        const key = createApiKey({
          tenantId: TID,
          name: body.name,
          scopes: body.scopes || ['search', 'read', 'write'],
          rateLimit: body.rate_limit,
          expiresAt: body.expires_at,
          readerLevel: body.reader_level,
        });
        return {
          status: 201,
          body: {
            id: key.id, plaintext: key.plaintext, scopes: key.scopes,
            reader_level: key.readerLevel,
            warning: '明文密钥只在此刻返回一次',
          },
        };
      }
      if (method === 'DELETE' && seg[3]) {
        const r = revokeApiKey(seg[3]);
        if (!r) throw new ApiError(404, 'not_found', `密钥不存在: ${seg[3]}`);
        return { status: 200, body: { revoked: true, id: seg[3] } };
      }
    }

    // 重建倒排索引与向量
    if (seg[2] === 'reindex' && method === 'POST') {
      return { status: 200, body: reindexTenant(TID) };
    }

    // 运维总览
    if (seg[2] === 'stats' && method === 'GET') {
      const d = tdb(TID);
      return {
        status: 200,
        body: {
          instance: getTenant(TID),
          tenants: 1,
          members: q.get(`SELECT COUNT(*) AS n FROM admin_users WHERE status='active'`).n,
          documents: Number(d.get(`SELECT COUNT(*) AS n FROM documents WHERE status='active'`)?.n || 0),
          chunks: Number(d.get(`SELECT COUNT(*) AS n FROM chunks`)?.n || 0),
          terms: Number(d.get(`SELECT COUNT(*) AS n FROM terms`)?.n || 0),
          files: Number(d.get(`SELECT COUNT(*) AS n FROM doc_files`)?.n || 0),
          file_bytes: Number(d.get(`SELECT COALESCE(SUM(size),0) AS n FROM doc_files`)?.n || 0),
          vectors: vectorStats(TID).chunks,
          queries_24h: q.get(
            `SELECT COUNT(*) AS n FROM audit_logs WHERE action IN ('search','ask') AND created_at > ?`,
            new Date(Date.now() - 86400000).toISOString(),
          ).n,
          cache: cacheStats(),
          isolation: 'single-instance-database',
          database: config.database,
        },
      };
    }

    // ---- 兼容旧客户端：/v1/admin/tenants ----
    // 多企业模式已下线。这里只做只读映射，方便老脚本继续跑；
    // 新建租户直接拒绝，避免用户以为还能一套服务管多个企业。
    if (seg[2] === 'tenants') {
      if (method === 'POST' && !seg[3]) {
        throw new ApiError(
          410, 'gone',
          '已改为单实例部署：一个企业一套服务、一个数据库文件。请部署新实例并用 config.database / KB_DB 指定它自己的库',
        );
      }
      if (method === 'GET' && !seg[3]) {
        return {
          status: 200,
          body: { items: [instanceDetail(TID)], deprecated: '多企业模式已下线，items 只包含本实例' },
        };
      }
      if (method === 'GET' && seg[3] && !seg[4]) {
        return { status: 200, body: instanceDetail(TID) };
      }
      if (method === 'PATCH' && seg[3] && !seg[4]) {
        const body = await readJson(req);
        if (body.name) ensureInstance({ name: String(body.name).slice(0, 80) });
        if (body.status && ['active', 'suspended'].includes(body.status)) {
          setTenantStatus(TID, body.status);
        }
        return { status: 200, body: instanceDetail(TID) };
      }
      if (method === 'POST' && seg[3] && seg[4] === 'keys') {
        const body = await readJson(req);
        const key = createApiKey({
          tenantId: TID,
          name: body.name,
          scopes: body.scopes || ['search', 'read', 'write'],
          rateLimit: body.rate_limit,
          expiresAt: body.expires_at,
          readerLevel: body.reader_level,
        });
        return {
          status: 201,
          body: {
            id: key.id, plaintext: key.plaintext, scopes: key.scopes,
            reader_level: key.readerLevel, warning: '明文密钥只在此刻返回一次',
          },
        };
      }
      if (method === 'GET' && seg[3] && seg[4] === 'keys') {
        return { status: 200, body: { items: listApiKeys(TID) } };
      }
      if (method === 'POST' && seg[3] && seg[4] === 'reindex') {
        return { status: 200, body: reindexTenant(TID) };
      }
    }
  }

  throw new ApiError(404, 'not_found', `未知接口: ${method} ${url.pathname}`);
}

// ---------------- 请求入口 ----------------

export function createApp() {
  return http.createServer(async (req, res) => {
    const t0 = Date.now();
    const reqId = randomUUID();
    res.setHeader('X-Request-Id', reqId);

    if (config.cors) {
      res.setHeader('Access-Control-Allow-Origin', config.cors);
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-API-Key');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '86400');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const ctx = {
      tenantId: null,
      keyId: null,
      action: `${req.method} ${req.url.split('?')[0]}`,
      target: null,
      query: null,
      ip: req.socket?.remoteAddress || null,
    };

    let status = 200;
    let errMsg = null;

    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const isAdmin = url.pathname === '/admin' || url.pathname.startsWith('/admin/');
      let out;

      if (isAdmin) {
        // 后台走会话鉴权（Cookie），与 API Key 完全是两条通道
        out = await handleAdmin(req, res, url);
        if (!out) throw new ApiError(404, 'not_found', `未知后台路径: ${url.pathname}`);
      } else {
        let auth = { root: false, tenantId: null, scopes: [], rateLimit: 0 };
        const needAuth = url.pathname.startsWith('/v1/');
        if (needAuth) {
          auth = authenticate(req);
          ctx.tenantId = auth.tenantId;
          ctx.keyId = auth.keyId;
          checkRate(auth);
        }
        out = await route(req, url, auth, ctx);
      }
      status = out.status || 200;

      if (out.buffer != null) {
        res.writeHead(status, {
          'Content-Type': out.contentType || 'application/octet-stream',
          'Content-Length': out.buffer.length,
          'Cache-Control': 'private, max-age=3600',
          ...out.headers,
        });
        res.end(out.buffer);
      } else if (out.raw != null) {
        res.writeHead(status, {
          'Content-Type': out.contentType || 'text/plain; charset=utf-8',
          ...out.headers,
        });
        res.end(out.raw);
      } else {
        sendJson(res, status, out.body ?? {}, out.headers || {});
      }
    } catch (e) {
      const isApi = e instanceof ApiError;
      status = isApi ? e.status : 500;
      errMsg = e.message;
      if (!isApi) console.error('[error]', e);
      if (!res.headersSent) {
        sendJson(res, status, {
          error: {
            code: isApi ? e.code : 'internal_error',
            message: isApi ? e.message : `服务端异常: ${e.message}`,
            request_id: reqId,
          },
        }, isApi ? e.headers : {});
      } else {
        res.end();
      }
    } finally {
      if (ctx.tenantId || ctx.keyId === 'root') {
        writeAudit({
          tenantId: ctx.tenantId,
          keyId: ctx.keyId,
          action: ctx.action,
          target: ctx.target,
          query: ctx.query,
          status,
          latency: Date.now() - t0,
          ip: ctx.ip,
          error: errMsg,
        });
      }
    }
  });
}
