#!/usr/bin/env node
// KB Hub · MCP Server
// 通过 stdio 与 AI 客户端通信，把外置知识库暴露成 tools。
// 注意：stdout 被 JSON-RPC 独占，所有日志必须走 stderr。

import readline from 'node:readline';

const VERSION = '0.2.0';
const BASE = (process.env.KB_BASE_URL || 'http://127.0.0.1:7300').replace(/\/+$/, '');
const KEY = process.env.KB_API_KEY || '';
// 这个 AI 客户端代表哪一级员工看知识库。只能压低密钥自身的 reader_level，不能抬高。
const LEVEL = Number(process.env.KB_LEVEL) || null;
// 是否把检索通道信息回给模型（默认不回，避免干扰；排查问题时设 KB_SHOW_RETRIEVAL=1）
const SHOW_RETRIEVAL = process.env.KB_SHOW_RETRIEVAL === '1';
const PROTOCOL = '2024-11-05';

const log = (...a) => console.error('[kb-mcp]', ...a);

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const m = data?.error?.message || `HTTP ${res.status}`;
    throw new Error(m);
  }
  return data;
}

// 请求级等级：工具参数优先，其次环境变量，都没给就不传（服务端按密钥等级）
function pickLevel(v) {
  const n = Number(v);
  if (Number.isFinite(n) && n >= 1 && n <= 5) return n;
  return LEVEL || undefined;
}

// ---------- 空间名解析：允许用户直接写「产品文档」「product」 ----------
let spaceCache = null;

async function resolveSpace(v) {
  if (!v) return null;
  const want = String(v).trim().toLowerCase();
  try {
    if (!spaceCache) {
      const r = await api('GET', '/v1/spaces');
      spaceCache = r.items || [];
    }
    const hit = spaceCache.find(
      (s) => s.id === v || String(s.slug).toLowerCase() === want || String(s.name).toLowerCase() === want,
    );
    if (hit) return hit.id;
  } catch {
    /* 解析失败就原样传给服务端 */
  }
  return v;
}

// ---------- 输出格式化 ----------
function chanLabel(r) {
  if (!r || !r.mode) return '';
  if (r.mode === 'hybrid') {
    const parts = [`词法 ${r.lexical_weight}`];
    if (r.vector_weight) parts.push(`向量 ${r.vector_weight}`);
    const model = r.vector_model ? ` · ${r.vector_model}` : '';
    return `混合检索（${parts.join(' + ')}${model}）`;
  }
  return '纯词法检索';
}

function levelNote(d) {
  const lv = d?.reader_level;
  if (lv == null) return '';
  return `数据等级：L${lv}${lv < 5 ? '（更高密级的资料已按权限过滤，不要臆测其内容）' : ''}`;
}

function fmtHits(hits, query, d) {
  if (!hits.length) return `没有在知识库中检索到与「${query}」相关的内容。`;
  const tail = [];
  if (SHOW_RETRIEVAL && d) {
    const c = chanLabel(d.retrieval);
    if (c) tail.push(c);
  }
  const ln = levelNote(d);
  if (ln) tail.push(ln);

  const body = hits
    .map((h, i) => {
      const where = h.heading ? ` / ${h.heading}` : '';
      const lv = Number(h.min_level) > 1 ? `  〔密级 L${h.min_level}〕` : '';
      return `[${i + 1}] 《${h.doc_title}》${where}${lv}  (相关度 ${h.relevance})\n${String(h.content).trim()}`;
    })
    .join('\n\n');

  return tail.length ? `${body}\n\n—— ${tail.join('　|　')}` : body;
}

function fmtAnswer(r) {
  const lines = [r.answer];
  if (r.mode === 'faq') lines.push('', '（命中知识库标准问答条目）');
  if (Array.isArray(r.citations) && r.citations.length) {
    lines.push('', '来源：');
    for (const c of r.citations) {
      const head = c.heading ? ` / ${c.heading}` : '';
      const when = c.updated_at ? `（更新于 ${String(c.updated_at).slice(0, 10)}）` : '';
      const lv = Number(c.min_level) > 1 ? `〔密级 L${c.min_level}〕` : '';
      lines.push(`${c.index}. 《${c.doc_title || c.title || ''}》${head}${when}${lv}`);
    }
  }
  if (r.mode === 'empty') lines.push('', '（知识库中未收录该问题，建议补充文档或联系负责人）');
  const ln = levelNote(r);
  if (ln) lines.push('', `—— ${ln}`);
  return lines.join('\n');
}

// ---------- 工具定义 ----------
const TOOLS = [
  {
    name: 'kb_search',
    description:
      '在企业外置知识库中检索原文片段。适合需要引用原文、或要自己组织答案的场景。返回带文档名与章节的片段列表。'
      + '结果已按调用方的数据等级过滤：密级更高的资料不会出现，缺失内容不要靠常识补。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索问题或关键词，用自然语言即可' },
        space: { type: 'string', description: '限定知识空间，可填名称或 slug，如「产品文档」' },
        top_k: { type: 'number', description: '返回条数，默认 5，最大 50' },
        tags: { type: 'array', items: { type: 'string' }, description: '按标签过滤' },
        level: { type: 'number', description: '以某一员工等级（1~5）检索，只能压低不能抬高，默认沿用密钥等级' },
      },
      required: ['query'],
    },
  },
  {
    name: 'kb_ask',
    description:
      '向企业知识库提问，直接获得带引用来源的答案。优先使用这个工具回答业务问题，答案会标注出自哪份文档。'
      + 'mode 为 empty 表示知识库没有依据，应当如实告知用户，不要编造。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要问的问题' },
        space: { type: 'string', description: '限定知识空间' },
        top_k: { type: 'number', description: '参考片段条数，默认 8' },
        level: { type: 'number', description: '以某一员工等级（1~5）提问，只能压低不能抬高' },
      },
      required: ['query'],
    },
  },
  {
    name: 'kb_list_spaces',
    description: '列出知识库的所有知识空间及各自文档数量，用于确认有哪些可查范围。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'kb_list_documents',
    description: '分页列出知识库中的文档，可按空间或标题关键词过滤。只返回调用方有权看到的文档。',
    inputSchema: {
      type: 'object',
      properties: {
        space: { type: 'string', description: '限定知识空间' },
        keyword: { type: 'string', description: '标题关键词' },
        limit: { type: 'number', description: '返回条数，默认 20' },
        offset: { type: 'number', description: '偏移量，默认 0' },
        level: { type: 'number', description: '以某一员工等级（1~5）列出，只能压低不能抬高' },
      },
    },
  },
  {
    name: 'kb_get_document',
    description: '读取指定文档的正文。默认返回按章节切分的段落，便于定位具体内容。',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', description: '文档 ID（可从 kb_list_documents 获取）' },
        with_chunks: { type: 'boolean', description: '是否返回切分后的段落，默认 true' },
        level: { type: 'number', description: '以某一员工等级（1~5）读取，只能压低不能抬高' },
      },
      required: ['doc_id'],
    },
  },
  {
    name: 'kb_stats',
    description: '查看当前知识库规模（文档数、段落数、向量数、空间分布）与自身数据权限，用于判断是否有内容可查。',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ---------- 工具实现 ----------
async function dispatch(name, args) {
  switch (name) {
    case 'kb_search': {
      const spaceId = await resolveSpace(args.space);
      const r = await api('POST', '/v1/search', {
        query: args.query,
        space_id: spaceId || undefined,
        top_k: args.top_k || 5,
        tags: args.tags || undefined,
        level: pickLevel(args.level),
      });
      return fmtHits(r.hits, r.query || args.query, r);
    }

    case 'kb_ask': {
      const spaceId = await resolveSpace(args.space);
      const r = await api('POST', '/v1/ask', {
        query: args.query,
        space_id: spaceId || undefined,
        top_k: args.top_k || undefined,
        level: pickLevel(args.level),
      });
      return fmtAnswer(r);
    }

    case 'kb_list_spaces': {
      const r = await api('GET', '/v1/spaces');
      const items = r.items || [];
      if (!items.length) return '知识库还没有任何知识空间。';
      return items.map((s) => `- ${s.name}（slug: ${s.slug}，${s.doc_count} 篇文档）`).join('\n');
    }

    case 'kb_list_documents': {
      const spaceId = await resolveSpace(args.space);
      const p = new URLSearchParams();
      if (spaceId) p.set('space_id', spaceId);
      if (args.keyword) p.set('q', args.keyword);
      p.set('limit', String(args.limit || 20));
      p.set('offset', String(args.offset || 0));
      const lv = pickLevel(args.level);
      if (lv) p.set('level', String(lv));
      const r = await api('GET', `/v1/documents?${p.toString()}`);
      if (!r.items?.length) return '没有匹配的文档。';
      const lines = r.items.map((d) => {
        const lvt = Number(d.min_level) > 1 ? `，密级 L${d.min_level}` : '';
        const parsed = d.parse_status === 'failed' ? '，正文抽取失败（原件仍可下载）' : '';
        return `- ${d.title}（${d.chunk_count} 段${lvt}${parsed}，更新于 ${String(d.updated_at).slice(0, 10)}）id: ${d.id}`;
      });
      return `共 ${r.total} 篇：\n${lines.join('\n')}`;
    }

    case 'kb_get_document': {
      const withChunks = args.with_chunks !== false;
      const q = new URLSearchParams({ with_chunks: withChunks ? '1' : '0' });
      const lv = pickLevel(args.level);
      if (lv) q.set('level', String(lv));
      const d = await api('GET', `/v1/documents/${encodeURIComponent(args.doc_id)}?${q.toString()}`);
      const lvt = Number(d.min_level) > 1 ? `，密级 L${d.min_level}` : '';
      const head = `# ${d.title}\n（类型 ${d.doc_type}，${d.chunk_count} 段${lvt}，更新于 ${String(d.updated_at).slice(0, 10)}）\n`;
      if (!withChunks || !d.chunks?.length) return head;
      return head + d.chunks.map((c) => `\n## ${c.heading || '正文'}\n${c.content}`).join('\n');
    }

    case 'kb_stats': {
      const m = await api('GET', '/v1/meta');
      const c = m.corpus || {};
      const v = c.vectors || {};
      const lines = [
        `实例：${m.capabilities?.instance?.name || m.tenant?.name || '-'}（id ${m.capabilities?.instance?.id || m.tenant?.id || '-'}，${m.capabilities?.isolation || 'single-instance-database'}）`,
        `文档 ${c.documents} 篇，段落 ${c.chunks} 段，FAQ ${c.faqs} 条`,
        `向量 ${v.chunks ?? 0} 块${v.model ? `（模型 ${v.model}，${v.dim} 维）` : '（尚未建立）'}`,
        `可读等级 L${m.reader_level ?? 5}${(m.reader_level ?? 5) < 5 ? '，更高密级内容不可见' : ''}`,
        `检索通道：${chanLabel({ mode: 'hybrid', lexical_weight: 0.7, vector_weight: 0.3 }) || '混合检索'}`,
        `问答模式：${m.capabilities?.answer_mode === 'llm' ? '大模型生成' : '原文摘录'}`,
        `空间：${(m.spaces || []).map((s) => `${s.name}(${s.doc_count})`).join('、') || '无'}`,
      ];
      if (c.parse_failed > 0) lines.push(`注意：${c.parse_failed} 篇文档正文抽取失败，原件仍可下载`);
      return lines.join('\n');
    }

    default:
      throw new Error(`未知工具: ${name}`);
  }
}

// ---------- JSON-RPC ----------
function write(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function reply(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'kb-hub', version: VERSION },
    });
    return;
  }

  if (method === 'notifications/initialized' || method === 'initialized') return;

  if (method === 'ping') {
    reply(id, {});
    return;
  }

  if (method === 'tools/list') {
    reply(id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      const text = await dispatch(name, args);
      reply(id, { content: [{ type: 'text', text }], isError: false });
    } catch (e) {
      reply(id, { content: [{ type: 'text', text: `知识库调用失败：${e.message}` }], isError: true });
    }
    return;
  }

  if (id != null) {
    replyError(id, -32601, `未实现的方法: ${method}`);
  }
}

// 串行处理，避免响应乱序
let chain = Promise.resolve();

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  chain = chain.then(async () => {
    let msg;
    try {
      msg = JSON.parse(t);
    } catch {
      log('收到非法 JSON，已忽略');
      return;
    }
    try {
      await handle(msg);
    } catch (e) {
      log('处理失败:', e.message);
      if (msg.id != null) replyError(msg.id, -32603, e.message);
    }
  });
});

rl.on('close', async () => {
  // 等队列里未完成的调用处理完再退出，避免管道场景丢响应
  try {
    await chain;
  } catch {
    /* ignore */
  }
  process.exit(0);
});

log(`已启动，目标 ${BASE}${KEY ? '' : '（未配置 KB_API_KEY，调用会被拒绝）'}${LEVEL ? `，数据等级上限 L${LEVEL}` : ''}`);
