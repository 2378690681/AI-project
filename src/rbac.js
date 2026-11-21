import { scryptSync, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { q, now, newId, instanceId } from './db.js';
import { config } from './config.js';

/**
 * 后台权限模型：角色（能做什么）× 员工等级（能看什么）。
 *
 * 这两件事必须分开：
 *   - 角色决定「功能权限」：能不能删文档、能不能发密钥、能不能改成员；
 *   - 等级决定「数据权限」：能看到 min_level 多高的文档。
 * 一个部门主管（L3 + manager）可以传文档但不能发密钥；
 * 一个高管（L5 + viewer）能看所有文档但不该有管理动作。
 * 混成一个"权限等级"会立刻在真实企业里出问题。
 */

export const LEVELS = [
  { level: 1, code: 'L1', name: '普通员工', desc: '只看公开级资料' },
  { level: 2, code: 'L2', name: '高级员工 / 组长', desc: '可看内部级资料' },
  { level: 3, code: 'L3', name: '主管', desc: '可看部门级资料' },
  { level: 4, code: 'L4', name: '经理 / 总监', desc: '可看管理级资料' },
  { level: 5, code: 'L5', name: '高管 / 负责人', desc: '可看机密级资料' },
];

export const DOC_LEVELS = [
  { level: 1, name: '公开' },
  { level: 2, name: '内部' },
  { level: 3, name: '部门' },
  { level: 4, name: '管理' },
  { level: 5, name: '机密' },
];

export const ROLES = {
  owner: {
    name: '企业负责人',
    desc: '全部权限，含成员、密钥与安全设置',
    perms: ['*'],
  },
  admin: {
    name: '知识库管理员',
    desc: '管理文档、空间、密钥与成员，不能改动企业负责人',
    perms: [
      'doc.read', 'doc.write', 'doc.delete', 'doc.level',
      'space.read', 'space.write', 'faq.write',
      'key.read', 'key.write',
      'member.read', 'member.write',
      'audit.read', 'stats.read', 'vector.rebuild',
    ],
  },
  manager: {
    name: '部门主管',
    desc: '管理文档与等级，可看审计，可邀请成员',
    perms: [
      'doc.read', 'doc.write', 'doc.delete', 'doc.level',
      'space.read', 'space.write', 'faq.write',
      'member.read', 'member.invite',
      'audit.read', 'stats.read',
    ],
  },
  editor: {
    name: '内容编辑',
    desc: '上传与维护文档，不能删除成员或签发密钥',
    perms: ['doc.read', 'doc.write', 'space.read', 'faq.write', 'stats.read'],
  },
  viewer: {
    name: '只读成员',
    desc: '只能检索与查看',
    perms: ['doc.read', 'stats.read'],
  },
};

export const ROLE_KEYS = Object.keys(ROLES);

export function permissionsOf(role) {
  const r = ROLES[role];
  if (!r) return [];
  return r.perms;
}

export function can(user, perm) {
  if (!user) return false;
  const perms = permissionsOf(user.role);
  if (perms.includes('*')) return true;
  if (perms.includes(perm)) return true;
  // 支持 doc.* 这类通配
  const [head] = perm.split('.');
  return perms.includes(`${head}.*`);
}

/** 角色优先级：低等级角色不能管理高等级角色 */
const ROLE_RANK = { viewer: 1, editor: 2, manager: 3, admin: 4, owner: 5 };
export const roleRank = (r) => ROLE_RANK[r] || 0;

// ---------------- 口令 ----------------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function hashPassword(plain) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(plain), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }).toString('hex');
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt}$${hash}`;
}

export function verifyPassword(plain, stored) {
  try {
    const [algo, N, r, p, salt, hash] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const calc = scryptSync(String(plain), salt, hash.length / 2, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    const expect = Buffer.from(hash, 'hex');
    return calc.length === expect.length && timingSafeEqual(calc, expect);
  } catch {
    return false;
  }
}

export function passwordIssues(pwd) {
  const s = String(pwd || '');
  if (s.length < 8) return '密码至少 8 位';
  if (!/[a-zA-Z]/.test(s) || !/\d/.test(s)) return '密码需同时包含字母和数字';
  return null;
}

export function randomPassword() {
  // 去掉易混淆字符，便于口头/纸条传递
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const b = randomBytes(14);
  let s = '';
  for (let i = 0; i < 14; i++) s += chars[b[i] % chars.length];
  // 纯随机有约 5% 的概率一个数字都没有，会被 passwordIssues 自己的规则挡回来；
  // 这里强制补齐，保证生成的密码一定能通过校验。
  const fix = (pool, re) => {
    if (re.test(s)) return;
    const pos = b[0] % s.length;
    s = s.slice(0, pos) + pool[b[1] % pool.length] + s.slice(pos + 1);
  };
  fix(digits, /\d/);
  fix(letters, /[a-zA-Z]/);
  return s;
}

// ---------------- 成员 ----------------

function publicUser(row, tenant) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    tenant_name: tenant?.name || null,
    email: row.email,
    name: row.name,
    role: row.role,
    role_name: ROLES[row.role]?.name || row.role,
    level: Number(row.level),
    level_name: LEVELS.find((l) => l.level === Number(row.level))?.name || `L${row.level}`,
    department: row.department || null,
    status: row.status,
    must_change: Boolean(row.must_change),
    last_login_at: row.last_login_at,
    created_at: row.created_at,
    permissions: permissionsOf(row.role),
  };
}

export function createMember({ tenantId, email, name, password, role = 'viewer', level = 1, department = null, createdBy = null, mustChange = false }) {
  tenantId = instanceId();
  const mail = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) throw new Error('邮箱格式不正确');
  if (!ROLES[role]) throw new Error(`未知角色: ${role}`);
  const lvl = Math.max(1, Math.min(5, Number(level) || 1));
  if (password == null) password = randomPassword();
  const bad = passwordIssues(password);
  if (bad) throw new Error(bad);

  const exists = q.get(`SELECT id FROM admin_users WHERE tenant_id = ? AND email = ?`, tenantId, mail);
  if (exists) throw new Error('该邮箱在此企业下已存在');

  const ts = now();
  const id = newId('u_');
  q.run(
    `INSERT INTO admin_users(id, tenant_id, email, name, password_hash, role, level, department,
       status, must_change, created_by, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,'active',?,?,?,?)`,
    id, tenantId, mail, String(name || mail.split('@')[0]).slice(0, 60),
    hashPassword(password), role, lvl, department, mustChange ? 1 : 0, createdBy, ts, ts,
  );
  return { user: getMember(tenantId, id), password };
}

export function getMember(tenantId, id) {
  tenantId = instanceId();
  const row = q.get(`SELECT * FROM admin_users WHERE id = ? AND tenant_id = ?`, id, tenantId);
  return publicUser(row);
}

export function findMemberByEmail(email) {
  return q.all(`SELECT * FROM admin_users WHERE lower(email) = ?`, String(email || '').trim().toLowerCase());
}

export function listMembers(tenantId) {
  tenantId = instanceId();
  return q.all(
    `SELECT * FROM admin_users WHERE tenant_id = ? ORDER BY level DESC, created_at`,
    tenantId,
  ).map((r) => publicUser(r));
}

export function updateMember(tenantId, id, patch = {}) {
  tenantId = instanceId();
  const row = q.get(`SELECT * FROM admin_users WHERE id = ? AND tenant_id = ?`, id, tenantId);
  if (!row) return null;
  const fields = [];
  const args = [];
  if (patch.name != null) { fields.push('name = ?'); args.push(String(patch.name).slice(0, 60)); }
  if (patch.role != null) {
    if (!ROLES[patch.role]) throw new Error(`未知角色: ${patch.role}`);
    fields.push('role = ?'); args.push(patch.role);
  }
  if (patch.level != null) {
    fields.push('level = ?'); args.push(Math.max(1, Math.min(5, Number(patch.level) || 1)));
  }
  if (patch.department !== undefined) { fields.push('department = ?'); args.push(patch.department || null); }
  if (patch.status != null) {
    if (!['active', 'disabled'].includes(patch.status)) throw new Error('status 只能是 active / disabled');
    fields.push('status = ?'); args.push(patch.status);
  }
  if (patch.password != null) {
    const bad = passwordIssues(patch.password);
    if (bad) throw new Error(bad);
    fields.push('password_hash = ?'); args.push(hashPassword(patch.password));
    fields.push('must_change = ?'); args.push(patch.mustChange ? 1 : 0);
  }
  if (!fields.length) return getMember(tenantId, id);
  fields.push('updated_at = ?'); args.push(now());
  args.push(id, tenantId);
  q.run(`UPDATE admin_users SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`, ...args);
  return getMember(tenantId, id);
}

export function deleteMember(tenantId, id) {
  tenantId = instanceId();
  const row = q.get(`SELECT * FROM admin_users WHERE id = ? AND tenant_id = ?`, id, tenantId);
  if (!row) return null;
  const owners = q.get(
    `SELECT COUNT(*) AS n FROM admin_users WHERE tenant_id = ? AND role = 'owner' AND status = 'active'`,
    tenantId,
  ).n;
  if (row.role === 'owner' && Number(owners) <= 1) {
    throw new Error('不能删除唯一的企业负责人，请先把另一个账号设为 owner');
  }
  q.run(`DELETE FROM admin_users WHERE id = ? AND tenant_id = ?`, id, tenantId);
  q.run(`DELETE FROM admin_sessions WHERE user_id = ?`, id);
  return { id };
}

// ---------------- 会话 ----------------

const SID_RE = /^[a-f0-9]{48}$/;

export function createSession(user, { ip = null, ua = null } = {}) {
  const sid = randomBytes(24).toString('hex');
  const ttl = Math.max(1, Number(config.session.ttlHours) || 12);
  const exp = new Date(Date.now() + ttl * 3600_000).toISOString();
  q.run(
    `INSERT INTO admin_sessions(id, tenant_id, user_id, ip, user_agent, expires_at, created_at)
     VALUES(?,?,?,?,?,?,?)`,
    sid, user.tenant_id, user.id, ip, String(ua || '').slice(0, 200), exp, now(),
  );
  q.run(`UPDATE admin_users SET last_login_at = ? WHERE id = ?`, now(), user.id);
  return { sid, expiresAt: exp, ttlHours: ttl };
}

export function getSession(sid) {
  if (!sid || !SID_RE.test(sid)) return null;
  const s = q.get(`SELECT * FROM admin_sessions WHERE id = ?`, sid);
  if (!s || s.revoked_at) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) return null;
  const row = q.get(`SELECT * FROM admin_users WHERE id = ?`, s.user_id);
  if (!row || row.status !== 'active') return null;
  // 单实例：实例状态决定这个企业还能不能用；旧库可能还只有 tenants 表
  let inst = null;
  try { inst = q.get(`SELECT * FROM instance WHERE id = ?`, row.tenant_id); } catch { /* 老库没有 instance 表 */ }
  if (!inst) {
    try { inst = q.get(`SELECT * FROM tenants WHERE id = ?`, row.tenant_id); } catch { /* 忽略 */ }
  }
  if (!inst || inst.status !== 'active') return null;
  return { ...publicUser(row, inst), sessionId: sid, expires_at: s.expires_at };
}

export function revokeSession(sid) {
  q.run(`UPDATE admin_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, now(), sid);
}

export function revokeUserSessions(userId) {
  q.run(`UPDATE admin_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`, now(), userId);
}

export function purgeExpiredSessions() {
  const cutoff = new Date(Date.now() - 86400_000).toISOString();
  q.run(`DELETE FROM admin_sessions WHERE expires_at < ?`, cutoff);
}

/**
 * 登录。tenant 可选：不填则按邮箱在所有企业中唯一匹配。
 */
export function login({ tenantId = null, email, password, ip, ua }) {
  tenantId = instanceId();
  const mail = String(email || '').trim().toLowerCase();
  let candidates;
  candidates = q.all(`SELECT * FROM admin_users WHERE tenant_id = ? AND lower(email) = ?`, tenantId, mail);
  if (!candidates.length) candidates = q.all(`SELECT * FROM admin_users WHERE lower(email) = ?`, mail);

  if (!candidates.length) {
    // 故意不区分「账号不存在」与「密码错误」，避免被用来枚举企业成员
    throw Object.assign(new Error('邮箱或密码不正确'), { code: 'bad_credentials' });
  }
  if (candidates.length > 1) {
    throw Object.assign(new Error('该邮箱在多个企业中存在，请填写企业标识（tenant）'), { code: 'need_tenant' });
  }

  const row = candidates[0];
  if (row.status !== 'active') {
    throw Object.assign(new Error('该账号已被停用，请联系企业负责人'), { code: 'disabled' });
  }
  if (!verifyPassword(password, row.password_hash)) {
    throw Object.assign(new Error('邮箱或密码不正确'), { code: 'bad_credentials' });
  }
  // 单实例：实例是否启用决定这个企业还能不能登录
  const tenant = q.get(`SELECT * FROM instance WHERE id = ?`, row.tenant_id)
    || (() => { try { return q.get(`SELECT * FROM tenants WHERE id = ?`, row.tenant_id); } catch { return null; } })();
  if (!tenant || tenant.status !== 'active') {
    throw Object.assign(new Error('所属企业已停用'), { code: 'tenant_suspended' });
  }
  const user = publicUser(row, tenant);
  const session = createSession(user, { ip, ua });
  return { user, ...session };
}

/** 企业初始化时创建第一个负责人账号 */
export function ensureOwner(tenantId, { email, password, name } = {}) {
  tenantId = instanceId();
  const exists = q.get(`SELECT COUNT(*) AS n FROM admin_users WHERE tenant_id = ?`, tenantId);
  if (Number(exists?.n || 0) > 0) return { created: false };
  const pwd = password || randomPassword();
  const { user } = createMember({
    tenantId,
    email: email || `owner@${String(tenantId).replace(/^t_/, '')}.local`,
    name: name || '企业负责人',
    password: pwd,
    role: 'owner',
    level: 5,
    department: '管理层',
    mustChange: !password,
  });
  return { created: true, user, password: pwd };
}

export function memberCount(tenantId) {
  tenantId = instanceId();
  const row = q.get(`SELECT COUNT(*) AS n FROM admin_users WHERE tenant_id = ? AND status = 'active'`, tenantId);
  return Number(row?.n || 0);
}
