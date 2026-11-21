import { initAll } from '../src/bootstrap.js';

const DOCS = [
  {
    space: 'product',
    spaceName: '产品文档',
    title: '知识库开放接口接入指南',
    tags: ['接入', 'api', '鉴权'],
    text: `# 知识库开放接口接入指南

## 适用范围

本文档面向需要接入知识库开放接口的企业业务系统与内部工具。适用于订单系统、客服工单系统以及各类 AI Agent 应用。

## 鉴权方式

所有接口使用 Bearer Token 认证。企业项目在管理后台创建 API Key 后，需在请求头中携带：

\`\`\`
Authorization: Bearer kb_live_xxxxxxxxxxxx
\`\`\`

API Key 按租户隔离，不同租户的数据物理隔离，密钥无法跨租户访问。密钥只在创建时明文展示一次，请立即存入密钥管理系统。

## 权限范围

密钥包含四种权限范围：search 检索、read 读取文档、write 写入文档、admin 管理空间与密钥。最小权限原则下，只读业务系统应只申请 search 与 read。

## 限流规则

默认每个密钥每分钟 120 次请求，超出后返回 429 状态码并附带 Retry-After 响应头。如需提升配额，联系知识库负责人申请。

## 核心接口

检索接口 POST /v1/search 返回原文片段，适合自行接入大模型的业务系统；问答接口 POST /v1/ask 直接返回带引用的答案，适合不想自建模型链路的系统。

## 常见错误码

401 表示密钥无效或已吊销；403 表示权限范围不足；404 表示资源不存在或不属于该租户；429 表示触发限流；500 表示服务端异常，建议指数退避重试。`,
  },
  {
    space: 'norm',
    spaceName: '内部规范',
    title: '知识入库与标签规范',
    tags: ['规范', '标签', '入库'],
    text: `# 知识入库与标签规范

## 文档命名

文件名统一使用「业务域_主题_版本」，例如「订单_退款流程_v2.md」。禁止使用「新建文档」「最终版」「副本」这类命名。

## 必须包含的章节

一份合格的团队知识文档至少包含：背景与适用范围、操作步骤、注意事项、负责人、最近更新时间。缺少负责人的文档在季度盘点时会被标记为待认领。

## 标签规范

标签使用小写英文或简短中文，单文档不超过 5 个。一级标签只能从固定集合中选取：接入、规范、流程、故障、复盘、设计、faq。

## 切分与索引

系统按一级到三级标题切分，单块上限 700 字，相邻块保留 80 字重叠。标题会作为独立权重计入检索，因此请避免使用「其他」「补充说明」这类无信息量的标题。

## 更新与过期

文档内容变更后重新入库即可，系统通过内容哈希判断是否变化，未变化的文档会自动跳过，不会重复建索引。超过 12 个月未更新的文档会在运营报表中标记为待复核。`,
  },
  {
    space: 'faq',
    spaceName: '售后支持',
    title: '售后常见问题汇总',
    tags: ['售后', '退款', '发票'],
    text: `# 售后常见问题汇总

## 退款多久能到账

审核通过后，原路退回一般 1 到 3 个工作日到账，银行卡支付可能延迟至 7 个工作日。若超过时限未到账，请提供订单号由客服发起支付渠道查询。

## 如何申请开发票

在订单详情页点击「申请发票」，填写抬头与税号后提交，电子发票通常在 2 个工作日内发送至预留邮箱。纸质发票需要 5 个工作日邮寄。

## 支持哪些支付方式

目前支持微信支付、支付宝、对公转账三种方式。对公转账需提供开票信息，到账后由财务人工核销，核销周期为 1 个工作日。

## 服务到期后数据会保留多久

服务到期后数据保留 30 天，期间续费可完整恢复。超过 30 天进入冷备存储，恢复需提交工单并支付数据恢复费用。`,
  },
  {
    space: 'ops',
    spaceName: '运维手册',
    title: '线上故障排查手册',
    tags: ['运维', '故障', '排查'],
    minLevel: 3,
    text: `# 线上故障排查手册

## 接口大面积超时

第一步查看网关错误率与 P99 延迟，确认是全面超时还是单接口超时。若为全面超时，优先检查数据库连接池是否耗尽；若为单接口，查看该接口依赖的下游服务健康状态。

## 检索结果为空

先确认租户是否已完成文档入库，可通过文档列表接口核对 doc_count。其次确认检索请求是否带了错误的 space_id。若文档存在但检索不到，检查分词结果是否符合预期，必要时执行全量重建索引。

## 写入报 409 冲突

同一 source_uri 内容未变化时系统会返回 skipped 而非报错。若出现 409，说明文档正在被另一个进程更新，建议串行化写入，避免并发覆盖。

## 数据库锁等待

SQLite 在写入时会获取写锁，长时间事务会导致其他请求排队。排查时检查是否有大文档入库事务未提交，单次入库建议控制在 5 万字符以内。

## 应急联系人

一级故障联系运维值班电话，二级故障在值班群 @ 当班负责人。所有故障处理完成后 24 小时内必须补交复盘文档。`,
  },
  {
    space: 'sales',
    spaceName: '商务与报价',
    title: '客户报价体系与折扣审批权限',
    tags: ['报价', '折扣', '审批'],
    minLevel: 4,
    text: `# 客户报价体系与折扣审批权限

## 适用范围

本文档仅对销售负责人及管理层开放。文档密级为 L4（机密），低于该等级的员工后台账号与接口密钥均检索不到本文内容。

## 标准报价结构

标准版按坐席数阶梯定价，20 坐席以下为标价，20 至 100 坐席享 9 折，100 坐席以上进入年度框架协议谈判。所有报价以人民币含税价签署，跨年度订单须重新核定。

## 折扣审批权限

九折以内由销售经理直接审批；八折至九折须销售总监审批；低于八折须总经理审批并抄送财务。任何情况下不得承诺超过 12 个月的价格锁定。

## 竞品应对口径

遇竞品低价竞标时，不以降价应对，改为增加服务期或赠送培训名额。价格让步必须换取合同年限或预付比例，禁止单纯降价。

## 禁止事项

禁止向客户出示本文件的任何截图或原文；禁止在公开渠道讨论折扣底线；违反者按公司保密制度处理。`,
  },
];

async function main() {
  await initAll();
  const { ensureInstance, getInstance, createApiKey, ensureSpace, listApiKeys, createFaq, listFaqs } = await import('../src/store.js');
  const { ingestDocument } = await import('../src/ingest.js');

  let tenant = getInstance();
  if (!tenant) {
    tenant = ensureInstance({ name: '演示企业 · 示例科技' });
    console.log(`✓ 初始化企业 ${tenant.id} (${tenant.name})`);
  } else {
    console.log(`· 企业已初始化 ${tenant.id} (${tenant.name})`);
  }

  for (const d of DOCS) {
    const space = ensureSpace(tenant.id, d.space, d.spaceName);
    const r = ingestDocument({
      tenantId: tenant.id,
      spaceId: space.id,
      title: d.title,
      text: d.text,
      docType: 'md',
      sourceType: 'seed',
      sourceUri: `seed://${d.space}/${d.title}`,
      tags: d.tags,
      uploader: 'seed@demo.local',
      minLevel: d.minLevel || 1,
    });
    const lv = d.minLevel ? ` L${d.minLevel}` : '';
    const st = r.releveled ? '已改密级' : r.status;
    console.log(`  ${r.status === 'created' ? '✓' : '·'} ${d.title}${lv} — ${st}, ${r.chunkCount ?? 0} 块`);
  }

  const FAQS = [
    { q: '退款要几天到账', a: '审核通过后原路退回，一般 1 到 3 个工作日到账；银行卡支付可能延迟至 7 个工作日。', tags: ['售后', '退款'] },
    { q: '怎么获取 API Key', a: '登录管理后台，在「租户 - 密钥管理」创建，按最小权限原则勾选 scopes，明文只在创建时显示一次。', tags: ['接入', '鉴权'] },
    { q: '超出调用频率限制怎么办', a: '默认每分钟 120 次。触发后返回 429 与 Retry-After，请做指数退避；需提升配额联系知识库负责人。', tags: ['接入', '限流'] },
    { q: '文档更新后多久生效', a: '重新入库即生效。系统按内容哈希判断是否变化，内容未变化会自动跳过，不会重复建索引。', tags: ['入库'] },
    // 密级 4 的 FAQ：只有 L4 及以上的密钥/后台账号才可能命中
    { q: '最低能给到几折', a: '低于八折须总经理审批。九折以内销售经理可直接审批；八折至九折须销售总监审批并抄送财务。', tags: ['报价', '折扣'], minLevel: 4 },
  ];
  // 逐条补齐（不覆写已有条目）：这样新增的密级 FAQ 在重复执行 seed 时也能落地
  const existQ = new Set(listFaqs(tenant.id, { limit: 500 }).items.map((f) => f.question));
  const added = [];
  for (const f of FAQS) {
    if (existQ.has(f.q)) continue;
    createFaq({ tenantId: tenant.id, question: f.q, answer: f.a, tags: f.tags, minLevel: f.minLevel || 1 });
    added.push(f);
  }
  console.log(added.length
    ? `✓ 新增 ${added.length} 条 FAQ（其中 ${added.filter((f) => f.minLevel).length} 条带密级）`
    : '· FAQ 均已存在，未重复创建');

  let key = null;
  const existing = listApiKeys(tenant.id);
  if (!existing.length) {
    key = createApiKey({ tenantId: tenant.id, name: '演示密钥', scopes: ['search', 'read', 'write', 'admin'] });
    console.log(`\n✓ 演示 API Key（仅本次显示，请保存）:\n  ${key.plaintext}`);
  } else {
    console.log(`\n· 已有 ${existing.length} 个密钥，未重复创建（如需新密钥执行 npm run cli -- key:create t_demo）`);
  }

  // ---------- 企业后台账号：覆盖五种角色与不同员工等级 ----------
  const { ensureOwner, createMember, listMembers } = await import('../src/rbac.js');
  const have = new Set(listMembers(tenant.id).map((m) => m.email));
  const created = [];

  if (!have.size) {
    const o = ensureOwner(tenant.id, { email: 'owner@demo.local', password: 'Demo@2026', name: '张总（企业负责人）' });
    if (o.created) created.push(['owner', o.user.email, 'Demo@2026', 'L5', '全部权限']);
  }
  const DEMO_MEMBERS = [
    ['admin@demo.local', '李管理', 'admin', 5, '信息部', 'Demo@2026', '除转移企业外的全部权限'],
    ['manager@demo.local', '王经理', 'manager', 4, '销售部', 'Demo@2026', '可见到 L4 机密'],
    ['editor@demo.local', '赵编辑', 'editor', 3, '运营部', 'Demo@2026', '可上传维护到 L3'],
    ['viewer@demo.local', '钱新人', 'viewer', 1, '客服部', 'Demo@2026', '只看 L1 公开'],
  ];
  const now2 = new Set(listMembers(tenant.id).map((m) => m.email));
  for (const [email, name, role, level, dept, pwd, note] of DEMO_MEMBERS) {
    if (now2.has(email)) continue;
    try {
      createMember({ tenantId: tenant.id, email, name, role, level, department: dept, password: pwd, createdBy: null });
      created.push([role, email, pwd, `L${level}`, note]);
    } catch (e) {
      console.log(`  ! 创建 ${email} 失败：${e.message}`);
    }
  }

  if (created.length) {
    console.log('\n✓ 企业后台账号（访问 /admin 登录，演示密码均为 Demo@2026，上线前请全部改掉）:');
    console.log('  ' + ['角色', '账号', '密码', '等级', '说明'].join(' | '));
    for (const row of created) console.log('  ' + row.join(' | '));
  } else {
    console.log('\n· 后台账号已存在，未重复创建（如需重置执行 npm run cli -- admin:reset t_demo --email owner@demo.local）');
  }

  const { getStats } = await import('../src/indexer.js');
  console.log(`\n语料规模: ${JSON.stringify(getStats(tenant.id))}`);
}

main().catch((e) => {
  console.error('✗ seed 失败:', e.message);
  process.exit(1);
});
