import { tdb, ttx } from './tenant-db.js';
import { instanceId } from './db.js';
import { tokenize, normalize } from './tokenize.js';
import { config } from './config.js';
import { searchCache, cacheKey } from './cache.js';
import { embedSync, currentModel } from './embed.js';
import { vectorSearch, hasVectors } from './vectors.js';

const MAX_QUERY_TERMS = 24;
const EN_STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with',
  'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'this', 'that', 'these', 'those', 'it', 'its', 'we', 'you', 'they',
]);

/** 重建租户语料统计（BM25 的 N 与 avgdl） */
export function refreshStats(tenantId) {
  tenantId = instanceId();
  const d = tdb(tenantId);
  const row = d.get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(n_terms), 0) AS t FROM chunks WHERE tenant_id = ?`,
    tenantId,
  );
  const n = Number(row?.n || 0);
  const t = Number(row?.t || 0);
  d.run(
    `INSERT INTO corpus_stats(tenant_id, n_chunks, total_terms) VALUES(?,?,?)
     ON CONFLICT(tenant_id) DO UPDATE SET n_chunks = excluded.n_chunks, total_terms = excluded.total_terms`,
    tenantId, n, t,
  );
  return { n_chunks: n, total_terms: t, avg_len: n ? t / n : 0 };
}

export function getStats(tenantId) {
  tenantId = instanceId();
  const row = tdb(tenantId).get(`SELECT n_chunks, total_terms FROM corpus_stats WHERE tenant_id = ?`, tenantId);
  const n = Number(row?.n_chunks || 0);
  const t = Number(row?.total_terms || 0);
  return { n_chunks: n, total_terms: t, avg_len: n ? t / n : 0 };
}

/**
 * 为已写入 chunks 表的块建立倒排索引。
 * 标题与章节路径额外计入词频 —— 这是「问章节名能定位到该章节」的基础。
 */
export function indexChunks(tenantId, chunks) {
  tenantId = instanceId();
  if (!chunks.length) return 0;
  const d = tdb(tenantId);
  const boost = Math.max(1, Number(config.retrieval.titleBoost) || 1);
  const extra = boost - 1;
  const insert = d.prepare(
    `INSERT INTO terms(tenant_id, term, chunk_id, tf) VALUES(?,?,?,?)
     ON CONFLICT(tenant_id, term, chunk_id) DO UPDATE SET tf = excluded.tf`,
  );
  const setLen = d.prepare(`UPDATE chunks SET n_terms = ? WHERE id = ?`);

  ttx(tenantId, () => {
    for (const c of chunks) {
      const tfMap = tokenize(c.content);
      if (c.title && extra > 0) {
        for (const [t, n] of tokenize(c.title)) {
          tfMap.set(t, (tfMap.get(t) || 0) + n * extra);
        }
      }
      if (c.heading) {
        for (const [t, n] of tokenize(c.heading)) {
          tfMap.set(t, (tfMap.get(t) || 0) + n);
        }
      }
      let total = 0;
      for (const [term, tf] of tfMap) {
        insert.run(tenantId, term, c.id, tf);
        total += tf;
      }
      setLen.run(total, c.id);
    }
  });

  refreshStats(tenantId);
  return chunks.length;
}

/** 删除某文档的全部索引（更新 / 删除时调用） */
export function removeDocIndex(tenantId, docId) {
  tenantId = instanceId();
  const d = tdb(tenantId);
  ttx(tenantId, () => {
    d.run(
      `DELETE FROM terms WHERE chunk_id IN (SELECT id FROM chunks WHERE doc_id = ?)`,
      docId,
    );
    d.run(`DELETE FROM chunks WHERE doc_id = ?`, docId);
  });
  refreshStats(tenantId);
}

function placeholders(n) {
  return new Array(n).fill('?').join(',');
}

/**
 * 硬词：数字、英文标识符、版本号。
 * 这些词在检索里是「要么对要么错」的，不能靠 bigram 模糊匹配糊过去 ——
 * 问「600 元标准」的时候，命中「400 元」的段落必须掉下去。
 */
function extractHardTokens(query) {
  const s = normalize(query);
  const out = new Set();
  for (const m of s.matchAll(/[a-z][a-z0-9_+#'.-]*|\d+(?:\.\d+)*/g)) {
    const t = m[0].replace(/[.'-]+$/, '');
    if (t.length < 2 && !/^\d+$/.test(t)) continue;
    if (EN_STOP.has(t)) continue;
    out.add(t);
  }
  return [...out].slice(0, 8);
}

/** 命中词在正文里的聚集程度：同一句话里出现 vs 散落在文首文尾 */
function proximityScore(contentNorm, terms, qLen) {
  let min = Infinity;
  let max = -1;
  let found = 0;
  for (const t of terms) {
    const i = contentNorm.indexOf(t);
    if (i < 0) continue;
    found += 1;
    if (i < min) min = i;
    if (i > max) max = i;
  }
  if (found < 2) return 0;
  const span = max - min;
  const ideal = Math.max(16, qLen * 2);
  if (span <= ideal) return 1;
  if (span <= ideal * 3) return 0.5;
  return 0;
}

/**
 * 字段命中数。
 * 早期版本用「命中词 / 全部查询词」做覆盖率，问题是被长问题稀释：
 * 问「VPN 令牌过期了怎么办」有 7 个 bigram，标题里只命中 vpn 一个，
 * 得分 1/7 ≈ 0.14，等于没加成。改成按命中个数饱和计数：
 * 标题命中 2 个词就算满，命中 1 个也有半分。
 */
function fieldHits(fieldNorm, terms) {
  if (!fieldNorm || !terms.length) return 0;
  let hit = 0;
  for (const t of terms) if (fieldNorm.includes(t)) hit += 1;
  return hit;
}

/**
 * 混合检索：BM25（词法）+ 向量（语义），两路候选合并后统一排序。
 *
 * 分数构成：
 *   lexical    BM25 × 短语 × 字段 × 邻近 × 硬词  —— 精确匹配的质量
 *   vector     查询向量与块向量的余弦          —— 换个说法也能召回
 *   final      = 0.7·(lexical/最高分) + 0.3·cos   （权重可配）
 *
 * 这样向量只负责「补召回」和「在词法接近时微调顺序」，
 * 不会因为一个语义近似但内容错的块把精确匹配顶掉 ——
 * 企业问答场景里，答错比答不出代价高得多。
 */
export function search(tenantId, opts) {
  tenantId = instanceId();
  const t0 = Date.now();
  const topK = Math.min(50, Math.max(1, Number(opts.topK) || config.retrieval.topK));
  const minScore = Number.isFinite(Number(opts.minScore)) ? Number(opts.minScore) : config.retrieval.minScore;
  const wantTags = (opts.tags || []).map((t) => String(t).toLowerCase());
  const roles = opts.roles || [];
  const minLevel = Math.max(1, Math.min(5, Number(opts.minLevel) || 1));
  const debug = Boolean(opts.debug);
  const expand = opts.expand !== false;
  // plain=true 退化成纯 BM25，用于评测里做加成项的 A/B 对照
  const plain = Boolean(opts.plain);
  const useVector = !plain && opts.vector !== false;

  const queryText = String(opts.query || '');

  const key = cacheKey([
    's', tenantId, queryText, opts.spaceId, wantTags.join(','), roles.join(','),
    minLevel, topK, minScore, expand ? 1 : 0, plain ? 1 : 0, useVector ? 1 : 0,
  ]);
  if (!debug) {
    const cached = searchCache.get(key);
    if (cached) return { ...cached, cached: true, took_ms: Date.now() - t0 };
  }

  const d = tdb(tenantId);
  const stats = getStats(tenantId);
  const N = stats.n_chunks;
  const avgdl = stats.avg_len || 1;

  const qmap = tokenize(queryText);
  const vecActive = useVector && N > 0 && hasVectors(tenantId);
  const qvec = vecActive ? (opts.queryVec || embedSync(queryText)) : null;

  if (!qmap.size && !vecActive) {
    return {
      hits: [], total: 0, took_ms: Date.now() - t0,
      query_terms: [...qmap.keys()], total_chunks: N, cached: false,
      retrieval: { mode: 'lexical', lexical_weight: 1, vector_weight: 0, vector_model: null, vector_candidates: 0 },
    };
  }

  const qTerms = [...qmap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_QUERY_TERMS)
    .map((x) => x[0]);

  const acc = new Map();
  if (qTerms.length) {
    const ph = placeholders(qTerms.length);
    const dfRows = d.all(
      `SELECT term, COUNT(*) AS df FROM terms WHERE tenant_id = ? AND term IN (${ph}) GROUP BY term`,
      tenantId, ...qTerms,
    );
    const df = new Map(dfRows.map((r) => [r.term, Number(r.df)]));

    const spaceFilter = opts.spaceId ? ' AND c.space_id = ?' : '';
    const postArgs = [tenantId, ...qTerms];
    if (opts.spaceId) postArgs.push(opts.spaceId);
    const rows = d.all(
      `SELECT t.term, t.chunk_id, t.tf, c.n_terms AS dl
       FROM terms t JOIN chunks c ON c.id = t.chunk_id
       WHERE t.tenant_id = ? AND t.term IN (${ph})${spaceFilter}`,
      ...postArgs,
    );

    const k1 = config.retrieval.bm25K1;
    const b = config.retrieval.bm25B;

    for (const r of rows) {
      const termDf = df.get(r.term) || 0;
      if (!termDf) continue;
      const idf = Math.log(1 + (N - termDf + 0.5) / (termDf + 0.5));
      if (idf <= 0) continue;
      const dl = Number(r.dl) || avgdl;
      const tf = Number(r.tf);
      const denom = tf + k1 * (1 - b + (b * dl) / avgdl);
      const s = (idf * (tf * (k1 + 1))) / (denom || 1);
      let e = acc.get(r.chunk_id);
      if (!e) {
        e = { bm25: 0, matched: new Set() };
        acc.set(r.chunk_id, e);
      }
      e.bm25 += s;
      e.matched.add(r.term);
    }
  }

  // ---- 向量路：单独一批候选，和 BM25 候选取并集 ----
  const vecScores = new Map();
  let vectorScanned = 0;
  if (vecActive) {
    const vres = vectorSearch(tenantId, qvec, {
      topK: Math.max(topK * 6, 40),
      spaceId: opts.spaceId || null,
      minCos: config.retrieval.minCosine,
    });
    vectorScanned = vres.length;
    for (const v of vres) vecScores.set(v.chunk_id, v.cos);
  }

  if (!acc.size && !vecScores.size) {
    const empty = {
      hits: [], total: 0, took_ms: Date.now() - t0, query_terms: qTerms, total_chunks: N, cached: false,
      retrieval: {
        mode: vecActive ? 'hybrid' : 'lexical',
        lexical_weight: config.retrieval.lexicalWeight,
        vector_weight: vecActive ? config.retrieval.vectorWeight : 0,
        vector_model: vecActive ? currentModel().model : null,
        vector_candidates: 0,
      },
    };
    if (!debug) searchCache.set(key, empty);
    return empty;
  }

  // 候选池：词法前 topK*8 + 向量前 topK*6
  const lexCandidates = [...acc.entries()]
    .sort((a, b2) => b2[1].bm25 - a[1].bm25)
    .slice(0, topK * 8)
    .map((x) => x[0]);
  const candidateIds = [...new Set([...lexCandidates, ...vecScores.keys()])];

  const detailRows = d.all(
    `SELECT c.id, c.doc_id, c.seq, c.heading, c.content, c.space_id,
            d.title, d.tags, d.visibility, d.allowed_roles, d.status, d.updated_at,
            d.doc_type, d.source_uri, d.uploader, d.file_id, d.parse_status,
            d.original_name, d.min_level, s.name AS space_name
     FROM chunks c
     JOIN documents d ON d.id = c.doc_id
     LEFT JOIN spaces s ON s.id = c.space_id
     WHERE c.id IN (${placeholders(candidateIds.length)})`,
    ...candidateIds,
  );
  const detail = new Map(detailRows.map((r) => [r.id, r]));

  const qNorm = normalize(queryText);
  const hardTokens = extractHardTokens(queryText);
  const qSize = qTerms.length;
  const maxLex = Math.max(0, ...[...acc.values()].map((e) => e.bm25));

  const scored = [];
  for (const id of candidateIds) {
    const row = detail.get(id);
    if (!row) continue;
    if (row.status !== 'active') continue;

    // 员工等级门槛：低于文档要求等级的账号，连块都拿不到 ——
    // 这是在 SQL 取回之后、返回之前做的最硬一道过滤
    if (Number(row.min_level) > minLevel) continue;

    const docTags = jsonParse(row.tags, []).map((t) => String(t).toLowerCase());
    if (wantTags.length && !wantTags.some((t) => docTags.includes(t))) continue;

    if (row.visibility === 'restricted') {
      const allowed = jsonParse(row.allowed_roles, []);
      if (!roles.some((role) => allowed.includes(role))) continue;
    }

    const e = acc.get(id) || { bm25: 0, matched: new Set() };
    const contentNorm = normalize(row.content);
    const phrase = qNorm.length >= 2 && contentNorm.includes(qNorm) ? 1 : 0;
    const headingCov = Math.min(1, fieldHits(normalize(row.heading || ''), qTerms) / 2);
    const titleCov = Math.min(1, fieldHits(normalize(row.title || ''), qTerms) / 3);
    const prox = proximityScore(contentNorm, qTerms, qNorm.length);
    const hardHit = hardTokens.length
      ? hardTokens.filter((t) => contentNorm.includes(t)).length / hardTokens.length
      : null;

    let lexical = e.bm25;
    if (!plain) {
      lexical *= 1 + 0.35 * phrase;
      lexical *= 1 + 0.20 * headingCov + 0.15 * titleCov;
      // 邻近度只是弱先验：给太高会把 BM25 的正确判断翻掉，0.12 是实测的平衡点
      lexical *= 1 + 0.12 * prox;
      // 硬词：全中 ×1.2，全不中 ×0.75 —— 数字对不上基本就是别的内容
      if (hardHit != null) lexical *= 0.75 + 0.45 * hardHit;
    }

    const cos = Math.max(0, vecScores.get(id) || 0);
    // 噪声门限：余弦太低的相似度没有语义意义（哈希向量尤其明显），
    // 直接当 0 处理，避免它在词法接近的候选之间随机改顺序。
    const cosEff = cos >= 0.25 ? cos : 0;
    const lexNorm = maxLex > 0 ? lexical / maxLex : 0;
    const wL = config.retrieval.lexicalWeight;
    const wV = config.retrieval.vectorWeight;
    const score = vecActive
      ? wL * lexNorm + wV * cosEff
      : lexNorm;

    scored.push({
      id,
      score,
      coverage: qSize ? e.matched.size / qSize : 0,
      detail: {
        bm25: Number(e.bm25.toFixed(3)),
        phrase,
        heading_cov: Number(headingCov.toFixed(2)),
        title_cov: Number(titleCov.toFixed(2)),
        proximity: prox,
        hard_hit: hardHit == null ? null : Number(hardHit.toFixed(2)),
        lexical_norm: Number(lexNorm.toFixed(3)),
        vector_cos: Number(cos.toFixed(3)),
        min_level: Number(row.min_level) || 1,
      },
      row,
      docTags,
    });
  }

  scored.sort((a, b2) => b2.score - a.score);
  const maxScore = scored[0]?.score || 1;
  const floor = maxScore * (config.retrieval.relativeFloor ?? 0.1);

  const hits = [];
  let rescued = 0;
  for (const r of scored) {
    // 语义救援：词法完全没命中、但向量相似度足够高的块，给最多 2 个名额。
    // 这是「换个说法就搜不到」的唯一解 —— 但它必须靠真实 embedding 模型才有质量，
    // 内置哈希向量只覆盖字面近似的场景，所以门槛设得保守（0.28）。
    const vecOnly = r.detail.bm25 === 0;
    const strongVec = vecOnly && r.detail.vector_cos >= 0.45 && rescued < 2;
    if (strongVec) {
      rescued += 1;
    } else {
      if (r.score < minScore) continue;
      if (r.score < floor) continue;
    }
    const row = r.row;
    const hit = {
      chunk_id: r.id,
      doc_id: row.doc_id,
      doc_title: row.title,
      heading: row.heading || '',
      content: row.content,
      score: Number(r.score.toFixed(4)),
      relevance: Number((r.score / maxScore).toFixed(4)),
      coverage: Number(r.coverage.toFixed(3)),
      space_id: row.space_id,
      space_name: row.space_name || '',
      tags: r.docTags,
      doc_type: row.doc_type,
      source_uri: row.source_uri,
      updated_at: row.updated_at,
      uploader: row.uploader || null,
      file_id: row.file_id || null,
      parse_status: row.parse_status || 'ok',
      min_level: Number(row.min_level) || 1,
      seq: row.seq,
    };
    if (debug) hit.score_detail = r.detail;
    hits.push(hit);
    if (hits.length >= topK) break;
  }

  if (expand) expandHits(tenantId, hits);

  const out = {
    hits,
    total: hits.length,
    took_ms: Date.now() - t0,
    query_terms: qTerms,
    total_chunks: N,
    retrieval: {
      mode: vecActive ? 'hybrid' : 'lexical',
      lexical_weight: vecActive ? config.retrieval.lexicalWeight : 1,
      vector_weight: vecActive ? config.retrieval.vectorWeight : 0,
      vector_model: vecActive ? currentModel().model : null,
      vector_candidates: vectorScanned,
    },
    cached: false,
  };
  if (!debug) searchCache.set(key, out);
  return out;
}

/**
 * 上下文扩展：命中块前后各取一块拼进 content。
 *
 * 员工提问时需要的往往不是「那一小段」，而是那一节完整的前因后果。
 * 检索仍按小块算分（精度高），返回时补上下文（可读性好）——
 * 这是「小块检索 + 大块返回」，比单纯调大块尺寸两头都讨好。
 */
function expandHits(tenantId, hits, maxChars = 1400) {
  tenantId = instanceId();
  const d = tdb(tenantId);
  for (const h of hits) {
    if (h.content.length >= maxChars) continue;
    const neighbors = d.all(
      `SELECT seq, content, heading FROM chunks
       WHERE doc_id = ? AND seq IN (?, ?) AND tenant_id = ?
       ORDER BY seq`,
      h.doc_id, h.seq - 1, h.seq + 1, tenantId,
    );
    if (!neighbors.length) continue;

    const parts = [];
    for (const n of neighbors) {
      if (n.seq === h.seq) continue;
      // 只在同一章节内扩展，跨章节拼接会把无关内容混进来
      if ((n.heading || '') !== (h.heading || '')) continue;
      parts.push(n);
    }
    if (!parts.length) continue;

    const before = parts.filter((p) => p.seq < h.seq).map((p) => p.content);
    const after = parts.filter((p) => p.seq > h.seq).map((p) => p.content);
    let text = h.content;
    const budget = maxChars - text.length;

    if (budget > 80 && before.length) {
      const b = before.join('\n');
      const take = b.slice(Math.max(0, b.length - Math.floor(budget * 0.4)));
      text = `${take}\n${text}`;
    }
    const rest = maxChars - text.length;
    if (rest > 80 && after.length) {
      text = `${text}\n${after.join('\n').slice(0, rest)}`;
    }
    h.content = text;
    h.expanded = true;
  }
}

function jsonParse(v, fallback) {
  if (v == null || v === '') return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

function charSet(s) {
  const out = new Set();
  for (const ch of normalize(s)) {
    if (ch >= '\u4e00' && ch <= '\u9fff') out.add(ch);
  }
  return out;
}

/**
 * FAQ 匹配：bigram 覆盖率 + 单字覆盖率加权。
 * 纯 bigram 对「退款要几天到账」vs「退款多久能到账」这种换词提问太严。
 */
export function matchFaqs(tenantId, query, opts = {}) {
  tenantId = instanceId();
  const topK = Math.min(10, Number(opts.topK) || 3);
  const minLevel = Math.max(1, Math.min(5, Number(opts.minLevel) || 1));
  const qmap = tokenize(query || '');
  if (!qmap.size) return [];
  const qBigrams = new Set(qmap.keys());
  const qChars = charSet(query);

  const d = tdb(tenantId);
  const rows = d.all(
    `SELECT * FROM faqs WHERE tenant_id = ? AND enabled = 1 AND min_level <= ?
     ${opts.spaceId ? 'AND (space_id = ? OR space_id IS NULL)' : ''}`,
    ...(opts.spaceId ? [tenantId, minLevel, opts.spaceId] : [tenantId, minLevel]),
  );

  const out = [];
  for (const r of rows) {
    const target = `${r.question} ${r.tags || ''}`;
    const fBigrams = new Set(tokenize(target).keys());
    const fChars = charSet(target);

    let bgHit = 0;
    for (const t of qBigrams) if (fBigrams.has(t)) bgHit += 1;
    let chHit = 0;
    for (const c of qChars) if (fChars.has(c)) chHit += 1;

    const bgCov = qBigrams.size ? bgHit / qBigrams.size : 0;
    const chCov = qChars.size ? chHit / qChars.size : 0;
    const coverage = 0.6 * bgCov + 0.4 * chCov;
    if (bgHit === 0 || coverage < 0.22) continue;

    out.push({
      id: r.id,
      question: r.question,
      answer: r.answer,
      tags: jsonParse(r.tags, []),
      min_level: Number(r.min_level) || 1,
      coverage: Number(coverage.toFixed(3)),
      score: Number((coverage * 100 + bgHit * 2).toFixed(2)),
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, topK);
}
