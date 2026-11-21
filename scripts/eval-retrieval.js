/**
 * 检索质量评测（A/B）。
 *
 * 为什么要有这个脚本：
 * 「检索准不准」不能靠感觉。这里用一份人工标注的问答集，
 * 分别在「纯 BM25」和「BM25 + 短语/字段/邻近/硬词加权」两种模式下跑，
 * 输出 recall@3、recall@5、MRR —— 加成分到底有没有用，数据说话。
 *
 * 用法：node scripts/eval-retrieval.js
 */
import { listTenants, ensureInstance, getTenant, ensureSpace } from '../src/store.js';
import { tdb } from '../src/tenant-db.js';
import { ingestDocument, deleteDocument } from '../src/ingest.js';
import { search } from '../src/indexer.js';
import { embedBatch, embedQuery, currentModel } from '../src/embed.js';
import { upsertVectors, removeAllVectors } from '../src/vectors.js';
import { config } from '../src/config.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// 评测用独立数据库，绝不动正式数据。必须在第一次打开库之前设置。
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
process.env.KB_DB = process.env.KB_DB || resolve(ROOT, 'data', 'eval', 'kb.db');

const TENANT = 't_eval';

const DOCS = [
  {
    space: '财务制度',
    title: '差旅报销制度',
    text: `# 差旅报销制度

## 适用范围
本制度适用于公司全体正式员工与实习生，外包人员按合同约定执行，不适用本标准。

## 住宿标准
一线城市每晚不超过 600 元，二线城市每晚不超过 400 元，其他城市每晚不超过 300 元。超标部分由个人承担，特殊情况需总经理特批。

## 市内交通
单次不超过 100 元，超出部分需部门负责人签字说明原因。机场往返建议乘坐地铁或机场大巴。

## 审批流程
员工在 OMS 系统提交报销单，附上发票原件与出差审批单，经直属主管、部门负责人、财务三方审批后，7 个工作日内到账。

## 票据要求
发票抬头必须是公司全称，税号需完整。电子发票需打印后粘贴，金额不得涂改。`,
  },
  {
    space: '人事制度',
    title: '请假与考勤管理办法',
    text: `# 请假与考勤管理办法

## 年假
入职满一年享有 5 天带薪年假，满三年 7 天，满五年 10 天。年假可跨年顺延至次年 3 月 31 日，逾期作废。

## 病假
病假需提供二级以上医院开具的诊断证明与病假条。连续病假超过 3 天需人力资源部备案，超过 15 天按医疗期处理。

## 事假
事假为无薪假，需提前 2 个工作日申请，单月累计不超过 3 天。

## 加班与调休
工作日加班按 1 倍时长调休，法定节假日加班按 2 倍调休。调休需在加班发生后 6 个月内使用，过期不补。

## 打卡规则
每日上下班各打卡一次，漏打卡当月可补卡 3 次，超出按迟到处理。`,
  },
  {
    space: 'IT 支持',
    title: 'IT 支持与设备管理手册',
    text: `# IT 支持与设备管理手册

## 如何报修
电脑故障请在企业微信「IT 服务台」提交工单，或发送邮件至 it-support@example.com。紧急故障可拨分机 8001。

## 账号与密码
域账号密码每 90 天强制更换，长度不少于 12 位，需包含大小写字母与数字。忘记密码可通过 SSO 自助找回。

## VPN 接入
远程办公必须通过公司 VPN 网关 vpn.example.com 接入。令牌每 12 小时过期一次，过期后用 SSO 重新认证。连续 5 次输错将锁定账号 30 分钟。

## 打印机
每层茶水间旁设有共享打印机，首次使用需安装驱动并绑定工号，黑白打印免费，彩色打印需部门预算审批。

## 设备领用
新员工入职当天在 IT 前台领取笔记本与配件，离职时需原样归还，损坏按折旧价赔偿。`,
  },
  {
    space: '采购',
    title: '采购管理办法',
    text: `# 采购管理办法

## 申请流程
需求部门在 SRM 系统发起采购申请，填写用途、预算与期望到货时间，依次经部门负责人、采购部、财务审批。

## 金额分级
单笔 5000 元以下由部门负责人审批；5000 至 50000 元需采购部会签；50000 元以上需总经理审批并走招标流程。

## 供应商准入
新供应商须提供营业执照、开户许可证与近一年财务报表，通过资质审核后进入合格供应商名录，每年复审一次。

## 验收与付款
到货后 3 个工作日内由需求部门验收，验收单需与采购订单一致，财务见验收单后 30 天内付款。`,
  },
  {
    space: '人事制度',
    title: '员工入职指引',
    text: `# 员工入职指引

## 试用期
普通岗位试用期 3 个月，管理岗位 6 个月，试用期工资为转正工资的 80%。试用期满前 10 天发起转正评估。

## 入职材料
需提供身份证、学历证书、离职证明、体检报告与一寸照片两张。材料不全者暂缓办理入职。

## 账号开通
入职前 1 个工作日由 HR 提交开通申请，IT 在当天完成域账号、邮箱与企业微信的开通。

## 导师制度
每位新员工配一名导师，为期 3 个月，负责业务讲解与融入辅导，导师津贴每月 500 元。`,
  },
  {
    space: '人事制度',
    title: '离职交接规范',
    text: `# 离职交接规范

## 提前通知
正式员工需提前 30 天提交书面离职申请，试用期员工提前 3 天。未按规定提前通知造成损失的，按合同约定处理。

## 交接清单
需完成工作交接、客户与供应商告知、文件归档、设备归还、权限回收五项。交接单需直属主管与接手人双方签字。

## 薪资结算
最后一个工作日后的 15 日内结清工资与未使用年假折算，绩效奖金按实际在职月份折算发放。

## 保密义务
离职后仍需遵守保密协议，竞业限制期限最长 2 年，期间按约定支付补偿金。`,
  },
  {
    space: 'IT 支持',
    title: '信息安全与保密要求',
    text: `# 信息安全与保密要求

## 数据分级
公司数据分为公开、内部、机密、绝密四级。机密及以上数据禁止存放在个人网盘、私人邮箱或未加密的移动介质中。

## 外发管控
对外发送含客户信息的文件须先脱敏，并通过加密邮件或企业网盘分享链接，链接有效期不超过 7 天。

## 终端安全
办公电脑必须开启磁盘加密与屏幕锁定，离开工位超过 5 分钟需锁屏。禁止安装来源不明的软件。

## 事件上报
发现数据泄露或账号异常，应在 1 小时内上报安全邮箱 security@example.com，隐瞒不报将从重处理。`,
  },
  {
    space: '行政',
    title: '会议室与工位管理',
    text: `# 会议室与工位管理

## 会议室预订
会议室通过企业微信「会议室」应用预订，单次最长 2 小时，超时需重新预订。超过 15 分钟未到场视为放弃。

## 工位安排
工位由行政部统一分配，不得私自调换。项目组临时集中办公需提前 1 周申请。

## 访客接待
访客需在前台登记并领取访客卡，由接待人全程陪同，访客卡当日归还。`,
  },
  // ---- 以下是有意加入的「干扰文档」：主题相邻、用词高度重叠 ----
  {
    space: '财务制度',
    title: '业务招待费管理规定',
    text: `# 业务招待费管理规定

## 招待标准
招待客户人均不超过 300 元，陪同人数不得超过对方人数。超标需事前申请，事后补批一律不受理。

## 审批流程
招待前在 OMS 系统提交招待申请，注明客户名称、人数与预算，经部门负责人与财务审批后方可执行。

## 票据要求
发票需为餐饮或会务类，发票抬头必须是公司全称，并附消费清单。礼品类支出不计入招待费。

## 禁止事项
禁止在娱乐场所消费，禁止向客户赠送现金或有价证券。`,
  },
  {
    space: '财务制度',
    title: '通讯与交通补贴办法',
    text: `# 通讯与交通补贴办法

## 补贴标准
通讯补贴每月 200 元，交通补贴每月 300 元，与工资一并发放，不另行报销发票。

## 申领条件
需在岗满 1 个月，出差期间不再重复享受交通补贴。

## 特殊岗位
销售岗位通讯补贴上浮 50%，需部门负责人确认岗位属性。`,
  },
  {
    space: 'IT 支持',
    title: '远程办公管理规定',
    text: `# 远程办公管理规定

## 申请方式
远程办公需提前 1 个工作日在 OA 提交申请，经直属主管审批，每周不超过 2 天。

## 接入要求
远程办公必须通过公司 VPN 接入内网，禁止使用公共 Wi-Fi 直连业务系统。令牌过期后需重新认证。

## 设备要求
使用公司配发的笔记本，个人设备不得接入内网。摄像头需在会议期间开启。

## 考勤
远程办公期间照常打卡，工作响应时间不超过 30 分钟。`,
  },
  {
    space: '人事制度',
    title: '培训与考核制度',
    text: `# 培训与考核制度

## 新人培训
入职首月完成必修课程共 8 学时，包括公司介绍、信息安全、业务系统操作。

## 试用期考核
试用期结束前进行转正答辩，评分低于 70 分延长试用期一次，最长不超过 3 个月。

## 年度考核
每年 1 月进行年度绩效评估，分为 A/B/C/D 四档，连续两年 D 档启动改进计划。

## 培训资源
每人每年享有 2000 元外部培训预算，需提前申请并与岗位相关。`,
  },
  {
    space: '行政',
    title: '固定资产管理制度',
    text: `# 固定资产管理制度

## 资产范围
单价 2000 元以上、使用年限超过 1 年的设备纳入固定资产管理，包括笔记本、显示器、服务器。

## 采购与验收
固定资产采购走采购流程，到货后由行政部与使用部门共同验收，粘贴资产标签并登记台账。

## 折旧
电子设备按 3 年直线折旧，残值率 5%。家具按 5 年折旧。

## 盘点与报废
每年 12 月全量盘点，盘亏需说明原因。报废需技术鉴定后由行政部统一处理。`,
  },
  {
    space: 'IT 支持',
    title: '数据备份与恢复规范',
    text: `# 数据备份与恢复规范

## 备份频率
核心业务数据库每日全量备份、每小时增量备份，保留 30 天。文件服务器每周全量备份。

## 存储位置
备份数据存放在异地机房，与生产环境物理隔离，禁止存放在个人网盘。

## 恢复演练
每季度进行一次恢复演练，恢复时间目标 4 小时，恢复点目标 1 小时。

## 责任分工
IT 运维组负责执行备份，安全组每季度抽查备份完整性。`,
  },
];

/** 标注集：问题 → 正确文档 + 正确章节关键字（不含则只要文档对即可） */
const QUERIES = [
  { q: '出差住宿最多能报多少钱', doc: '差旅报销制度', heading: '住宿' },
  { q: '报销单提交后多久到账', doc: '差旅报销制度', heading: '审批' },
  { q: '发票抬头开错了怎么办', doc: '差旅报销制度', heading: '票据' },
  { q: '年假有几天，能留到明年吗', doc: '请假与考勤管理办法', heading: '年假' },
  { q: '请病假需要医院开证明吗', doc: '请假与考勤管理办法', heading: '病假' },
  { q: '加班之后怎么调休', doc: '请假与考勤管理办法', heading: '加班' },
  { q: '电脑坏了找谁修', doc: 'IT 支持与设备管理手册', heading: '报修' },
  { q: 'VPN 令牌过期了怎么办', doc: 'IT 支持与设备管理手册', heading: 'VPN' },
  { q: '打印机在哪里，彩色打印要审批吗', doc: 'IT 支持与设备管理手册', heading: '打印' },
  { q: '五万以上的采购要走什么流程', doc: '采购管理办法', heading: '金额' },
  { q: '新供应商怎么进合格名录', doc: '采购管理办法', heading: '供应商' },
  { q: '试用期多久，工资怎么算', doc: '员工入职指引', heading: '试用期' },
  { q: '离职要提前多少天说', doc: '离职交接规范', heading: '提前' },
  { q: '客户资料能放个人网盘吗', doc: '信息安全与保密要求', heading: '数据分级' },
  { q: '会议室订了没去会怎样', doc: '会议室与工位管理', heading: '预订' },
  // 以下为「干扰项」题：正确答案与干扰文档用词高度重叠，纯词法容易排错
  { q: '招待客户人均能花多少', doc: '业务招待费管理规定', heading: '招待标准' },
  { q: '通讯补贴每月发多少钱', doc: '通讯与交通补贴办法', heading: '补贴标准' },
  { q: '远程办公一周最多几天', doc: '远程办公管理规定', heading: '申请' },
  { q: '固定资产折旧按几年算', doc: '固定资产管理制度', heading: '折旧' },
  { q: '备份数据保留多久', doc: '数据备份与恢复规范', heading: '备份频率' },
  { q: '转正答辩不及格会怎样', doc: '培训与考核制度', heading: '试用期考核' },
  { q: '出差期间还能拿交通补贴吗', doc: '通讯与交通补贴办法', heading: '申领条件' },
  // 换词题：与原文几乎没有相同的 bigram，考的是「语义」而不是「字面」
  { q: '住一晚酒店最多能报多少钱', doc: '差旅报销制度', heading: '住宿', hard: true },
  { q: '钱打回银行卡要等多久', doc: '差旅报销制度', heading: '审批', hard: true },
  { q: '买大件东西要谁签字', doc: '采购管理办法', heading: '金额', hard: true },
  { q: '资料能不能存在自己的网盘里', doc: '信息安全与保密要求', heading: '数据分级', hard: true },
  { q: '电脑开不了机找谁', doc: 'IT 支持与设备管理手册', heading: '报修', hard: true },
  { q: '在家上班一周最多几天', doc: '远程办公管理规定', heading: '申请', hard: true },
];

function resetTenant() {
  ensureInstance({ name: '评测实例' });
  const d = tdb(TENANT);
  // 默认跑在 data/eval/kb.db 这个独立库里，可以整库清空；
  // 万一有人把 KB_DB 指到正式库，只删评测来源的文档，绝不碰真实资料。
  const isEvalDb = /eval/i.test(config.database);
  const old = isEvalDb
    ? d.all(`SELECT id FROM documents`)
    : d.all(`SELECT id FROM documents WHERE source_uri LIKE 'eval://%'`);
  for (const doc of old) deleteDocument(TENANT, doc.id);
}

function ingestCorpus() {
  for (const d of DOCS) {
    ensureSpace(TENANT, d.space);
    ingestDocument({
      tenantId: TENANT,
      spaceSlug: d.space,
      title: d.title,
      text: d.text,
      docType: 'md',
      sourceType: 'eval',
      sourceUri: `eval://${d.title}`,
    });
  }
}

async function backfillVectors() {
  const d = tdb(TENANT);
  const rows = d.all(`SELECT c.id, c.doc_id, c.space_id, c.heading, c.content
                      FROM chunks c JOIN documents d ON d.id = c.doc_id`);
  removeAllVectors(TENANT);
  const model = currentModel();
  const B = 32;
  for (let i = 0; i < rows.length; i += B) {
    const slice = rows.slice(i, i + B);
    const vecs = await embedBatch(slice.map((r) => `${r.heading || ''}\n${r.content}`));
    upsertVectors(TENANT, slice.map((r, k) => ({
      id: r.id, docId: r.doc_id, spaceId: r.space_id, vec: vecs[k],
    })), model);
  }
  return rows.length;
}

function match(hit, target) {
  const docOk = hit.doc_title === target.doc || hit.doc_title.includes(target.doc) || target.doc.includes(hit.doc_title);
  if (!docOk) return false;
  if (!target.heading) return true;
  return String(hit.heading || '').includes(target.heading);
}

async function run(mode) {
  const opts = mode === 'bm25'
    ? { plain: true, vector: false }
    : mode === 'lexical'
      ? { plain: false, vector: false }
      : { plain: false, vector: true };

  const rows = [];
  let hit3 = 0;
  let hit5 = 0;
  let rr = 0;
  let hardHit = 0;
  let hardTotal = 0;
  const lat = [];

  for (const t of QUERIES) {
    const t0 = process.hrtime.bigint();
    const queryVec = opts.vector ? await embedQuery(t.q) : null;
    const r = search(TENANT, { query: t.q, topK: 5, expand: false, debug: true, queryVec, ...opts });
    lat.push(Number(process.hrtime.bigint() - t0) / 1e6);

    const rank = r.hits.findIndex((h) => match(h, t));
    const at = rank >= 0 ? rank + 1 : Infinity;
    if (at <= 3) hit3 += 1;
    if (at <= 5) hit5 += 1;
    if (at !== Infinity) rr += 1 / at;
    if (t.hard) {
      hardTotal += 1;
      if (at === 1) hardHit += 1;
    }

    rows.push({
      query: t.q,
      hard: Boolean(t.hard),
      expect: `${t.doc}${t.heading ? ' / ' + t.heading : ''}`,
      rank: at,
      top1: r.hits[0] ? `${r.hits[0].doc_title} / ${r.hits[0].heading || '-'}` : '(无)',
    });
  }

  const n = QUERIES.length;
  lat.sort((a, b) => a - b);
  return {
    rows,
    top1: rows.filter((r) => r.rank === 1).length / n,
    recall3: hit3 / n,
    recall5: hit5 / n,
    mrr: rr / n,
    hardTop1: hardTotal ? hardHit / hardTotal : 0,
    p50: lat[Math.floor(n * 0.5)],
    p95: lat[Math.min(n - 1, Math.floor(n * 0.95))],
  };
}

function pct(v) {
  return (v * 100).toFixed(1) + '%';
}

// ---------------- 执行 ----------------
resetTenant();
ingestCorpus();
const vecCount = await backfillVectors();

const base = await run('bm25');
const lexical = await run('lexical');
const hybrid = await run('hybrid');

const W = 34;
function pad(s, n) {
  const str = String(s);
  const width = [...str].reduce((w, c) => w + (c.charCodeAt(0) > 255 ? 2 : 1), 0);
  return str + ' '.repeat(Math.max(0, n - width));
}

console.log(`\n语料：${DOCS.length} 篇文档 / ${vecCount} 个块已向量化 / 标注 ${QUERIES.length} 条问题（换词题 ${QUERIES.filter((x) => x.hard).length} 条）`);
console.log(`向量模型：${currentModel().model}（${currentModel().dim} 维）`);
console.log('对比：① 纯 BM25  ② BM25 + 短语/字段/邻近/硬词  ③ ② + 向量召回\n');
console.log(pad('问题', W) + pad('正确答案位置', 24) + pad('①', 10) + pad('②', 10) + '③');
console.log('─'.repeat(88));
for (let i = 0; i < base.rows.length; i++) {
  const b = base.rows[i];
  const l = lexical.rows[i];
  const h = hybrid.rows[i];
  const f = (r) => (r === Infinity ? '✗' : `#${r}`);
  const mark = b.hard ? '· ' : '';
  console.log(mark + pad(b.query.slice(0, 15), W - 2) + pad(b.expect.slice(0, 12), 24) + pad(f(b.rank), 10) + pad(f(l.rank), 10) + f(h.rank));
}
console.log('─'.repeat(88));
console.log(pad('top-1 准确率', W) + pad('', 24) + pad(pct(base.top1), 10) + pad(pct(lexical.top1), 10) + pct(hybrid.top1));
console.log(pad('recall@3', W) + pad('', 24) + pad(pct(base.recall3), 10) + pad(pct(lexical.recall3), 10) + pct(hybrid.recall3));
console.log(pad('recall@5', W) + pad('', 24) + pad(pct(base.recall5), 10) + pad(pct(lexical.recall5), 10) + pct(hybrid.recall5));
console.log(pad('MRR', W) + pad('', 24) + pad(base.mrr.toFixed(3), 10) + pad(lexical.mrr.toFixed(3), 10) + hybrid.mrr.toFixed(3));
console.log(pad('换词题 top-1', W) + pad('（语义召回）', 24) + pad(pct(base.hardTop1), 10) + pad(pct(lexical.hardTop1), 10) + pct(hybrid.hardTop1));
console.log(pad('延迟 p50 / p95', W) + pad('', 24) + `${base.p50.toFixed(1)}ms / ${base.p95.toFixed(1)}ms（未走缓存）`);

console.log(`\nMRR：${base.mrr.toFixed(3)} → ${lexical.mrr.toFixed(3)} → ${hybrid.mrr.toFixed(3)}`);
console.log('（带 · 的是换词题：与原文几乎没有相同 bigram，只有向量这一路能帮上忙）');

console.log('\n混合模式下仍未命中：');
let missed = 0;
for (const r of hybrid.rows) {
  if (r.rank === Infinity) {
    console.log(`  ✗ 「${r.query}」应命中 ${r.expect}，实际 top1 = ${r.top1}`);
    missed += 1;
  }
}
if (!missed) console.log('  无');

// 失败时用非零退出码，方便接进 CI
process.exit(hybrid.recall5 >= 0.8 ? 0 : 1);
