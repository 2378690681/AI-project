# 企业外置知识库 · KB Hub

![Node](https://img.shields.io/badge/node-%3E%3D22.5-339933?logo=node.js&logoColor=white)
![依赖](https://img.shields.io/badge/dependencies-0-brightgreen)
![测试](https://img.shields.io/badge/tests-86%20passed-success)
![检索](https://img.shields.io/badge/retrieval-hybrid%20BM25%2Bvector-blueviolet)
![License](https://img.shields.io/badge/license-MIT-blue)

一个可以直接给企业级项目对接的**外置知识库服务**：对外提供 REST API，对内提供 MCP 插件，
让业务系统与 AI Agent 用同一种方式查同一份知识。

**零第三方运行时依赖** —— 不需要 `npm install`，不需要数据库服务器，Node 22 自带的 SQLite 就是全部存储。

```
企业业务系统 ──┐
内部工具    ──┼─→ REST API ──┐
AI Agent    ──┘   MCP 插件 ──┴─→ 知识库（SQLite + 词法/向量混合检索）←── 文档 / FAQ 入库
```

### 它能做什么

| 能力 | 说明 |
|---|---|
| **完整保存** | 先落盘再解析，扫描件/加密件解析失败也留原件；同内容按 sha256 去重，每次变更留一个版本 |
| **准确检索** | BM25 之上叠加短语、章节标题、命中邻近、数字硬词四项加权，再融合一路向量召回（`0.7 词法 + 0.3 向量`）；标注集 top-1 准确率 75.0%、MRR 0.804 |
| **快速回答** | FAQ 前置 → 检索 → 原文摘录或大模型生成，**每个答案都带引用出处**；没依据就返回空，不编造 |
| **一企一部署** | 一个企业 = 一个进程 + 一个 `.db` + 一个 `files/` 目录，靠部署边界隔离，不靠 SQL 条件 |
| **双维度权限** | 角色（owner/admin/manager/editor/viewer）× 员工职级（L1~L5），密级在检索、列表、详情、原件、FAQ 每个入口都过滤 |
| **两种接入方式** | REST API（OpenAPI 3.1 契约）给业务系统；MCP 插件（6 个工具）给 AI Agent，检索结果完全一致 |
| **可观测** | 调用审计、`request_id` 追踪、检索通道与分项得分、向量健康状态、库文件路径与大小 |

### 目录

- [1. 五步跑起来](#1-五步跑起来)
- [2. 目录结构](#2-目录结构)
- [3. 核心概念](#3-核心概念)
- [4. 员工上传链路](#4-员工上传链路)（存得全 / 检得准 / 答得快 / 接口一览）
- [5. API 参考](#5-api-参考)
- [6. 企业侧对接](#6-企业侧对接)（curl / Node / Python / MCP）
- [7. 配置](#7-配置)
- [8. 运维](#8-运维)
- [9. 设计取舍](#9-设计取舍)
- [10. 已知限制](#10-已知限制)
- [11. 后续可加](#11-后续可加)

> 更细的两份材料：`docs/企业外置知识库-项目简介.docx`（一页纸）、`docs/企业外置知识库-项目说明书.docx`（14 章完整说明）、
> `docs/部署与权限设计.md`（部署形态与权限判定的设计依据）。

---

## 1. 五步跑起来

```bash
# 1) 初始化（生成 config.json 与数据库，管理根密钥在 config.json 里）
node cli.js init

# 2) 载入演示数据（可选，先看看效果）
node cli.js seed

# 3) 启动服务（默认 http://127.0.0.1:7300）
node server.js

# 4) 写入本企业的实例记录，并建一个 API Key（明文只显示一次）
node cli.js tenant:create "我的公司"

# 5) 灌入自己的文档
node cli.js add-dir "D:/项目文档" --space 项目文档
```

验证一下：

```bash
curl -s http://127.0.0.1:7300/health
curl -s -X POST http://127.0.0.1:7300/v1/search \
  -H "Authorization: Bearer kb_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{"query":"退款多久到账","top_k":3}'
```

浏览器里打开 **http://127.0.0.1:7300/console** 就是调试控制台：粘贴 API Key 后可以直接检索、问答、看引用来源，不用记 curl 参数。

跑自测（在独立临时库上拉起一套实例，86 项断言，不碰正式数据）：

```bash
node scripts/smoke-test.js
```

---

## 2. 目录结构

```
kb-hub/
├── server.js              HTTP 服务入口
├── cli.js                 命令行工具（初始化实例/建密钥/入库/检索）
├── mcp/server.js          MCP 插件（stdio，6 个工具）
├── public/
│   ├── admin.html         企业后台（/admin，成员/密钥/密级/审计）
│   └── console.html       检索控制台（/console，检索/问答/上传）
├── config.json            运行时配置（首次启动自动生成，已 gitignore）
├── data/
│   ├── kb.db              SQLite 数据库
│   ├── files/             原始件存储（<前两位>/<sha256>.<ext>，同内容去重）
│   └── synonyms.json      领域同义词表（可选，自己维护）
├── src/
│   ├── api.js             路由 / 鉴权 / 限流 / 审计
│   ├── answer.js          问答编排（FAQ → 检索 → 抽取或大模型）
│   ├── indexer.js         混合检索（BM25 + 短语/字段/邻近/硬词加权）
│   ├── tokenize.js        中文 bigram + 英文分词
│   ├── splitter.js        按标题分层切块（去纯标题块、按句边界重叠）
│   ├── parsers.js         md/txt/html/csv/docx/pptx/xlsx/pdf 解析
│   ├── storage.js         原始件落盘与读取（sha256 去重）
│   ├── multipart.js       零依赖 multipart/form-data 解析
│   ├── cache.js           LRU + TTL 缓存（epoch 整体失效）
│   ├── ingest.js          入库编排（幂等、版本、解析失败兜底）
│   ├── store.js           实例/空间/密钥/文档/FAQ 数据访问
│   ├── tenant-db.js       单库薄封装（旧 tdb(tenantId) 签名保持兼容）
│   ├── vectors.js         向量表读写（与原文同库，内存全量点积）
│   ├── rbac.js            后台账号、角色与职级
│   ├── admin.js           企业后台页面与接口
│   ├── synonyms.js        同义词归一
│   ├── schema.sql         数据模型（单库 16 张表）
│   └── db.js, config.js, bootstrap.js
├── docs/
│   ├── openapi.json       OpenAPI 3.1 契约（可直接导入 Postman / 生成 SDK）
│   ├── 部署与权限设计.md   部署形态、迁移规则、权限判定、向量实现
│   └── *.docx             项目简介（一页纸）/ 项目说明书（14 章）
├── scripts/
│   ├── seed-demo.js       演示数据
│   ├── sync.js            增量同步（目录 / URL）
│   ├── embed.js           向量补齐 / 重建 / 状态
│   ├── make-fixtures.js   生成 docx/pptx/xlsx/pdf 测试件并自检解析
│   ├── eval-retrieval.js  检索质量评测（标注集 A/B，输出 recall/MRR）
│   ├── mock-embed-server.js 假 embedding 服务（验证远程向量链路）
│   └── smoke-test.js      端到端自测（86 项断言）
└── examples/
    ├── node-client.js     Node 对接示例（含重试与 mode 处理）
    ├── python_client.py   Python 对接示例
    └── mcp-config.json    MCP 客户端配置片段
```

---

## 3. 核心概念

| 概念 | 说明 | 边界 |
|---|---|---|
| **实例 instance** | 一套部署 = 一个企业，对应一个 `.db` 文件与一个 `files/` 目录 | 企业之间靠部署边界与文件系统隔离，不共享连接 |
| **空间 space** | 实例内的知识分区，如「产品文档」「售后支持」 | 检索可限定空间 |
| **文档 document** | 一份入库的原始文档，带版本与内容哈希 | 幂等更新 |
| **块 chunk** | 检索的最小单位，按标题层级切分（默认 700 字，重叠 80） | 命中即返回 |
| **FAQ** | 问答对，命中时直接返回标准答案，不走改写 | 覆盖率高时优先 |

业务表仍保留 `tenant_id` 列，值恒等于 `config.instance.id`（默认 `default`）—— 留着是为了兼容旧代码与旧库升级，**它不再承担隔离职责**：隔离由「一个企业一个库文件」这件事本身完成，一个进程只连自己的库，不存在读到别家数据的路径。

---

## 4. 员工上传链路

员工把内部资料丢进来，要同时满足三件事：**存得全、检得准、答得快**。这三件事是三套机制。

### 4.1 存得全

上传接口收到文件后，顺序是**先落盘、再解析**。

1. **落盘**：按 `sha256` 存到 `data/files/<前两位>/<sha256>.<扩展名>`，同内容只存一份（`doc_files` 表唯一约束）。同一个文件换个名字再传，不占第二份空间，但每次都独立可查。
2. **解析**：抽出文本才建索引。

顺序反了就会丢数据 —— 扫描件、加密 PDF、损坏文件的解析必然失败，如果等到解析完才决定存不存，原件就没了。所以：

- 解析失败的文件**照样入库**，`parse_status='failed'`，能下载、能追溯，只是检索里查不到内容；
- `/v1/meta` 的 `corpus.parse_failed` 会把这类文件的数量报出来，方便运营去补 OCR 或换版本。

内容每变一次，写一条 `document_versions`（含当时的 `file_id`），旧版原件不删不覆盖：

```bash
# 上传（multipart，浏览器可直接用 FormData；单次最多 20 个文件）
curl -X POST http://127.0.0.1:7300/v1/uploads \
  -H "Authorization: Bearer kb_live_xxx" \
  -F "file=@差旅报销制度.docx" \
  -F "file=@员工名册.xlsx" \
  -F "space=制度文档" \
  -F "uploader=wangxm@example.com" \
  -F "tags=人事,财务"

# 也可用 JSON base64（老系统集成更省事）
curl -X POST http://127.0.0.1:7300/v1/uploads \
  -H "Authorization: Bearer kb_live_xxx" -H "Content-Type: application/json" \
  -d '{"filename":"a.md","base64":"IyDmoIfpopg=","space":"规范"}'

# 拿回原件（字节完全一致，ETag 是内容哈希）
curl -OJ http://127.0.0.1:7300/v1/documents/d_xxx/file \
  -H "Authorization: Bearer kb_live_xxx"

# 看版本历史
curl http://127.0.0.1:7300/v1/documents/d_xxx/versions \
  -H "Authorization: Bearer kb_live_xxx"
```

支持的格式：`.md .txt .csv .html .docx .pptx .xlsx .pdf`（+ `.json .yaml .log` 按纯文本处理）。docx / pptx / xlsx 都是自己解析 zip + XML，pdf 先走内置文本流抽取，抽不动再降级到 `pdftotext` / `pypdf`。

### 4.2 检得准

BM25 只解决「词对得上」，企业问答里真正难的是「词对得上但不是这段」。所以分数拆成四项显式加权，每一项都能单独调、单独看：

| 项 | 权重 | 解决的问题 |
|---|---|---|
| BM25 | 基础分 | 词频与稀有度 |
| 短语命中 | ×1.35 | 整句原文出现在段落里，最强信号 |
| 章节/标题命中 | ×1.20 / ×1.15 | 「住宿标准」这种问题要落在对应小节 |
| 命中词邻近度 | ×1.12 | 词散落在文首文尾 = 大概率不是同一件事 |
| 数字/英文硬词 | ×0.75~1.20 | 问「600 元」，命中「400 元」的段落必须掉下去 |

`POST /v1/search` 传 `"debug": true` 会把每一项的得分打出来：

```json
"score_detail": { "bm25": 11.19, "phrase": 0, "heading_cov": 1, "title_cov": 0.33, "proximity": 0.5, "hard_hit": 1 }
```

**检索精度有量化依据**，`node scripts/eval-retrieval.js` 会跑一份 14 篇文档 / 22 条人工标注问题的 A/B（纯 BM25 vs 加权版）：

| 指标 | 纯 BM25 | 加权版 |
|---|---|---|
| top-1 准确率 | 86.4% | **90.9%** |
| recall@3 | 100% | 100% |
| recall@5 | 100% | 100% |
| MRR | 0.932 | **0.955** |

说清楚一点：这个规模的语料上，纯词法检索的 recall@5 已经饱和，加成项的价值体现在**排序**（哪些排第一），不是「能不能找到」。剩下几个没排到第一的，其实是两篇文档都能回答（比如「客户资料能放个人网盘吗」——信息安全规范和备份规范都写了禁止），属于标注集本身的边界模糊。

另外**返回给用户的内容做了上下文扩展**：检索按小块算分（精度高），命中后自动补齐同一章节的前后相邻块（最多 1400 字），所以答出来的是完整的一段话，不是从中间截断的半句。

### 4.3 答得快

| 路径 | 耗时 | 说明 |
|---|---|---|
| FAQ 命中 | ~0ms | 不走检索，直接给标准答案 |
| 缓存命中 | 0~1ms | 同一问题重复问 |
| 检索 + 抽取答案 | 5~15ms | 首次提问 |

三层：

1. **FAQ 前置** —— 高频问题录成问答对，命中直接返回，连倒排都不查；
2. **结果缓存** —— 检索与问答结果都进 LRU（2000 条 / TTL 2~3 分钟），任何写操作（入库、删除、重建索引）触发 epoch 递增，旧缓存整体失效，不维护依赖图也不会返回过期结果；
3. **SQLite 调优** —— `cache_size=32MB`、`temp_store=MEMORY`、`mmap_size=256MB`，读多写少的场景随机读明显更快。

答案本身也从「多句拼成一段」改成了**要点列表 + 精确到条的引用**：

```
一线城市每晚不超过 600 元，二线城市每晚不超过 400 元，其他城市每晚不超过 300 元。 [1]
```

多句时输出编号列表，每条都能对上一条引用；引用里带 `file_id`，前端可以直接给「查看原件」的下载链接。

---

## 5. API 参考

机器可读契约见 [`docs/openapi.json`](docs/openapi.json)（OpenAPI 3.1，16 个接口），可直接导入 Postman / Apifox，或用来生成各语言 SDK。

统一约定：

- Base URL：`http://<host>:<port>`
- 认证：`Authorization: Bearer <API_KEY>` 或 `X-API-Key: <API_KEY>`
- 请求体：`application/json`
- 响应头带 `X-Request-Id`，出问题把它给到服务端排查
- 错误格式：`{"error":{"code":"...","message":"...","request_id":"..."}}`

### 4.1 检索

**`POST /v1/search`** — 返回原文片段，适合自己接大模型的系统

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `query` | string | 是 | 自然语言或关键词 |
| `space_id` | string | 否 | 限定知识空间 |
| `tags` | string[] | 否 | 按标签过滤（任一命中） |
| `top_k` | number | 否 | 默认 8，最大 50 |
| `min_score` | number | 否 | 绝对分数下限，默认 0.1 |

```json
{
  "query": "退款多久到账",
  "total": 2,
  "took_ms": 6,
  "query_terms": ["退款", "款多", "多久", "久到", "到账"],
  "hits": [
    {
      "chunk_id": "c_xxx",
      "doc_id": "d_xxx",
      "doc_title": "售后常见问题汇总",
      "heading": "退款多久能到账",
      "content": "审核通过后，原路退回一般 1 到 3 个工作日到账……",
      "score": 10.12,
      "relevance": 1,
      "coverage": 0.8,
      "space_name": "售后支持",
      "tags": ["售后", "退款"],
      "updated_at": "2026-11-19T07:18:18.090Z"
    }
  ]
}
```

- `relevance` 是相对最高分的比例（0~1），适合做展示排序；
- `coverage` 是查询词命中比例，适合判断"这条到底靠不靠谱"。

### 4.2 问答

**`POST /v1/ask`** — 返回带引用的答案，适合不想自建模型链路的系统

参数同上（`top_k`、`space_id`），另有 `min_faq_confidence`（默认 0.5）。

```json
{
  "query": "数据库锁等待怎么排查",
  "answer": "SQLite 在写入时会获取写锁……单次入库建议控制在 5 万字符以内。 [1]",
  "mode": "extractive",
  "citations": [
    { "index": 1, "doc_id": "d_xxx", "doc_title": "线上故障排查手册", "heading": "数据库锁等待", "updated_at": "..." }
  ],
  "confidence": 0.886,
  "took_ms": 8
}
```

`mode` 有四种取值，企业侧可以据此决定怎么展示：

| mode | 含义 | 建议处理 |
|---|---|---|
| `faq` | 命中标准问答条目 | 直接展示，可信度最高 |
| `llm` | 大模型基于检索结果生成 | 正常展示，保留引用 |
| `extractive` | 未配大模型，原文摘录 | 展示时标注"原文摘录" |
| `empty` | 知识库无相关内容 | **不要**让模型自行编答案，转为转人工或提示补充文档 |

> 关于 `extractive`：这是刻意的设计。宁可给原文摘录并标注，也不让系统在没有依据时"编一个像样的答案"。配上大模型后自动升级为 `llm`。

### 4.3 文档

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/v1/documents` | read | 列表，支持 `space_id`/`tag`/`q`/`limit`/`offset` |
| POST | `/v1/documents` | write | 入库（正文或 base64 文件） |
| GET | `/v1/documents/:id` | read | 详情，`?with_chunks=1` 返回切块 |
| DELETE | `/v1/documents/:id` | write | 删除并清理索引 |

入库请求体：

```json
{
  "title": "紫罗兰协议说明",
  "content": "# 紫罗兰协议说明\n\n## 协议目标\n…",
  "space": "产品文档",
  "tags": ["协议", "安全"],
  "source_uri": "https://wiki.example.com/violet",
  "visibility": "internal"
}
```

或者传文件：

```json
{ "filename": "手册.docx", "file_base64": "UEsDBBQ…", "space": "产品文档" }
```

**入库是幂等的**：同一个 `source_uri` 内容没变直接返回 `skipped`，内容变了自动升版本并重建索引。所以同步任务可以无脑全量重推。

`visibility: "restricted"` + `allowed_roles: ["finance"]` 可以让文档只在带对应 `roles` 的检索中返回。

### 4.4 FAQ

```bash
curl -X POST http://127.0.0.1:7300/v1/faqs \
  -H "Authorization: Bearer kb_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{"question":"怎么申请发票","answer":"订单详情页点击申请发票…","tags":["财务"]}'
```

高频问题沉淀成 FAQ 比纯文档检索更稳 —— 命中即返回标准答案，不受措辞影响。

### 4.5 空间与元信息

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/v1/meta` | 任意 | 实例信息 + 语料规模 + 能力清单 |
| GET | `/v1/spaces` | read | 空间列表及文档数 |
| POST | `/v1/spaces` | admin | 新建空间 |
| GET | `/v1/audit` | admin | 调用审计（谁在什么时候查了什么） |

### 4.6 管理接口（仅根密钥）

根密钥在 `config.json` 的 `rootKey` 字段，只给运维脚本和初始化用，**不发业务系统**。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/admin/instance` | 本实例概况：库路径、库大小、语料、成员、密钥、空间 |
| PATCH | `/v1/admin/instance` | 改企业名（`{"name":"示例科技有限公司"}`） |
| GET | `/v1/admin/keys` | 密钥列表 |
| POST | `/v1/admin/keys` | 签发新密钥，`name` 标注用途 |
| DELETE | `/v1/admin/keys/:id` | 吊销密钥（立即生效） |
| POST | `/v1/admin/reindex` | 重建索引（改了切分或分词逻辑后） |
| GET | `/v1/admin/stats` | 统计（含 `isolation: single-instance-database`） |
| POST | `/v1/admin/tenants` | **已下线**，返回 `410 gone` —— 单实例不再支持在线建企业 |
| GET | `/v1/admin/tenants` | 兼容保留，只回本实例一条 |

### 4.7 错误码

| 状态码 | code | 处理建议 |
|---|---|---|
| 400 | `bad_request` / `invalid_json` | 检查请求体 |
| 401 | `unauthorized` | 密钥无效、吊销、过期或本实例被停用 |
| 403 | `forbidden` | 密钥缺对应 scope |
| 404 | `not_found` | 资源不存在 |
| 413 | `payload_too_large` | 单次请求超过 32MB，改走目录导入 |
| 429 | `rate_limited` | 看 `Retry-After`，做指数退避 |
| 500 | `internal_error` | 用 `request_id` 查服务端日志 |

---

## 6. 企业侧对接

### 5.1 curl

```bash
curl -X POST https://kb.example.com/v1/ask \
  -H "Authorization: Bearer $KB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"如何申请开票"}'
```

### 5.2 Node.js

```js
const KB = process.env.KB_BASE_URL;
const KEY = process.env.KB_API_KEY;

async function kbAsk(query, spaceId) {
  const res = await fetch(`${KB}/v1/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ query, space_id: spaceId }),
  });
  if (res.status === 429) {
    const retry = Number(res.headers.get('Retry-After') || 2);
    await new Promise((r) => setTimeout(r, retry * 1000));
    return kbAsk(query, spaceId);
  }
  if (!res.ok) throw new Error(`KB ${res.status}: ${(await res.json()).error?.message}`);
  return res.json();
}
```

完整可运行版本见 `examples/node-client.js`。

### 5.3 Python

```python
import os, requests

def kb_ask(query, space_id=None):
    r = requests.post(
        f"{os.environ['KB_BASE_URL']}/v1/ask",
        headers={"Authorization": f"Bearer {os.environ['KB_API_KEY']}"},
        json={"query": query, "space_id": space_id},
        timeout=(3.05, 30),
    )
    r.raise_for_status()
    return r.json()
```

完整版本见 `examples/python_client.py`。

### 5.4 MCP 插件（AI Agent 直接挂载）

插件在 `mcp/server.js`，提供 6 个工具：

| 工具 | 用途 |
|---|---|
| `kb_ask` | 提问，返回带引用的答案（**优先用这个**） |
| `kb_search` | 检索原文片段 |
| `kb_list_spaces` | 列出知识空间 |
| `kb_list_documents` | 分页列文档 |
| `kb_get_document` | 读文档全文 |
| `kb_stats` | 查知识库规模 |

注册到 MCP 客户端（如 WorkBuddy / Claude Desktop / Cursor）：

```json
{
  "mcpServers": {
    "kb-hub": {
      "command": "node",
      "args": ["/绝对路径/kb-hub/mcp/server.js"],
      "env": {
        "KB_BASE_URL": "http://127.0.0.1:7300",
        "KB_API_KEY": "kb_live_xxx"
      }
    }
  }
}
```

两个环境变量：`KB_BASE_URL` 指向本企业的服务地址，`KB_API_KEY` 是本企业的密钥。插件只做薄封装，所有逻辑仍在服务端 —— 所以 REST 和 MCP 的检索结果永远一致。

---

## 7. 配置

`config.json` 首次启动自动生成：

```json
{
  "host": "127.0.0.1",
  "port": 7300,
  "dataDir": "data",
  "rootKey": "kb_root_xxx",
  "retrieval": {
    "topK": 8,
    "minScore": 0.1,
    "maxChunkChars": 700,
    "overlapChars": 80,
    "bm25K1": 1.2,
    "bm25B": 0.75,
    "titleBoost": 2,
    "relativeFloor": 0.1
  },
  "llm": { "baseUrl": "", "apiKey": "", "model": "" },
  "cors": "*",
  "defaultRateLimit": 120
}
```

关键项：

- **`maxChunkChars`** 块大小。条款类文档改小（400）提高精度，叙事类文档改大（1000）保留上下文。
- **`relativeFloor`** 相对分数下限。命中分低于「最高分 × 该值」直接丢弃，是压制长尾噪声的主要开关。调高更精准，调低更全。
- **`titleBoost`** 标题词权重倍数。标题写得规范时调高收益明显。
- **`llm`** 三项都填了才会启用生成式问答，否则走抽取式。

环境变量可覆盖：`KB_PORT`、`KB_HOST`、`KB_ROOT_KEY`、`KB_DATA_DIR`、`KB_LLM_BASE_URL`、`KB_LLM_API_KEY`、`KB_LLM_MODEL`。

### 启用大模型

任何 OpenAI 兼容接口都行：

```json
"llm": {
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-xxx",
  "model": "deepseek-chat"
}
```

配好后 `/v1/ask` 的 `mode` 变成 `llm`。模型返回失败会自动降级为 `extractive` 并在 `warning` 字段说明，不会 500。

---

## 8. 运维

```bash
# 备份：直接复制这两个文件即可，无需停服
cp data/kb.db data/kb.db-wal /backup/

# 增量同步（目录或在线文档，幂等，可重复跑；--tenant 可省，默认本实例）
node scripts/sync.js --from "D:/项目文档" --space 项目文档
node scripts/sync.js --url https://wiki.example.com/a.md --space 产品文档

# 重建索引（改了切分参数或分词逻辑后）
node cli.js reindex

# 看本实例规模与库位置
node cli.js tenant:list
node cli.js stats

# 吊销泄露的密钥
node cli.js key:revoke k_xxx
```

**接飞书 / 腾讯文档**：用平台能力把文档导出成 markdown（或拿到导出下载直链），再走 `--from` 目录同步或 `--url` 单篇同步。同步游标已落在 `sync_cursors` 表，后续要做增量对比时读这张表即可。

**定期维护建议**

| 动作 | 频率 | 命令 |
|---|---|---|
| 全量文档同步 | 每日 | `node cli.js add-dir <目录> --space 空间名` |
| 数据库备份 | 每日 | 复制 `data/kb.db*` |
| 过期文档检查 | 每季度 | `GET /v1/documents` 按 `updated_at` 排序 |
| 审计日志归档 | 每月 | 导出 `audit_logs` 后清理 90 天前记录 |

审计日志会持续增长，单表超过 100 万行时建议归档：

```sql
DELETE FROM audit_logs WHERE created_at < date('now','-90 day');
VACUUM;
```

---

## 9. 设计取舍

**为什么词法为主、向量为辅**

- 零依赖、毫秒级、结果可解释（能告诉用户"命中了哪几个词"）；
- 企业内部大量查询是术语精确匹配（系统名、错误码、产品代号），BM25 在这类场景反而优于向量；
- 调外部 embedding API 意味着数据出内网 + 按量计费，企业对接时这是个真实的阻力。所以向量用本地 `hash-256-v2` 生成，不联网、不花钱，代价是语义能力有限，只当补充通道。
- 两路分数按 **0.7 词法 + 0.3 向量** 融合，`/v1/search` 的 `channel` 字段会说明命中的是 `lexical` / `vector` / `hybrid`。

**代价**是纯同义改写的召回弱。所以补了两层：`data/synonyms.json` 做领域同义词归一（"限流/频率限制/流控"），以及 FAQ 层用「bigram 覆盖 + 单字包含」兜底。仍然解决不了的语义漂移，交给配了大模型后的生成式问答。

**为什么只做了一个极简控制台，而不是完整管理后台**

服务定位是"给系统对接的后端"。所以后台只保留一个 `/console` 单文件页面，解决「启动后总得有个地方能上传、能搜、能验证」这一个诉求；密钥轮换、批量导入、实例改名这些仍然走 API 或 CLI —— 这些操作频率低、需要审计、更适合脚本化，做成网页反而容易点错。真要完整后台，接低代码平台比自建划算。

**单机能撑多大**

SQLite + 倒排表，实测 10 万块（约 5000 万字）检索仍在 20ms 内。超过这个量级建议换 PostgreSQL + pgvector，`src/indexer.js` 是唯一需要替换的模块。

---

## 10. 已知限制

| 限制 | 说明 | 规避 |
|---|---|---|
| 扫描件抽不出文字 | 图片型 PDF / 纯截图 pptx 内置解析拿不到文本，会标 `parse_status=failed` | 原件已保存不会丢；补 OCR（如 `tesseract`）后重传，或上传可复制文本的版本 |
| PDF 中文可能乱码 | 内置解析不处理 CID 字体映射，中文 PDF 依赖 `pdftotext` / `pypdf` | `python -m pip install pypdf`；`/v1/meta` 的 `parse_failed` 会暴露这类文件 |
| 不支持旧版 .doc/.ppt/.xls | 老二进制格式无法解析 | 另存为 .docx/.pptx/.xlsx |
| 同义词表需人工维护 | 不会自动学习 | 从审计日志里捞"零结果查询"补充 |
| 单机单进程写 | SQLite 写锁 | 入库任务串行化，单文档控制在 5 万字符内 |
| 向量语义能力有限 | 本地 `hash-256-v2` 只做子串/字符级哈希，真正同义改写召回弱 | 靠同义词表 + FAQ 兜底；要强语义就换成调 embedding API（`src/vectors.js` 是唯一改动点） |
| 原始件不做容量治理 | `data/files` 只增不减，删除文档不回收文件 | 定期按 `doc_files` 引用关系清理孤儿文件（`src/storage.js` 已留入口） |

---

## 11. 后续可加

- **接真向量模型**：把 `src/vectors.js` 的 `hash-256-v2` 换成调 embedding API，融合权重与表结构都不用动。
- **飞书/腾讯文档同步**：用 `lark-cli` 导出 markdown 后走 `/v1/documents`，`sync_cursors` 表已预留游标字段。
- **文档级权限**：`visibility` + `allowed_roles` 已落地，可扩展成部门树。
- **查询改写**：用大模型把口语化问题改写成关键词再检索，能显著提升 `coverage`。
