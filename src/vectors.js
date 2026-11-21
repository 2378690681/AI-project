import { getDb } from './db.js';
import { config } from './config.js';
import { embedSync, currentModel } from './embed.js';

/**
 * 向量索引（存在主库的 vectors 表里）。
 *
 * 早期版本给每个租户单独开一个 vectors.db；改成一企一部署后没必要了，
 * 一个企业一个 .db 文件，向量和原文放一起，备份只需拷一个文件。
 *
 * 存储格式：chunk_id 主键 + Float32 BLOB。256 维 = 1KB/块，
 * 10 万块约 100MB，企业知识库完全放得下。
 *
 * 检索方式：内存全量点积。首次访问把整个向量表读成连续 Float32Array，
 * 10 万块 × 256 维 ≈ 25M 次乘加，单次约 20~40ms。
 * 超过 20 万块建议换 ANN 索引（HNSW/IVF），届时只需替换 search 实现。
 */

let ver = 1;
let idx = null;

function bump() {
  ver += 1;
  idx = null;
}

function f32FromBlob(blob) {
  const u8 = new Uint8Array(blob);
  const copy = u8.slice();
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

/** 在已有事务里也能安全使用的写法（SAVEPOINT 可嵌套） */
function inSavepoint(fn) {
  const db = getDb();
  db.exec('SAVEPOINT vec_write');
  try {
    const out = fn(db);
    db.exec('RELEASE vec_write');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK TO vec_write'); db.exec('RELEASE vec_write'); } catch { /* ignore */ }
    throw e;
  }
}

function setMeta(db, key, value) {
  db.prepare(
    `INSERT INTO vec_meta(key,value) VALUES(?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run(key, String(value));
}

/** 写入一批「已经算好」的向量（远程模型 / 重建时用） */
export function upsertVectors(_tenantId, items, model) {
  if (!items.length) return 0;
  const m = model || currentModel();
  const ts = new Date().toISOString();

  const n = inSavepoint((db) => {
    const stmt = db.prepare(
      `INSERT INTO vectors(chunk_id, doc_id, space_id, dim, model, vec, updated_at)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(chunk_id) DO UPDATE SET doc_id=excluded.doc_id, space_id=excluded.space_id,
         dim=excluded.dim, model=excluded.model, vec=excluded.vec, updated_at=excluded.updated_at`,
    );
    let count = 0;
    for (const c of items) {
      const v = c.vec;
      stmt.run(
        c.id, c.docId || c.doc_id || '', c.spaceId || c.space_id || null,
        v.length, m.model, Buffer.from(v.buffer, v.byteOffset, v.byteLength), ts,
      );
      count += 1;
    }
    setMeta(db, 'model', m.model);
    setMeta(db, 'dim', m.dim || 0);
    return count;
  });

  bump();
  return n;
}

/**
 * 入库时同步写向量（只处理本地模型）。
 * 配置了远程 embedding 时这里直接跳过 —— 远程接口是异步的，
 * 强行同步会拖慢入库；统一由 scripts/embed.js 批量补齐/重建。
 */
export function indexVectors(_tenantId, chunks) {
  if (!chunks.length) return 0;
  const m = currentModel();
  if (m.remote) return 0;
  const items = chunks.map((c) => ({
    id: c.id,
    docId: c.docId || c.doc_id || '',
    spaceId: c.spaceId || c.space_id || null,
    vec: embedSync(`${c.heading || ''}\n${c.content || ''}`),
  }));
  return upsertVectors(_tenantId, items, m);
}

export function removeDocVectors(_tenantId, docId) {
  getDb().prepare(`DELETE FROM vectors WHERE doc_id = ?`).run(docId);
  bump();
}

export function removeAllVectors(_tenantId) {
  getDb().prepare(`DELETE FROM vectors`).run();
  bump();
}

/** 把整个向量表读进连续内存（一次 O(N)，之后每次检索只做点积） */
function loadIndex() {
  if (idx && idx.ver === ver) return idx;

  const rows = getDb()
    .prepare(`SELECT chunk_id, doc_id, space_id, dim, vec FROM vectors`)
    .all();
  const n = rows.length;
  const dim = n ? Number(rows[0].dim) : (currentModel().dim || 256);
  const mat = new Float32Array(n * dim);
  const ids = new Array(n);
  const docIds = new Array(n);
  const spaceIds = new Array(n);

  for (let i = 0; i < n; i++) {
    const r = rows[i];
    ids[i] = r.chunk_id;
    docIds[i] = r.doc_id;
    spaceIds[i] = r.space_id || null;
    const v = f32FromBlob(r.vec);
    mat.set(v.subarray(0, Math.min(dim, v.length)), i * dim);
  }

  idx = { ver, n, dim, mat, ids, docIds, spaceIds };
  return idx;
}

/**
 * 向量检索：返回 [{chunk_id, doc_id, space_id, cos}]
 * @param {Float32Array} qvec
 */
export function vectorSearch(_tenantId, qvec, { topK = 30, spaceId = null, minCos = 0.05 } = {}) {
  if (!qvec || !qvec.length) return [];
  const index = loadIndex();
  if (!index.n) return [];

  const { dim, mat } = index;
  const k = Math.min(dim, qvec.length);
  const scores = new Float32Array(index.n);

  for (let i = 0; i < index.n; i++) {
    const off = i * dim;
    let s = 0;
    for (let j = 0; j < k; j++) s += mat[off + j] * qvec[j];
    scores[i] = s;
  }

  // 取 topK：全量扫一遍用固定大小数组维护，避免对全部结果排序
  const best = [];
  for (let i = 0; i < index.n; i++) {
    if (scores[i] < minCos) continue;
    if (spaceId && index.spaceIds[i] !== spaceId) continue;
    if (best.length < topK) {
      best.push(i);
      if (best.length === topK) best.sort((a, b) => scores[a] - scores[b]);
    } else if (scores[i] > scores[best[0]]) {
      best[0] = i;
      for (let j = 0; j < best.length - 1; j++) {
        if (scores[best[j]] > scores[best[j + 1]]) {
          const t = best[j]; best[j] = best[j + 1]; best[j + 1] = t;
        } else break;
      }
    }
  }

  return best
    .sort((a, b) => scores[b] - scores[a])
    .map((i) => ({
      chunk_id: index.ids[i],
      doc_id: index.docIds[i],
      space_id: index.spaceIds[i],
      cos: Number(scores[i].toFixed(4)),
    }));
}

/** 是否已经建过向量（没有就纯词法检索，不做无用功） */
export function hasVectors(_tenantId) {
  return loadIndex().n > 0;
}

export function vectorStats(_tenantId) {
  const db = getDb();
  const row = db.prepare(`SELECT COUNT(*) AS n, MIN(dim) AS dim FROM vectors`).get();
  const meta = Object.fromEntries(
    db.prepare(`SELECT key, value FROM vec_meta`).all().map((r) => [r.key, r.value]),
  );
  const n = Number(row?.n || 0);
  return {
    chunks: n,
    dim: Number(row?.dim || 0) || Number(meta.dim || 0),
    model: meta.model || null,
    current_model: currentModel().model,
    // 向量存在主库的 vectors 表里，file 只用于展示数据文件位置
    file: config.database,
    table: 'vectors',
    bytes: n * (Number(row?.dim || 256)) * 4,
    stale: Boolean(meta.model && meta.model !== currentModel().model),
  };
}

/** 向量与原文块是否一致（换模型/换切分后可能不一致） */
export function vectorHealth(_tenantId) {
  const db = getDb();
  const vecN = Number(db.prepare(`SELECT COUNT(*) AS n FROM vectors`).get()?.n || 0);
  const meta = Object.fromEntries(
    db.prepare(`SELECT key, value FROM vec_meta`).all().map((r) => [r.key, r.value]),
  );
  return { vectors: vecN, model: meta.model || null, expected: currentModel().model };
}

export function closeVectors(_tenantId) {
  idx = null;
}
