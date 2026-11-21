// 端到端自测：拉起一个独立端口 + 独立数据库文件的实例，跑完自动清理。
// 覆盖：单实例部署 / 认证 / 检索与向量 / 等级权限 / 后台 RBAC /
//       上传下载 / 幂等 / 版本 / 审计 / 旧接口下线
//
// 关键：KB_DB 指向 .tmp-smoke/kb.db，绝不碰正式 data/ 目录。
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { readFileSync, existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT || 7399);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = join(ROOT, '.tmp-smoke');
const DB = join(TMP, 'kb.db');
const INSTANCE = 'smoke';
const ROOT_KEY = 'kb_root_smoke_test_fixed_key';
const OWNER = { email: 'owner@smoke.local', password: 'Smoke@2026pw' };

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

async function call(method, path, body, key, extraHeaders = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data, headers: res.headers };
}

/** 带 Cookie 的后台请求 */
function adminClient() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async call(method, path, body) {
      const res = await fetch(BASE + path, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      return { status: res.status, data };
    },
  };
}

function waitReady(timeoutMs = 25000) {
  const t0 = Date.now();
  return new Promise((ok, no) => {
    const tick = async () => {
      try {
        const r = await fetch(`${BASE}/health`);
        if (r.ok) return ok();
      } catch { /* not up yet */ }
      if (Date.now() - t0 > timeoutMs) return no(new Error('服务启动超时'));
      setTimeout(tick, 200);
    };
    tick();
  });
}

const testEnv = () => ({
  ...process.env,
  KB_PORT: String(PORT),
  KB_HOST: '127.0.0.1',
  KB_DB: DB,
  KB_DATA_DIR: TMP,
  KB_INSTANCE_ID: INSTANCE,
  KB_INSTANCE_NAME: '冒烟测试企业',
  KB_ROOT_KEY: ROOT_KEY,
});

/** 在子进程里初始化单实例库，拿回密钥明文 */
function bootstrapInstance() {
  const storeUrl = pathToFileURL(join(ROOT, 'src', 'store.js')).href;
  const rbacUrl = pathToFileURL(join(ROOT, 'src', 'rbac.js')).href;
  const code = `
    const store = await import(${JSON.stringify(storeUrl)});
    const rbac = await import(${JSON.stringify(rbacUrl)});
    const inst = store.ensureInstance({ name: '冒烟测试企业' });
    const key = store.createApiKey({
      name: 'smoke-admin',
      scopes: ['search', 'read', 'write', 'admin'],
      readerLevel: 5,
    });
    const owner = rbac.ensureOwner(inst.id, {
      email: ${JSON.stringify(OWNER.email)},
      password: ${JSON.stringify(OWNER.password)},
      name: '冒烟负责人',
    });
    process.stdout.write('@@' + JSON.stringify({
      id: inst.id,
      key: key.plaintext,
      ownerEmail: owner.user && owner.user.email,
    }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT,
    env: testEnv(),
    encoding: 'utf8',
  });
  const line = out.split('@@').pop().trim();
  return JSON.parse(line);
}

/** 直接读单库文件，用来证明「一个企业一个文件」不是嘴上说说 */
function readInstanceDb() {
  if (!existsSync(DB)) return null;
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
    const docs = db.prepare(`SELECT COUNT(*) AS n FROM documents`).get().n;
    const foreign = db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE tenant_id != ?`).get(INSTANCE).n;
    const marks = db.prepare(`SELECT DISTINCT tenant_id FROM documents`).all().map((r) => r.tenant_id);
    const vectors = tables.includes('vectors')
      ? db.prepare(`SELECT COUNT(*) AS n FROM vectors`).get().n : 0;
    return {
      path: DB,
      tables,
      documents: Number(docs),
      foreign: Number(foreign),
      marks,
      vectors: Number(vectors),
    };
  } finally {
    db.close();
  }
}

async function main() {
  console.log('▸ 准备独立的测试库…');
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  const boot = bootstrapInstance();
  const keyA = boot.key;
  check('单实例初始化：企业标识已建立', boot.id === INSTANCE, boot.id);
  check('首次初始化会生成后台负责人', boot.ownerEmail === OWNER.email, String(boot.ownerEmail));

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: testEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderrBuf = '';
  child.stderr.on('data', (d) => { stderrBuf += d.toString(); });
  child.stdout.on('data', () => {});
  const stop = () => { try { child.kill(); } catch { /* ignore */ } };

  try {
    await waitReady();
    console.log(`▸ 实例就绪 ${BASE}\n`);

    // ---------- 部署形态：单库、无多租户 ----------
    const db0 = readInstanceDb();
    check('只有一个数据库文件', existsSync(DB), DB);
    check('数据库里没有 tenants/多租户目录',
      !existsSync(join(TMP, 'tenants')), join(TMP, 'tenants'));
    check('库内包含账号与向量表',
      ['instance', 'api_keys', 'admin_users', 'spaces', 'documents', 'chunks', 'terms', 'vectors']
        .every((t) => db0?.tables.includes(t)),
      JSON.stringify(db0?.tables));

    const noKey = await call('GET', '/v1/meta');
    check('无凭证返回 401', noKey.status === 401, `实际 ${noKey.status}`);
    const badKey = await call('GET', '/v1/meta', null, 'kb_live_not_a_real_key');
    check('错误密钥返回 401', badKey.status === 401, `实际 ${badKey.status}`);

    const createTenant = await call('POST', '/v1/admin/tenants', { name: '想再建一个企业' }, ROOT_KEY);
    check('新建租户接口已下线（410）', createTenant.status === 410,
      `实际 ${createTenant.status} ${JSON.stringify(createTenant.data).slice(0, 80)}`);
    const listTenants = await call('GET', '/v1/admin/tenants', null, ROOT_KEY);
    check('兼容接口只返回本实例',
      listTenants.status === 200 && listTenants.data.items?.length === 1 && listTenants.data.items[0].id === INSTANCE,
      JSON.stringify(listTenants.data).slice(0, 120));

    const inst = await call('GET', '/v1/admin/instance', null, ROOT_KEY);
    check('可查询本企业信息', inst.status === 200 && inst.data.id === INSTANCE);
    check('本企业信息带数据库路径', String(inst.data.database || '').endsWith('kb.db'), inst.data.database);
    check('本企业信息带成员列表', Array.isArray(inst.data.members) && inst.data.members.length >= 1);

    const stats = await call('GET', '/v1/admin/stats', null, ROOT_KEY);
    check('运维总览声明单实例隔离', stats.data.isolation === 'single-instance-database', String(stats.data.isolation));

    // ---------- 文档入库 ----------
    const docBody = {
      title: '紫罗兰协议说明',
      content: '# 紫罗兰协议说明\n\n## 协议目标\n\n紫罗兰协议用于跨系统敏感数据交换，采用双通道加密与分段签名机制。\n\n## 接入步骤\n\n第一步申请紫罗兰证书，第二步在网关登记白名单，第三步启用双通道握手。',
      space: 'spec',
      tags: ['协议', '安全'],
      source_uri: 'test://violet',
    };
    const d1 = await call('POST', '/v1/documents', docBody, keyA);
    check('文档入库返回 201', d1.status === 201 && d1.data.status === 'created',
      `实际 ${d1.status} ${JSON.stringify(d1.data).slice(0, 120)}`);

    const d2 = await call('POST', '/v1/documents', docBody, keyA);
    check('同内容重复入库被跳过', d2.data.status === 'skipped', `实际 ${d2.data.status}`);

    const d3 = await call('POST', '/v1/documents',
      { ...docBody, content: `${docBody.content}\n\n## 版本说明\n\nv2 新增密钥轮换要求。` }, keyA);
    check('内容变化触发版本升级', d3.data.status === 'updated' && d3.data.version === 2,
      `实际 ${d3.data.status} v${d3.data.version}`);

    // ---------- 检索 ----------
    const s1 = await call('POST', '/v1/search', { query: '紫罗兰协议 接入步骤', top_k: 3 }, keyA);
    check('能检索到入库的文档',
      s1.data.total > 0 && s1.data.hits[0].doc_title === '紫罗兰协议说明',
      JSON.stringify(s1.data).slice(0, 160));
    check('检索结果带章节路径', Boolean(s1.data.hits[0]?.heading), s1.data.hits[0]?.heading);
    check('检索走混合模式（词法 + 向量）', s1.data.retrieval?.mode === 'hybrid',
      JSON.stringify(s1.data.retrieval || {}));
    check('混合检索权重为 0.7/0.3',
      s1.data.retrieval?.lexical_weight === 0.7 && s1.data.retrieval?.vector_weight === 0.3,
      JSON.stringify(s1.data.retrieval || {}));

    const sVec = await call('POST', '/v1/search', { query: '敏感数据怎么加密传输' }, keyA);
    check('向量通道：换个说法也能命中',
      sVec.data.total > 0 && sVec.data.hits[0].doc_title === '紫罗兰协议说明',
      `命中 ${sVec.data.total}`);

    const s3 = await call('POST', '/v1/search', { query: '' }, keyA);
    check('空查询返回 400', s3.status === 400, `实际 ${s3.status}`);

    const s4 = await call('POST', '/v1/search', { query: '紫罗兰', tags: ['不存在的标签'] }, keyA);
    check('标签过滤生效', s4.data.total === 0, `实际命中 ${s4.data.total}`);

    const s5 = await call('POST', '/v1/search', { query: '紫罗兰协议', vector: false }, keyA);
    check('可强制降级为纯词法', s5.data.retrieval?.mode === 'lexical',
      JSON.stringify(s5.data.retrieval || {}));

    // ---------- 问答 ----------
    const a1 = await call('POST', '/v1/ask', { query: '紫罗兰协议怎么接入' }, keyA);
    check('问答返回内容与引用',
      a1.data.answer?.length > 10 && a1.data.citations?.length > 0,
      JSON.stringify(a1.data).slice(0, 160));
    check('问答模式为 extractive（未配 LLM）', a1.data.mode === 'extractive', `实际 ${a1.data.mode}`);

    // ---------- FAQ ----------
    const f1 = await call('POST', '/v1/faqs',
      { question: '紫罗兰证书在哪里申请', answer: '在安全中心提交申请表，3 个工作日审批。', tags: ['紫罗兰'] }, keyA);
    check('FAQ 录入成功', f1.status === 201 && Boolean(f1.data.id));
    const a3 = await call('POST', '/v1/ask', { query: '紫罗兰证书在哪里申请' }, keyA);
    check('FAQ 直接命中', a3.data.mode === 'faq', `实际 ${a3.data.mode}`);

    // ---------- 权限（scope） ----------
    const ro = await call('POST', '/v1/admin/keys', { name: '只读', scopes: ['read'] }, ROOT_KEY);
    const roKey = ro.data.plaintext;
    check('根密钥可签发接入密钥', ro.status === 201 && Boolean(roKey));
    const roWrite = await call('POST', '/v1/documents',
      { title: 'x', content: '这是一段用于测试的正文内容。' }, roKey);
    check('只读密钥写入返回 403', roWrite.status === 403, `实际 ${roWrite.status}`);
    const roSearch = await call('POST', '/v1/search', { query: '紫罗兰' }, roKey);
    check('只读密钥不能检索（缺 search）', roSearch.status === 403, `实际 ${roSearch.status}`);
    const roList = await call('GET', '/v1/documents', null, roKey);
    check('只读密钥可读文档列表', roList.status === 200 && roList.data.total >= 1);

    // ---------- 吊销 ----------
    const rk = await call('DELETE', `/v1/admin/keys/${ro.data.id}`, null, ROOT_KEY);
    check('吊销密钥成功', rk.status === 200);
    const afterRevoke = await call('GET', '/v1/documents', null, roKey);
    check('吊销后立即失效', afterRevoke.status === 401, `实际 ${afterRevoke.status}`);

    const keyList = await call('GET', '/v1/admin/keys', null, ROOT_KEY);
    check('可列出本企业全部密钥', keyList.status === 200 && keyList.data.items.length >= 1);

    // ---------- 审计 ----------
    const audit = await call('GET', '/v1/audit?limit=5', null, keyA);
    check('审计日志有记录', audit.data.items?.length > 0, `条数 ${audit.data.items?.length}`);

    // ---------- 元信息 ----------
    const meta = await call('GET', '/v1/meta', null, keyA);
    check('meta 返回语料与向量规模',
      meta.data.corpus?.chunks > 0 && meta.data.corpus?.vectors?.chunks > 0,
      JSON.stringify(meta.data.corpus?.vectors || {}));
    check('meta 声明单实例数据库与向量检索',
      meta.data.capabilities?.retrieval === 'hybrid-bm25-vector'
      && meta.data.capabilities?.isolation === 'single-instance-database',
      JSON.stringify(meta.data.capabilities?.isolation));
    check('meta 返回本企业数据库路径',
      meta.data.corpus?.database === DB, meta.data.corpus?.database);

    const specRes = await fetch(`${BASE}/openapi.json`);
    const spec = await specRes.json().catch(() => ({}));
    check('接口契约可直接下载',
      specRes.status === 200 && String(spec.openapi || '').startsWith('3.') && Boolean(spec.paths?.['/v1/search']),
      `HTTP ${specRes.status}`);

    // ---------- 文档列表与删除 ----------
    const list = await call('GET', '/v1/documents', null, keyA);
    check('文档列表可读', list.data.total === 1, `实际 ${list.data.total}`);
    const del = await call('DELETE', `/v1/documents/${d1.data.docId}`, null, keyA);
    check('删除文档成功', del.status === 200);
    const afterDel = await call('POST', '/v1/search', { query: '紫罗兰协议' }, keyA);
    check('删除后检索不到', afterDel.data.total === 0, `实际 ${afterDel.data.total}`);

    // ---------- 原始件保存 / 下载 / 版本 / 幂等 ----------
    const md = '# 紫罗兰协议实施细则\n\n## 接入方式\n使用 mTLS 双向认证，客户端证书由安全中心签发，有效期 180 天。\n';
    const buf = Buffer.from(md, 'utf8');
    const up = await call('POST', '/v1/uploads', {
      filename: '紫罗兰协议实施细则.md',
      base64: buf.toString('base64'),
      space: '规范',
      uploader: 'tester@example.com',
      tags: '紫罗兰,规范',
    }, keyA);
    const upItem = up.data.items?.[0];
    check('文件上传入库成功', up.status === 201 && upItem?.status === 'created',
      JSON.stringify(up.data).slice(0, 160));

    const hitUpload = await call('POST', '/v1/search', { query: 'mTLS 双向认证' }, keyA);
    check('上传内容可被检索', hitUpload.data.total > 0, `命中 ${hitUpload.data.total}`);

    const raw = await fetch(`${BASE}/v1/documents/${upItem.docId}/file`, {
      headers: { Authorization: `Bearer ${keyA}` },
    });
    const dlBuf = Buffer.from(await raw.arrayBuffer());
    check('原始件下载字节一致', raw.status === 200 && dlBuf.equals(buf), `${dlBuf.length}B vs ${buf.length}B`);
    check('下载响应带文件名与内容哈希',
      Boolean(raw.headers.get('content-disposition')?.includes('.md'))
      && Boolean(raw.headers.get('x-file-sha256')));

    const up2 = await call('POST', '/v1/uploads', {
      filename: '紫罗兰协议实施细则.md', base64: buf.toString('base64'), space: '规范',
    }, keyA);
    check('重复上传幂等跳过', up2.data.items?.[0]?.status === 'skipped',
      JSON.stringify(up2.data.items?.[0] ?? {}).slice(0, 120));

    const vers = await call('GET', `/v1/documents/${upItem.docId}/versions`, null, keyA);
    check('版本历史可追溯',
      vers.status === 200 && vers.data.total === 1 && vers.data.versions[0].file_id === upItem.fileId,
      JSON.stringify(vers.data).slice(0, 140));

    const junk = Buffer.from('%PDF-1.4 this is not a real pdf', 'utf8');
    const bad = await call('POST', '/v1/uploads', {
      filename: '损坏的扫描件.pdf', base64: junk.toString('base64'), space: '规范',
    }, keyA);
    const badItem = bad.data.items?.[0];
    check('解析失败仍保存原始件',
      badItem?.status === 'created' && badItem?.parseStatus === 'failed' && Boolean(badItem?.fileId),
      JSON.stringify(badItem ?? {}).slice(0, 160));
    const badFile = await fetch(`${BASE}/v1/documents/${badItem.docId}/file`, {
      headers: { Authorization: `Bearer ${keyA}` },
    });
    check('解析失败的原始件仍可下载',
      badFile.status === 200 && Buffer.from(await badFile.arrayBuffer()).equals(junk));

    // ---------- 员工等级：数据权限 ----------
    const secret = await call('POST', '/v1/documents', {
      title: '高管期权授予方案',
      content: '# 高管期权授予方案\n\n## 授予节奏\n期权分四年归属，每年归属 25%，离职后未归属部分作废。\n\n## 行权窗口\n已归属部分可在 90 天内行权，逾期作废。',
      space: '管理层',
      min_level: 4,
    }, keyA);
    check('可创建带密级的文档', secret.status === 201, JSON.stringify(secret.data).slice(0, 120));

    const lowKeyRes = await call('POST', '/v1/admin/keys',
      { name: 'L1 只读', scopes: ['search', 'read'], reader_level: 1 }, ROOT_KEY);
    const lowKey = lowKeyRes.data.plaintext;
    check('可签发低等级密钥', lowKeyRes.status === 201 && lowKeyRes.data.reader_level === 1);

    const lowHit = await call('POST', '/v1/search', { query: '期权几年归属', debug: true }, lowKey);
    check('低等级密钥检索不到机密文档', lowHit.data.total === 0, `实际命中 ${lowHit.data.total}`);
    const highHit = await call('POST', '/v1/search', { query: '期权几年归属' }, keyA);
    check('高等级密钥能检索到机密文档',
      highHit.data.total > 0 && highHit.data.hits[0].min_level === 4, `命中 ${highHit.data.total}`);
    const lowDoc = await call('GET', `/v1/documents/${secret.data.docId}`, null, lowKey);
    check('低等级密钥读机密文档返回 403', lowDoc.status === 403, `实际 ${lowDoc.status}`);
    const lowDl = await fetch(`${BASE}/v1/documents/${secret.data.docId}/file`, {
      headers: { Authorization: `Bearer ${lowKey}` },
    });
    check('低等级密钥下载机密原件被拒', lowDl.status === 403 || lowDl.status === 404, `实际 ${lowDl.status}`);

    const lowList = await call('GET', '/v1/documents?limit=200', null, lowKey);
    const leak = (lowList.data.items || []).filter((d) => Number(d.min_level) > 1);
    check('低等级密钥的文档列表不含机密文档',
      lowList.status === 200 && leak.length === 0,
      `漏出 ${leak.map((d) => `${d.title}(L${d.min_level})`).join('、') || '无'}`);

    const hiListAll = await call('GET', '/v1/documents?limit=200', null, keyA);
    const hiListL1 = await call('GET', '/v1/documents?limit=200&level=1', null, keyA);
    check('高等级密钥可按 level 压低列表范围',
      hiListL1.data.total < hiListAll.data.total
      && (hiListL1.data.items || []).every((d) => Number(d.min_level) === 1),
      `level=1 得 ${hiListL1.data.total} 篇，全量 ${hiListAll.data.total} 篇`);

    const hiDocLowered = await call('GET', `/v1/documents/${secret.data.docId}?level=1`, null, keyA);
    check('单篇读取也认 level 压低', hiDocLowered.status === 403, `实际 ${hiDocLowered.status}`);

    const lowMeta = await call('GET', '/v1/meta', null, lowKey);
    check('概览数字按等级口径给出',
      lowMeta.data.reader_level === 1
      && lowMeta.data.corpus.documents < lowMeta.data.corpus.total_documents,
      `可见 ${lowMeta.data.corpus?.documents} / 全部 ${lowMeta.data.corpus?.total_documents}`);

    const secretFaq = await call('POST', '/v1/faqs', {
      question: '期权行权价是多少', answer: '行权价按授予日收盘价上浮 10%，仅管理层可知。', min_level: 4,
    }, keyA);
    check('可创建带密级的 FAQ', secretFaq.status === 201);
    const lowFaqs = await call('GET', '/v1/faqs?limit=200', null, lowKey);
    const faqLeak = (lowFaqs.data.items || []).filter((f) => Number(f.min_level) > 1);
    check('低等级密钥的 FAQ 列表不含机密条目',
      lowFaqs.status === 200 && faqLeak.length === 0,
      `漏出 ${faqLeak.map((f) => `L${f.min_level}:${f.question}`).join('、') || '无'}`);
    const lowAskSecret = await call('POST', '/v1/ask', { query: '期权行权价是多少' }, lowKey);
    check('低等级密钥不会命中机密 FAQ', lowAskSecret.data.mode !== 'faq', `模式 ${lowAskSecret.data.mode}`);

    // ---------- 管理后台：登录与权限 ----------
    const adm = adminClient();
    const login = await adm.call('POST', '/admin/api/login', OWNER);
    check('企业负责人可登录后台',
      login.status === 200 && login.data.user?.role === 'owner',
      JSON.stringify(login.data).slice(0, 140));
    check('登录返回 HttpOnly 会话 Cookie', Boolean(adm.cookie));

    const me = await adm.call('GET', '/admin/api/me');
    check('/me 返回企业标识与权限',
      me.data.user?.tenant_id === INSTANCE && me.data.user?.permissions?.includes('*'),
      JSON.stringify(me.data.user || {}).slice(0, 100));

    const ov = await adm.call('GET', '/admin/api/overview');
    check('概览返回本企业语料与向量', ov.data.corpus?.chunks > 0 && ov.data.vectors?.chunks > 0);
    check('概览自检通过（实例存在）', ov.data.self_check === 'ok', String(ov.data.self_check));

    const mk = await adm.call('POST', '/admin/api/members', {
      email: 'editor@smoke.local', name: '冒烟编辑', role: 'editor', level: 2,
    });
    check('负责人可创建成员并返回初始密码',
      mk.status === 201 && Boolean(mk.data.initial_password),
      JSON.stringify(mk.data).slice(0, 160));

    const mkAdmin = await adm.call('POST', '/admin/api/members', {
      email: 'admin2@smoke.local', name: '冒烟管理员', role: 'admin', level: 4,
    });
    check('负责人可授予 admin 角色', mkAdmin.status === 201,
      JSON.stringify(mkAdmin.data).slice(0, 120));

    const ed = adminClient();
    const edLogin = await ed.call('POST', '/admin/api/login',
      { email: 'editor@smoke.local', password: mk.data.initial_password });
    check('新成员可用初始密码登录', edLogin.status === 200,
      JSON.stringify(edLogin.data).slice(0, 120));
    const edMembers = await ed.call('GET', '/admin/api/members');
    check('编辑无成员管理权限（403）', edMembers.status === 403, `实际 ${edMembers.status}`);
    const edKeys = await ed.call('GET', '/admin/api/keys');
    check('编辑无密钥管理权限（403）', edKeys.status === 403, `实际 ${edKeys.status}`);
    const edDocs = await ed.call('GET', '/admin/api/documents?limit=50');
    check('编辑看不到高于自身等级的文档',
      edDocs.status === 200 && edDocs.data.items.every((i) => Number(i.min_level) <= 2),
      JSON.stringify(edDocs.data.items?.map((i) => i.min_level)));
    const edPwd = await ed.call('PATCH', `/admin/api/documents/${secret.data.docId}`, { min_level: 1 });
    check('编辑不能修改密级（403）', edPwd.status === 403, `实际 ${edPwd.status}`);

    const adm2 = adminClient();
    await adm2.call('POST', '/admin/api/login',
      { email: 'admin2@smoke.local', password: mkAdmin.data.initial_password });
    const esc = await adm2.call('POST', '/admin/api/members',
      { email: 'x@smoke.local', role: 'owner', level: 5 });
    check('admin 不能授予 owner（403）', esc.status === 403, `实际 ${esc.status}`);

    const lo = await adm.call('POST', '/admin/api/logout');
    check('登出成功', lo.status === 200);
    const afterLo = await adm.call('GET', '/admin/api/me');
    check('登出后会话失效（401）', afterLo.status === 401, `实际 ${afterLo.status}`);

    // ---------- 向量状态与重建 ----------
    const vec = await adm2.call('GET', '/admin/api/vectors');
    check('后台可查看向量状态', vec.status === 200 && typeof vec.data.chunks === 'number');
    check('向量表就在主库（file 指向 kb.db）',
      String(vec.data.file || '').endsWith('kb.db'), vec.data.file);
    const rb = await adm2.call('POST', '/admin/api/vectors/rebuild');
    check('后台可重建向量',
      rb.status === 200 && typeof rb.data.vectors?.chunks === 'number',
      JSON.stringify(rb.data).slice(0, 140));

    // ---------- 单库复核 ----------
    const dbEnd = readInstanceDb();
    check('单库里有文档与向量', dbEnd.documents > 0 && dbEnd.vectors > 0,
      `文档 ${dbEnd.documents} / 向量 ${dbEnd.vectors}`);
    check('库内所有文档都属于本实例',
      dbEnd.foreign === 0 && dbEnd.marks.every((m) => m === INSTANCE),
      JSON.stringify(dbEnd.marks));
    check('数据目录下没有第二个数据库文件',
      readdirSync(TMP).filter((f) => f.endsWith('.db')).length === 1,
      readdirSync(TMP).filter((f) => f.endsWith('.db')).join(','));

    // 数据目录结构：kb.db + files/ 就是全部
    check('原件按企业目录存放', existsSync(join(TMP, 'files')), join(TMP, 'files'));
  } finally {
    stop();
    await new Promise((r) => setTimeout(r, 350));
    try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\n${'─'.repeat(52)}`);
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) {
    console.log('\n失败明细：');
    for (const f of failures) console.log(`  · ${f}`);
    if (stderrBuf) console.log('\n服务端 stderr:\n' + stderrBuf.slice(-1500));
  }
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(fail ? 1 : 0), 600);
}

main().catch((e) => {
  console.error('测试运行失败:', e.message);
  process.exit(1);
});
