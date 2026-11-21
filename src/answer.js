import { search, matchFaqs } from './indexer.js';
import { tokenize, splitSentences } from './tokenize.js';
import { config, llmEnabled } from './config.js';
import { bumpFaqHit } from './store.js';
import { askCache, cacheKey } from './cache.js';
import { instanceId } from './db.js';

const EXTRACT_MAX_CHARS = 480;
const MAX_POINTS = 4;

function overlapScore(sentence, qTerms) {
  const s = tokenize(sentence);
  let hit = 0;
  let weight = 0;
  for (const [t, n] of qTerms) {
    if (s.has(t)) {
      hit += 1;
      weight += n;
    }
  }
  return hit ? weight + hit * 0.5 : 0;
}

/** 块首行如果是章节标题就去掉，避免「如何申请开发票在订单详情页…」这种粘连 */
function stripLeafHeading(hit) {
  let content = String(hit.content || '');
  const leaf = (hit.heading || '').split(' > ').pop();
  const firstLine = content.split('\n')[0].trim();
  if (leaf && firstLine === leaf) {
    content = content.split('\n').slice(1).join('\n').trim() || content;
  }
  return content;
}

/** 两条要点是否在说同一件事（词集 Jaccard） */
function tooSimilar(a, b) {
  const A = new Set(tokenize(a).keys());
  const B = new Set(tokenize(b).keys());
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  const union = A.size + B.size - inter;
  return union > 0 && inter / union > 0.7;
}

/**
 * 抽取式回答：只从原文挑句子，不做任何改写，因此不会编造。
 *
 * 输出改成要点列表而不是一整段 —— 原来多句直接拼接，
 * 读起来像「机器把三句话糊在一起」，要点化之后每句都能对上一条引用。
 */
function extractAnswer(query, hits) {
  const qTerms = tokenize(query);
  const topScore = hits[0]?.score || 1;
  const points = [];

  for (const h of hits.slice(0, 4)) {
    // 与最佳命中差距过大的块直接丢弃，避免把无关章节拼进答案
    if (h.score < topScore * 0.3) continue;
    if (points.length >= MAX_POINTS) break;

    const content = stripLeafHeading(h);
    const sentences = splitSentences(content).filter((s) => s.length > 6);
    if (!sentences.length) continue;

    const scored = sentences.map((s, i) => ({ s, i, sc: overlapScore(s, qTerms) }));
    const best = Math.max(0, ...scored.map((x) => x.sc));
    if (best <= 0) continue;

    // 每块最多取两句，且必须与最佳句分数接近，防止把闲聊句带进来
    const keep = scored
      .filter((x) => x.sc > 0 && x.sc >= best * 0.6)
      .slice(0, 2);

    for (const k of keep) {
      if (points.length >= MAX_POINTS) break;
      if (points.some((p) => tooSimilar(p.text, k.s))) continue;
      points.push({ text: k.s.trim(), hit: h });
    }
  }

  if (!points.length) {
    const h = hits[0];
    points.push({ text: stripLeafHeading(h).slice(0, EXTRACT_MAX_CHARS), hit: h });
  }

  // 引用去重：多个要点来自同一块时，只保留一个引用编号
  const citeIndex = new Map();
  const used = [];
  const lines = [];
  let total = 0;

  for (const p of points) {
    if (total && total + p.text.length > EXTRACT_MAX_CHARS) break;
    let idx = citeIndex.get(p.hit.chunk_id);
    if (idx == null) {
      used.push(p.hit);
      idx = used.length;
      citeIndex.set(p.hit.chunk_id, idx);
    }
    const line = p.text.replace(/\s*\n\s*/g, ' ').trim();
    lines.push(line + ` [${idx}]`);
    total += line.length;
  }

  const answer = lines.length === 1
    ? lines[0]
    : lines.map((l, i) => `${i + 1}. ${l}`).join('\n');

  return { answer, used };
}

function buildCitations(hits) {
  return hits.map((h, i) => ({
    index: i + 1,
    doc_id: h.doc_id,
    doc_title: h.doc_title,
    heading: h.heading || '',
    chunk_id: h.chunk_id,
    space_id: h.space_id,
    space_name: h.space_name,
    source_uri: h.source_uri,
    updated_at: h.updated_at,
    uploader: h.uploader || null,
    file_id: h.file_id || null,
    score: h.score,
    snippet: String(h.content || '').slice(0, 200),
  }));
}

/**
 * 置信度 = 查询词覆盖度（0.6）+ top1 与 top2 的分离度（0.4）
 *
 * 不用「最高分」是因为它永远被归一成 1，没有信息量。
 * 覆盖度低说明只命中零散词；分离度低说明两条候选分数接近、系统自己也拿不准 ——
 * 这两种情况都该让置信度掉下来，前端才好决定要不要提示「仅供参考」。
 */
function calibrate(hits) {
  if (!hits.length) return 0;
  const cov = hits[0].coverage || 0;
  const margin = hits.length > 1 ? Math.max(0, 1 - hits[1].score / (hits[0].score || 1)) : 1;
  return Number(Math.min(1, 0.6 * cov + 0.4 * margin).toFixed(3));
}

async function callLlm(query, hits) {
  const ctx = hits
    .slice(0, 6)
    .map((h, i) => `[${i + 1}] 《${h.doc_title}》${h.heading ? ' / ' + h.heading : ''}\n${h.content}`)
    .join('\n\n');

  const system = [
    '你是企业知识库问答助手。只能依据下面提供的资料回答问题。',
    '资料中没有的信息一律回答「根据现有知识库无法确认」，严禁使用资料之外的知识或臆测。',
    '回答要简洁、可执行；引用资料时在句末标注 [1]、[2] 这样的编号。',
    '用简体中文回答。',
  ].join('');

  const body = {
    model: config.llm.model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `资料：\n${ctx}\n\n问题：${query}` },
    ],
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.llm.timeoutMs);
  try {
    const url = `${config.llm.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`LLM 接口 ${res.status}: ${txt.slice(0, 200)}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('LLM 返回内容为空');
    return String(text).trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 统一问答入口
 * @returns {Promise<{answer:string, mode:string, citations:Array, confidence:number, took_ms:number}>}
 */
export async function ask({ tenantId, query, spaceId = null, topK, roles = [], minLevel = 1, queryVec = null, minConfidence = 0.5 }) {
  tenantId = instanceId();
  const t0 = Date.now();
  const q = String(query || '').trim();
  if (!q) throw new Error('query 不能为空');
  const level = Math.max(1, Math.min(5, Number(minLevel) || 1));

  const key = cacheKey(['a', tenantId, q, spaceId, topK, roles.join(','), level, minConfidence]);
  const cached = askCache.get(key);
  if (cached) return { ...cached, cached: true, took_ms: Date.now() - t0 };

  // 1) FAQ 命中：直接给标准答案，这是最快路径（不走检索）
  const faqs = matchFaqs(tenantId, q, { spaceId, topK: 3, minLevel: level });
  const bestFaq = faqs[0];
  if (bestFaq && bestFaq.coverage >= minConfidence) {
    bumpFaqHit(tenantId, [bestFaq.id]);
    return {
      answer: bestFaq.answer,
      mode: 'faq',
      citations: [{ index: 1, type: 'faq', faq_id: bestFaq.id, title: bestFaq.question, snippet: bestFaq.answer }],
      confidence: bestFaq.coverage,
      related_faqs: faqs.slice(1),
      took_ms: Date.now() - t0,
      cached: false,
    };
  }

  // 2) 文档检索（问答场景开启上下文扩展，答案能读到完整的前因后果）
  const t1 = Date.now();
  const res = search(tenantId, {
    query: q, spaceId, topK: topK || config.retrieval.topK, roles, minLevel: level,
    queryVec, expand: true,
  });
  const hits = res.hits;
  const retrievalMs = Date.now() - t1;

  if (!hits.length) {
    return {
      answer: '根据现有知识库无法确认该问题。建议补充相关文档，或联系知识库负责人。',
      mode: 'empty',
      citations: [],
      confidence: 0,
      took_ms: Date.now() - t0,
      timings: { retrieval_ms: retrievalMs },
      query_terms: res.query_terms,
      cached: false,
    };
  }

  const confidence = calibrate(hits);

  // 3) 有 LLM 走生成式，否则抽取式
  if (llmEnabled()) {
    try {
      const text = await callLlm(q, hits);
      const out = {
        answer: text,
        mode: 'llm',
        model: config.llm.model,
        citations: buildCitations(hits),
        confidence,
        took_ms: Date.now() - t0,
        timings: { retrieval_ms: retrievalMs },
      };
      askCache.set(key, out);
      return { ...out, cached: false };
    } catch (e) {
      const fb = extractAnswer(q, hits);
      return {
        answer: fb.answer,
        mode: 'extractive',
        citations: buildCitations(fb.used),
        confidence,
        took_ms: Date.now() - t0,
        timings: { retrieval_ms: retrievalMs },
        warning: `大模型生成失败已降级为原文摘录：${e.message}`,
        cached: false,
      };
    }
  }

  const ex = extractAnswer(q, hits);
  const out = {
    answer: ex.answer,
    mode: 'extractive',
    citations: buildCitations(ex.used),
    confidence,
    took_ms: Date.now() - t0,
    timings: { retrieval_ms: retrievalMs },
    disclaimer: '当前未配置大模型，回答为知识库原文摘录，未做改写。',
  };
  askCache.set(key, out);
  return { ...out, cached: false };
}
