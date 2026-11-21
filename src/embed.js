/**
 * 文本向量化。
 *
 * 默认实现是「确定性哈希向量」（feature hashing）：
 *   - 特征 = 分词器产出的词（中文 bigram / 英文词，已过同义词归一）+ 字符三元组
 *   - 每个特征用 FNV-1a 哈希到固定维度，带符号（signed hashing）抵消碰撞偏置
 *   - tf 用 1+log(tf) 压制高频词，最后 L2 归一，余弦相似度 = 点积
 *
 * 为什么不用现成的 embedding 模型：
 *   1. 零依赖、离线可用、毫秒级 —— 与整个项目「不装 npm 包」的约束一致；
 *   2. 结果确定：同样的文本永远同样的向量，重建索引不会有漂移；
 *   3. 与 BM25 互补：词法只看精确匹配，向量能把「部分重合 + 同义改写」的块拉到候选里。
 *
 * 想换成真正的语义模型（bge / text-embedding-3 等）只需在 config.json 里配
 * embeddings.baseUrl + model + dim，然后把 scripts/embed.js 跑一遍重建。
 * 接口约定：POST {baseUrl}/embeddings {model, input:[...]} → {data:[{embedding:[]}]}
 */

import { tokenize, normalize } from './tokenize.js';
import { config } from './config.js';

export const LOCAL_DIM = 256;
const LOCAL_MODEL = 'hash-256-v2';

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** 单个特征落到某个维度上的带符号权重 */
function addFeature(v, feature, weight) {
  const h = fnv1a(feature);
  const idx = h % v.length;
  const sign = (h >>> 16) & 1 ? 1 : -1;
  v[idx] += sign * weight;
}

function l2norm(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/** 本地确定性向量 */
export function localEmbed(text, dim = LOCAL_DIM) {
  const v = new Float32Array(dim);
  const s = normalize(text);
  if (!s.trim()) return v;

  // 1) 词级特征：分词器已经做了同义词归一，语义相近的问法会落到同一个特征上
  const toks = tokenize(text);
  for (const [t, tf] of toks) {
    addFeature(v, `w:${t}`, 1 + Math.log(tf));
  }

  // 2) 单字 + 三元组：补足分词边界差异、错别字、以及「词没重合但字有重合」的情况
  const cjk = s.replace(/[\s\p{P}]/gu, '');
  for (let i = 0; i < cjk.length; i++) {
    addFeature(v, `u:${cjk[i]}`, 0.6);
  }
  for (let i = 0; i + 2 < cjk.length; i++) {
    addFeature(v, `c:${cjk.slice(i, i + 3)}`, 0.35);
  }

  return l2norm(v);
}

export function currentModel() {
  const e = config.embeddings || {};
  if (e.baseUrl && e.model) {
    return { model: e.model, dim: Number(e.dim) || 768, remote: true };
  }
  return { model: LOCAL_MODEL, dim: LOCAL_DIM, remote: false };
}

export function embedSync(text) {
  return localEmbed(text, currentModel().dim || LOCAL_DIM);
}

function toBase64F32(v) {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
}

/** 远程 embedding（配置了才走） */
export async function embedRemote(texts) {
  const e = config.embeddings;
  const url = `${String(e.baseUrl).replace(/\/+$/, '')}/embeddings`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(e.timeoutMs) || 20000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(e.apiKey ? { Authorization: `Bearer ${e.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: e.model, input: texts }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`embedding 接口 ${res.status}`);
    const data = await res.json();
    return data.data.map((d) => Float32Array.from(d.embedding));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 查询向量：本地模式同步返回，远程模式异步返回。
 * 调用方（api / answer）都是 async，await 一下即可，检索内核保持同步。
 */
export async function embedQuery(text) {
  const m = currentModel();
  if (!m.remote) return localEmbed(text, m.dim);
  try {
    const [v] = await embedRemote([text]);
    return v;
  } catch {
    // 远程不可用时降级到本地向量：宁可稍差，也不能让检索直接失败
    return localEmbed(text, m.dim);
  }
}

/** 批量向量化（建索引/重建时用） */
export async function embedBatch(texts) {
  const m = currentModel();
  if (!m.remote) return texts.map((t) => localEmbed(t, m.dim));
  const out = [];
  const BATCH = 32;
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    try {
      const vs = await embedRemote(slice);
      out.push(...vs);
    } catch {
      out.push(...slice.map((t) => localEmbed(t, m.dim)));
    }
  }
  return out;
}

export function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export const vecToBlob = toBase64F32;
