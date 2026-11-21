import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { q, now, instanceId } from './db.js';
import { tdb } from './tenant-db.js';
import { config } from './config.js';
import {
  LEVELS, DOC_LEVELS, ROLES, ROLE_KEYS, can, roleRank,
  login, getSession, revokeSession, createMember, listMembers, updateMember,
  deleteMember, getMember,
} from './rbac.js';
import {
  getTenant, listSpaces, ensureSpace, listDocuments, getDocument,
  setDocumentLevel, createApiKey, listApiKeys, revokeApiKey, listFaqs,
} from './store.js';
import { getStats } from './indexer.js';
import { deleteDocument, reindexTenant } from './ingest.js';
import { vectorStats } from './vectors.js';
import { storageStats, getFileRecord, readFileBuffer } from './storage.js';
import { cacheStats, bumpEpoch } from './cache.js';

const ADMIN_HTML = (() => {
  try {
    return readFileSync(fileURLToPath(new URL('../public/admin.html', import.meta.url)), 'utf8');
  } catch {
    return null;
  }
})();

class AdminError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new AdminError(413, 'payload_too_large', '请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new AdminError(400, 'invalid_json', '请求体不是合法 JSON'); }
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieHeader(sid, maxAgeSec) {
  const c = config.session;
  const bits = [
    `${c.cookieName}=${sid}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (c.secure) bits.push('Secure');
  return bits.join('; ');
}

const SID_COOKIE = () => config.session.cookieName;

function requireUser(req) {
  const sid = parseCookies(req)[SID_COOKIE()];
  const user = getSession(sid);
  if (!user) throw new AdminError(401, 'unauthorized', '未登录或登录已过期');
  return user;
}

function requirePerm(user, perm) {
  if (!can(user, perm)) {
    throw new AdminError(403, 'forbidden', `当前角色（${ROLES[user.role]?.name || user.role}）没有 ${perm} 权限`);
  }
}

function audit(user, action, { target = null, query = null, status = 200, ip = null, latency = 0, error = null } = {}) {
  try {
    q.run(
      `INSERT INTO audit_logs(id, tenant_id, api_key_id, actor, action, target, query, status, latency_ms, ip, error, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      randomUUID(), user?.tenant_id || null, null, user?.email || null, action, target, query,
      status, latency, ip, error, now(),
    );
  } catch { /* 审计失败不阻断 */ }
}

/** 校验能否操作目标成员：不能动比自己角色高的人，也不能给自己提权 */
function assertCanManage(actor, targetRole, targetLevel = 1) {
  if (actor.role === 'owner') return;
  if (roleRank(targetRole) >= roleRank(actor.role)) {
    throw new AdminError(403, 'forbidden', '不能修改与自己同级或更高角色的成员');
  }
  if (Number(targetLevel) > Number(actor.level)) {
    throw new AdminError(403, 'forbidden', '不能修改员工等级高于自己的成员');
  }
}

function assertCanGrantRole(actor, role) {
  if (actor.role === 'owner') {
    if (role === 'owner' && actor.role !== 'owner') throw new AdminError(403, 'forbidden', '只有企业负责人可以授予 owner');
    return;
  }
  if (roleRank(role) >= roleRank(actor.role)) {
    throw new AdminError(403, 'forbidden', `不能授予 ${ROLES[role]?.name || role} 角色（不低于自己的角色）`);
  }
}

/**
 * 管理后台路由。返回 null 表示「不是后台请求」，交回主路由。
 */
export async function handleAdmin(req, res, url) {
  const path = url.pathname;
  if (path !== '/admin' && !path.startsWith('/admin/')) return null;

  const t0 = Date.now();
  const ip = req.socket?.remoteAddress || null;

  // 页面本体（登录状态由前端调 /admin/api/me 判断，页面本身不含机密数据）
  if (path === '/admin' || path === '/admin/') {
    if (!ADMIN_HTML) {
      return { status: 503, raw: '<meta charset="utf-8"><p>后台页面缺失：public/admin.html</p>', contentType: 'text/html; charset=utf-8' };
    }
    return { status: 200, raw: ADMIN_HTML, contentType: 'text/html; charset=utf-8' };
  }

  if (!path.startsWith('/admin/api/')) return null;
  const seg = path.slice('/admin/api/'.length).split('/').filter(Boolean);
  const method = req.method.toUpperCase();
  const body = ['POST', 'PATCH', 'PUT'].includes(method) ? await readJson(req) : {};

  try {
    // ---------- 公开接口 ----------
    if (seg[0] === 'bootstrap' && method === 'GET') {
      return {
        status: 200,
        body: {
          levels: LEVELS,
          doc_levels: DOC_LEVELS,
          roles: ROLE_KEYS.map((k) => ({ key: k, name: ROLES[k].name, desc: ROLES[k].desc, perms: ROLES[k].perms })),
        },
      };
    }

    if (seg[0] === 'login' && method === 'POST') {
      const r = login({
        tenantId: body.tenant || null,
        email: body.email,
        password: body.password,
        ip,
        ua: req.headers['user-agent'],
      });
      audit(r.user, 'admin:login', { status: 200, ip, latency: Date.now() - t0 });
      return {
        status: 200,
        body: { user: r.user, expires_at: r.expiresAt },
        headers: { 'Set-Cookie': cookieHeader(r.sid, r.ttlHours * 3600) },
      };
    }

    // ---------- 以下都需要登录 ----------
    const user = requireUser(req);

    if (seg[0] === 'logout' && method === 'POST') {
      revokeSession(user.sessionId);
      audit(user, 'admin:logout', { ip });
      return { status: 200, body: { ok: true }, headers: { 'Set-Cookie': cookieHeader('', 0) } };
    }

    if (seg[0] === 'me' && method === 'GET') {
      const tenant = getTenant(user.tenant_id);
      return {
        status: 200,
        body: {
          user,
          tenant: { id: tenant.id, name: tenant.name, plan: tenant.plan, status: tenant.status },
          levels: LEVELS,
          doc_levels: DOC_LEVELS,
          roles: ROLE_KEYS.map((k) => ({ key: k, name: ROLES[k].name, desc: ROLES[k].desc, perms: ROLES[k].perms })),
          session: { expires_at: user.expires_at },
        },
      };
    }

    if (seg[0] === 'change-password' && method === 'POST') {
      if (String(body.new_password || '').length < 8) throw new AdminError(400, 'bad_request', '新密码至少 8 位');
      updateMember(user.tenant_id, user.id, { password: body.new_password });
      audit(user, 'admin:change_password', { ip });
      return { status: 200, body: { ok: true } };
    }

    // ---------- 概览 ----------
    if (seg[0] === 'overview' && method === 'GET') {
      const tenantId = instanceId();
      const stats = getStats(tenantId);
      const vec = vectorStats(tenantId);
      const docs = q.get(`SELECT COUNT(*) AS n FROM instance WHERE id = ?`, tenantId);
      return {
        status: 200,
        body: {
          tenant: getTenant(tenantId),
          corpus: {
            documents: countDocs(tenantId),
            chunks: stats.n_chunks,
            faqs: countFaqs(tenantId),
            avg_chunk_terms: Number(stats.avg_len.toFixed(1)),
            parse_failed: countDocs(tenantId, `AND parse_status='failed'`),
          },
          vectors: vec,
          storage: storageStats(tenantId),
          members: listMembers(tenantId),
          keys: listApiKeys(tenantId).map(stripKey),
          cache: cacheStats(),
          recent: q.all(
            `SELECT actor, action, target, status, latency_ms, created_at FROM audit_logs
             WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 12`,
            tenantId,
          ),
          self_check: docs ? 'ok' : 'missing_tenant',
        },
      };
    }

    // ---------- 文档 ----------
    if (seg[0] === 'documents') {
      const tenantId = instanceId();
      const id = seg[1];
      // owner 能看全部文档；其他人看到的上限是自己的员工等级
      const readLevel = user.role === 'owner' ? 5 : Number(user.level) || 1;
      const listFilter = user.role === 'owner' ? null : readLevel;

      if (method === 'GET' && !id) {
        requirePerm(user, 'doc.read');
        const r = listDocuments(tenantId, {
          spaceId: url.searchParams.get('space_id'),
          q: url.searchParams.get('q'),
          uploader: url.searchParams.get('uploader'),
          limit: url.searchParams.get('limit') || 20,
          offset: url.searchParams.get('offset') || 0,
          minLevel: listFilter,
        });
        return { status: 200, body: r };
      }
      if (method === 'GET' && id && !seg[2]) {
        requirePerm(user, 'doc.read');
        const doc = getDocument(tenantId, id, { withChunks: url.searchParams.get('with_chunks') === '1' });
        if (!doc) throw new AdminError(404, 'not_found', '文档不存在');
        if (Number(doc.min_level) > readLevel) throw new AdminError(403, 'forbidden', '该文档的密级高于你的员工等级');
        return { status: 200, body: doc };
      }
      // 后台直接下载原件（走会话鉴权，不需要再拿 API Key）
      if (method === 'GET' && id && seg[2] === 'file') {
        requirePerm(user, 'doc.read');
        const doc = getDocument(tenantId, id);
        if (!doc) throw new AdminError(404, 'not_found', '文档不存在');
        if (Number(doc.min_level) > readLevel) throw new AdminError(403, 'forbidden', '该文档的密级高于你的员工等级');
        if (!doc.file_id) throw new AdminError(404, 'no_original', '该文档没有原始件');
        const rec = getFileRecord(tenantId, doc.file_id);
        if (!rec) throw new AdminError(404, 'no_original', '原始件记录不存在');
        const buf = readFileBuffer(rec, tenantId);
        const name = doc.original_name || rec.filename || `${doc.title}${rec.ext || ''}`;
        audit(user, 'admin:doc_download', { target: id, ip });
        return {
          status: 200,
          buffer: buf,
          contentType: rec.mime,
          headers: {
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
            'X-File-Sha256': rec.sha256,
          },
        };
      }
      if (method === 'PATCH' && id) {
        requirePerm(user, 'doc.level');
        const doc = getDocument(tenantId, id);
        if (!doc) throw new AdminError(404, 'not_found', '文档不存在');
        if (Number(doc.min_level) > readLevel) throw new AdminError(403, 'forbidden', '不能修改密级高于自己的文档');
        const lvl = Number(body.min_level);
        if (!Number.isFinite(lvl) || lvl < 1 || lvl > 5) throw new AdminError(400, 'bad_request', 'min_level 取 1~5');
        if (lvl > Number(user.level) && user.role !== 'owner') {
          throw new AdminError(403, 'forbidden', '不能把文档密级设得高于自己的员工等级');
        }
        const out = setDocumentLevel(tenantId, id, lvl);
        bumpEpoch();
        audit(user, 'admin:doc_level', { target: id, ip, latency: Date.now() - t0 });
        return { status: 200, body: out };
      }
      if (method === 'DELETE' && id) {
        requirePerm(user, 'doc.delete');
        const doc = getDocument(tenantId, id);
        if (!doc) throw new AdminError(404, 'not_found', '文档不存在');
        if (Number(doc.min_level) > readLevel) throw new AdminError(403, 'forbidden', '不能删除密级高于自己的文档');
        const r = deleteDocument(tenantId, id);
        audit(user, 'admin:doc_delete', { target: id, ip, latency: Date.now() - t0 });
        return { status: 200, body: { deleted: true, ...r } };
      }
    }

    // ---------- 空间 ----------
    if (seg[0] === 'spaces') {
      if (method === 'GET') {
        requirePerm(user, 'doc.read');
        return { status: 200, body: { items: listSpaces(user.tenant_id) } };
      }
      if (method === 'POST') {
        requirePerm(user, 'space.write');
        if (!body.name && !body.slug) throw new AdminError(400, 'bad_request', 'name 或 slug 必须提供');
        const s = ensureSpace(user.tenant_id, body.slug || body.name, body.name);
        audit(user, 'admin:space_create', { target: s.id, ip });
        return { status: 201, body: s };
      }
    }

    // ---------- FAQ ----------
    if (seg[0] === 'faqs' && method === 'GET') {
      requirePerm(user, 'doc.read');
      // 与文档一致：owner 看全部，其他人最多看到自己等级那一档
      const faqLevel = user.role === 'owner' ? null : Number(user.level) || 1;
      return { status: 200, body: listFaqs(user.tenant_id, {
        limit: url.searchParams.get('limit') || 50,
        minLevel: faqLevel,
      }) };
    }

    // ---------- 成员 ----------
    if (seg[0] === 'members') {
      const tenantId = instanceId();
      const id = seg[1];

      if (method === 'GET' && !id) {
        requirePerm(user, 'member.read');
        return { status: 200, body: { items: listMembers(tenantId), levels: LEVELS, roles: ROLE_KEYS } };
      }
      if (method === 'POST' && !id) {
        requirePerm(user, 'member.write');
        assertCanGrantRole(user, body.role || 'viewer');
        const level = Math.max(1, Math.min(5, Number(body.level) || 1));
        if (level > Number(user.level) && user.role !== 'owner') {
          throw new AdminError(403, 'forbidden', '不能创建员工等级高于自己的账号');
        }
        const r = createMember({
          tenantId,
          email: body.email,
          name: body.name,
          password: body.password,
          role: body.role || 'viewer',
          level,
          department: body.department,
          createdBy: user.email,
          mustChange: body.password ? false : true,
        });
        audit(user, 'admin:member_create', { target: r.user.id, ip });
        return {
          status: 201,
          body: {
            user: r.user,
            initial_password: body.password ? undefined : r.password,
            warning: body.password ? undefined : '初始密码只显示这一次，请通过安全渠道转交',
          },
        };
      }
      if (method === 'PATCH' && id) {
        requirePerm(user, 'member.write');
        const target = getMember(tenantId, id);
        if (!target) throw new AdminError(404, 'not_found', '成员不存在');
        if (target.id === user.id && body.role && body.role !== user.role) {
          throw new AdminError(400, 'bad_request', '不能修改自己的角色，请让其他负责人操作');
        }
        assertCanManage(user, target.role, target.level);
        if (body.role) assertCanGrantRole(user, body.role);
        if (body.level && Number(body.level) > Number(user.level) && user.role !== 'owner') {
          throw new AdminError(403, 'forbidden', '不能把员工等级设得高于自己');
        }
        const out = updateMember(tenantId, id, body);
        audit(user, 'admin:member_update', { target: id, ip });
        return { status: 200, body: out };
      }
      if (method === 'DELETE' && id) {
        requirePerm(user, 'member.write');
        const target = getMember(tenantId, id);
        if (!target) throw new AdminError(404, 'not_found', '成员不存在');
        if (target.id === user.id) throw new AdminError(400, 'bad_request', '不能删除自己');
        assertCanManage(user, target.role, target.level);
        deleteMember(tenantId, id);
        audit(user, 'admin:member_delete', { target: id, ip });
        return { status: 200, body: { deleted: true, id } };
      }
    }

    // ---------- API Key ----------
    if (seg[0] === 'keys') {
      const tenantId = instanceId();
      const id = seg[1];
      if (method === 'GET' && !id) {
        requirePerm(user, 'key.read');
        return { status: 200, body: { items: listApiKeys(tenantId).map(stripKey) } };
      }
      if (method === 'POST' && !id) {
        requirePerm(user, 'key.write');
        const scopes = Array.isArray(body.scopes) && body.scopes.length ? body.scopes : ['search', 'read'];
        const level = Math.max(1, Math.min(5, Number(body.reader_level) || Number(user.level) || 1));
        if (level > Number(user.level) && user.role !== 'owner') {
          throw new AdminError(403, 'forbidden', '密钥可读等级不能高于自己的员工等级');
        }
        const key = createApiKey({
          tenantId,
          name: body.name || `由 ${user.name} 创建`,
          scopes,
          rateLimit: body.rate_limit,
          expiresAt: body.expires_at,
          readerLevel: level,
        });
        audit(user, 'admin:key_create', { target: key.id, ip });
        return {
          status: 201,
          body: { ...key, warning: '明文密钥只返回这一次，请立即保存到密钥管理系统' },
        };
      }
      if (method === 'DELETE' && id) {
        requirePerm(user, 'key.write');
        const r = revokeApiKey(id);
        if (!r || r.tenant_id !== tenantId) throw new AdminError(404, 'not_found', '密钥不存在');
        audit(user, 'admin:key_revoke', { target: id, ip });
        return { status: 200, body: { revoked: true, id } };
      }
    }

    // ---------- 审计 ----------
    if (seg[0] === 'audit' && method === 'GET') {
      requirePerm(user, 'audit.read');
      const limit = Math.min(300, Number(url.searchParams.get('limit')) || 60);
      const items = q.all(
        `SELECT id, actor, action, target, query, status, latency_ms, ip, error, created_at
         FROM audit_logs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`,
        instanceId(), limit,
      );
      return { status: 200, body: { items } };
    }

    // ---------- 向量索引 ----------
    if (seg[0] === 'vectors') {
      if (method === 'GET') {
        requirePerm(user, 'doc.read');
        return { status: 200, body: vectorStats(user.tenant_id) };
      }
      if (method === 'POST' && seg[1] === 'rebuild') {
        requirePerm(user, 'vector.rebuild');
        const r = reindexTenant(user.tenant_id);
        audit(user, 'admin:vector_rebuild', { ip, latency: Date.now() - t0 });
        return { status: 200, body: { ...r, vectors: vectorStats(user.tenant_id) } };
      }
    }

    throw new AdminError(404, 'not_found', `未知后台接口: ${method} ${path}`);
  } catch (e) {
    const status = e instanceof AdminError ? e.status : 500;
    if (!(e instanceof AdminError)) console.error('[admin-error]', e);
    if (e.code === 'bad_credentials' || e.code === 'need_tenant' || e.code === 'tenant_suspended' || e.code === 'disabled') {
      audit(null, 'admin:login_failed', { status, ip, error: e.message, latency: Date.now() - t0 });
    }
    return {
      status,
      body: { error: { code: e.code || 'internal_error', message: e.message } },
    };
  }
}

function stripKey(k) {
  return {
    id: k.id, name: k.name, key_prefix: k.key_prefix, scopes: typeof k.scopes === 'string' ? safeJson(k.scopes) : k.scopes,
    rate_limit: k.rate_limit, reader_level: k.reader_level,
    last_used_at: k.last_used_at, expires_at: k.expires_at, revoked_at: k.revoked_at, created_at: k.created_at,
  };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return []; }
}

function countDocs(tenantId, extra = '') {
  const tq = tdb(tenantId);
  return Number(tq.get(`SELECT COUNT(*) AS n FROM documents WHERE tenant_id = ? AND status='active' ${extra}`, tenantId)?.n || 0);
}

function countFaqs(tenantId) {
  const tq = tdb(tenantId);
  return Number(tq.get(`SELECT COUNT(*) AS n FROM faqs WHERE tenant_id = ? AND enabled=1`, tenantId)?.n || 0);
}
