import { createHash } from 'node:crypto';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, relative, extname } from 'node:path';
import { q, now, newId, qs, instanceId } from './db.js';
import { tdb, ttx } from './tenant-db.js';
import { splitText } from './splitter.js';
import { indexChunks, removeDocIndex, refreshStats } from './indexer.js';
import { parseBuffer, detectType, guessTitle, SUPPORTED_EXTENSIONS } from './parsers.js';
import { ensureSpace } from './store.js';
import { putFile, getFileRecord } from './storage.js';
import { bumpEpoch } from './cache.js';
import { indexVectors, removeDocVectors, removeAllVectors } from './vectors.js';

const MAX_CHUNKS_PER_DOC = 20000;
const MAX_CHARS_PER_DOC = 20_000_000;

function resolveSpace(tenantId, input) {
  tenantId = instanceId();
  if (input.spaceId) {
    const s = tdb(tenantId).get(`SELECT * FROM spaces WHERE id = ? AND tenant_id = ?`, input.spaceId, tenantId);
    if (!s) throw new Error('space_id 不存在或不属于该租户');
    return s;
  }
  return ensureSpace(tenantId, input.spaceSlug || input.space || 'default');
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * 文档入库（幂等 + 版本化）
 *
 * 幂等：source_uri 相同且内容哈希一致 → skipped，不重建索引（同步任务可无脑全量推）
 * 版本：内容变化 → 同一 doc_id 升 version，并写一条 document_versions，旧版原始件保留
 *
 * @param {object} input
 * @param {string} input.tenantId
 * @param {string} [input.text]        正文（可为空，配合 allowEmpty 用于「解析失败但原件已存」）
 * @param {Buffer} [input.buffer]      原始件字节，给了就落盘
 * @param {string} [input.fileId]      已落盘的原始件 id
 */
export function ingestDocument(input) {
  // 单实例：忽略调用方传的 tenantId，统一落到本企业
  const tenantId = instanceId();
  const d = tdb(tenantId);
  const space = resolveSpace(tenantId, input);

  const text = String(input.text ?? '');
  const allowEmpty = Boolean(input.allowEmpty);
  if (!text.trim() && !allowEmpty) throw new Error('正文为空，拒绝入库');
  if (text.length > MAX_CHARS_PER_DOC) {
    throw new Error(`单文档超过 ${MAX_CHARS_PER_DOC / 1e6} 百万字符，请拆分后入库`);
  }

  // 1) 原始件：给了 buffer 就落盘，给了 fileId 就复用
  let fileRec = null;
  if (input.buffer) {
    fileRec = putFile({
      tenantId,
      buffer: input.buffer,
      filename: input.filename || `${input.title || 'document'}${input.docType ? '.' + input.docType : ''}`,
    });
  } else if (input.fileId) {
    fileRec = getFileRecord(tenantId, input.fileId);
    if (!fileRec) throw new Error('file_id 不存在或不属于该租户');
  }

  const title = String(input.title || guessTitle(text, fileRec?.filename || '未命名文档')).slice(0, 300);
  const docType = input.docType || (fileRec?.ext ? fileRec.ext.replace(/^\./, '') : 'md');
  const sourceType = input.sourceType || 'http';
  const sourceUri = input.sourceUri || (fileRec ? `upload://${fileRec.sha256}` : null);
  const tags = (input.tags || []).map((t) => String(t).trim()).filter(Boolean);
  const visibility = input.visibility === 'restricted' ? 'restricted' : 'internal';
  const allowedRoles = visibility === 'restricted' ? (input.allowedRoles || []) : [];
  const uploader = input.uploader ? String(input.uploader).slice(0, 120) : null;
  const originalName = input.originalName || fileRec?.filename || null;
  const parseStatus = input.parseStatus || (text.trim() ? 'ok' : 'failed');
  const parseError = input.parseError || null;
  // 阅读等级门槛：1 全员可见，5 仅高管。不传则沿用原值（更新时不误降级）
  const minLevel = Math.max(1, Math.min(5, Number(input.minLevel) || 1));

  const hash = fileRec && !text.trim() ? fileRec.sha256 : sha256(text);
  const ts = now();

  // 2) 幂等判定
  let existing = null;
  if (sourceUri) {
    existing = d.get(
      `SELECT * FROM documents WHERE tenant_id = ? AND source_uri = ? ORDER BY created_at DESC LIMIT 1`,
      tenantId, sourceUri,
    );
  }
  if (existing && existing.source_hash === hash && existing.parse_status === parseStatus) {
    // 内容没变，但密级是元数据不是正文：调用方明确给了新等级就顺手改掉，
    // 否则沿用原值（不能因为一次没传 min_level 就把机密文档降级成公开）。
    if (input.minLevel != null && Number(existing.min_level) !== minLevel) {
      d.run(`UPDATE documents SET min_level = ?, updated_at = ? WHERE id = ?`, minLevel, ts, existing.id);
      return {
        status: 'skipped',
        releveled: true,
        docId: existing.id,
        title: existing.title,
        fileId: existing.file_id,
        chunkCount: Number(existing.chunk_count) || 0,
        charCount: Number(existing.char_count) || 0,
        minLevel,
        reason: `内容未变化，仅把密级从 L${Number(existing.min_level) || 1} 调整为 L${minLevel}`,
      };
    }
    return {
      status: 'skipped',
      docId: existing.id,
      title: existing.title,
      fileId: existing.file_id,
      chunkCount: Number(existing.chunk_count) || 0,
      charCount: Number(existing.char_count) || 0,
      reason: '内容未变化（source_hash 命中）',
    };
  }

  // 3) 切分
  let pieces = [];
  if (text.trim()) {
    pieces = splitText(text, {
      maxChars: input.maxChunkChars,
      overlap: input.overlapChars,
      title,
    });
    if (!pieces.length) throw new Error('切分后无有效内容');
    if (pieces.length > MAX_CHUNKS_PER_DOC) {
      throw new Error(`切分产生 ${pieces.length} 个块，超过上限 ${MAX_CHUNKS_PER_DOC}，请拆分文档`);
    }
  }

  const docId = existing ? existing.id : newId('d_');
  const version = existing ? Number(existing.version) + 1 : 1;
  if (existing) removeDocIndex(tenantId, docId);

  const chunkRows = pieces.map((p, i) => ({
    id: newId('c_'),
    seq: i,
    heading: p.heading || '',
    content: p.content,
    title,
  }));

  ttx(tenantId, () => {
    if (existing) {
      d.run(
        `UPDATE documents SET space_id = ?, title = ?, doc_type = ?, source_type = ?, source_uri = ?,
           source_hash = ?, tags = ?, visibility = ?, allowed_roles = ?, version = ?,
           status = 'active', char_count = ?, chunk_count = ?, file_id = ?, uploader = ?,
           original_name = ?, parse_status = ?, parse_error = ?,
           min_level = ?, updated_at = ?, indexed_at = ?
         WHERE id = ?`,
        space.id, title, docType, sourceType, sourceUri, hash, qs(tags), visibility,
        qs(allowedRoles), version, text.length, chunkRows.length,
        fileRec?.id ?? existing.file_id ?? null, uploader ?? existing.uploader ?? null,
        originalName, parseStatus, parseError,
        input.minLevel != null ? minLevel : (Number(existing.min_level) || 1),
        ts, ts, docId,
      );
    } else {
      d.run(
        `INSERT INTO documents(id, tenant_id, space_id, title, doc_type, source_type, source_uri,
           source_hash, tags, visibility, allowed_roles, min_level, version, status, char_count, chunk_count,
           file_id, uploader, original_name, parse_status, parse_error, created_at, updated_at, indexed_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,'active',?,?,?,?,?,?,?,?,?,?)`,
        docId, tenantId, space.id, title, docType, sourceType, sourceUri, hash, qs(tags),
        visibility, qs(allowedRoles), minLevel, text.length, chunkRows.length,
        fileRec?.id ?? null, uploader, originalName, parseStatus, parseError, ts, ts, ts,
      );
    }

    for (const c of chunkRows) {
      d.run(
        `INSERT INTO chunks(id, tenant_id, doc_id, space_id, seq, heading, content, n_terms, created_at)
         VALUES(?,?,?,?,?,?,?,0,?)`,
        c.id, tenantId, docId, space.id, c.seq, c.heading, c.content, ts,
      );
    }

    // 版本快照：每次内容变化都留一条，旧版原始件不删
    d.run(
      `INSERT OR REPLACE INTO document_versions(id, tenant_id, doc_id, version, file_id, title,
         char_count, chunk_count, source_hash, note, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      newId('v_'), tenantId, docId, version, fileRec?.id ?? existing?.file_id ?? null,
      title, text.length, chunkRows.length, hash, existing ? 'updated' : 'created', ts,
    );
  });

  if (chunkRows.length) {
    indexChunks(tenantId, chunkRows.map((c) => ({
      id: c.id,
      content: c.content,
      heading: c.heading,
      title,
    })));
    // 向量和倒排同步写：向量库是独立文件，即使这里失败原文与词法检索仍可用
    try {
      indexVectors(tenantId, chunkRows.map((c) => ({
        id: c.id, docId, spaceId: space.id, heading: c.heading, content: c.content,
      })));
    } catch (e) {
      console.error(`[vectors] 租户 ${tenantId} 文档 ${docId} 向量写入失败: ${e.message}`);
    }
  }

  bumpEpoch();

  return {
    status: existing ? 'updated' : 'created',
    docId,
    title,
    spaceId: space.id,
    chunkCount: chunkRows.length,
    charCount: text.length,
    version,
    fileId: fileRec?.id ?? null,
    parseStatus,
  };
}

/**
 * 二进制入库：员工上传入口。
 *
 * 关键取舍 —— 解析失败也不丢数据：
 * 原件一定先落盘，解析不出来就记一条 parse_status='failed' 的文档，
 * 员工照样能下载回去看，管理员也能统计出「哪些文件需要 OCR」。
 */
export function ingestBinary(input) {
  const tenantId = instanceId();
  const { buffer, filename } = input;
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('文件为空');
  const name = String(filename || 'unnamed');
  const docType = detectType(name);

  let text = '';
  let parseStatus = 'ok';
  let parseError = null;
  try {
    text = parseBuffer(buffer, name).text;
    if (!text.trim()) {
      parseStatus = 'failed';
      parseError = '解析后无文字内容（可能是扫描件、纯图片或空文件）';
    }
  } catch (e) {
    parseStatus = 'failed';
    parseError = e.message;
  }

  // 先落盘：即使在入库过程中出任何问题，原始件都已经安全存下
  const fileRec = putFile({ tenantId, buffer, filename: name });

  const baseTitle = name.replace(/\.[^.]+$/, '') || '未命名文档';

  return ingestDocument({
    tenantId,
    spaceId: input.spaceId,
    spaceSlug: input.spaceSlug,
    space: input.space,
    title: input.title || baseTitle,
    text,
    allowEmpty: true,
    docType,
    sourceType: input.sourceType || 'upload',
    sourceUri: input.sourceUri || `upload://${fileRec.sha256}`,
    tags: input.tags,
    visibility: input.visibility,
    allowedRoles: input.allowedRoles,
    fileId: fileRec.id,
    uploader: input.uploader,
    originalName: name,
    parseStatus,
    parseError,
    minLevel: input.minLevel,
  });
}

/**
 * 从本地文件入库（原始件同样落盘，便于后续下载原文）
 *
 * 必须走 ingestBinary 而不是直接 ingestDocument：docx/pptx/xlsx/pdf
 * 都是二进制，需要先解包抽文字。之前这里漏了这一步，导致 CLI add
 * 对任何文件都报「正文为空」。
 */
export function ingestFile(tenantId, filePath, opts = {}) {
  const abs = resolve(filePath);
  const stat = statSync(abs);
  if (!stat.isFile()) throw new Error(`不是文件: ${abs}`);

  const name = abs.split(/[\\/]/).pop();
  const buffer = readFileSync(abs);
  return ingestBinary({
    tenantId,
    buffer,
    filename: name,
    spaceSlug: opts.spaceSlug,
    spaceId: opts.spaceId,
    title: opts.title,
    sourceType: 'file',
    sourceUri: opts.sourceUri || `file://${abs.replace(/\\/g, '/')}`,
    tags: opts.tags,
    visibility: opts.visibility,
    allowedRoles: opts.allowedRoles,
    uploader: opts.uploader,
    minLevel: opts.minLevel,
  });
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.idea', '.vscode', 'dist', 'build',
  '__pycache__', '.venv', 'venv', 'tmp-fixtures',
]);
const SUPPORTED_EXT = new Set(SUPPORTED_EXTENSIONS);

/**
 * 目录批量入库
 * @returns {{created:number, updated:number, skipped:number, failed:Array<{file:string,error:string}>}}
 */
export function ingestDirectory(tenantId, dir, opts = {}) {
  const root = resolve(dir);
  const stat = statSync(root);
  if (!stat.isDirectory()) throw new Error(`不是目录: ${root}`);

  const files = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name.startsWith('.')) continue;
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        walk(full);
      } else if (SUPPORTED_EXT.has(extname(name).toLowerCase())) {
        files.push(full);
      }
    }
  };
  walk(root);

  const result = { created: 0, updated: 0, skipped: 0, failed: [], total: files.length };
  for (const f of files) {
    try {
      const rel = relative(root, f).replace(/\\/g, '/');
      const spaceSlug = opts.flatSpace ? opts.spaceSlug : (opts.spaceSlug || 'default');
      const r = ingestFile(tenantId, f, {
        ...opts,
        spaceSlug,
        sourceUri: `file://${f.replace(/\\/g, '/')}`,
        tags: [...(opts.tags || []), ...(opts.flatSpace ? [] : [rel.split('/')[0]])].filter(Boolean),
      });
      if (r.status === 'created') result.created += 1;
      else if (r.status === 'updated') result.updated += 1;
      else result.skipped += 1;
    } catch (e) {
      result.failed.push({ file: f, error: e.message });
    }
  }
  refreshStats(tenantId);
  return result;
}

export function deleteDocument(tenantId, docId) {
  tenantId = instanceId();
  const d = tdb(tenantId);
  const doc = d.get(`SELECT id, title FROM documents WHERE id = ? AND tenant_id = ?`, docId, tenantId);
  if (!doc) return null;
  removeDocIndex(tenantId, docId);
  d.run(`DELETE FROM document_versions WHERE doc_id = ? AND tenant_id = ?`, docId, tenantId);
  d.run(`DELETE FROM documents WHERE id = ?`, docId);
  try { removeDocVectors(tenantId, docId); } catch { /* 向量库单独损坏不影响删文档 */ }
  refreshStats(tenantId);
  bumpEpoch();
  return doc;
}

/** 全量重建索引（改了切分参数或分词逻辑后） */
export function reindexTenant(tenantId) {
  tenantId = instanceId();
  const d = tdb(tenantId);
  const docs = d.all(`SELECT id, title FROM documents WHERE tenant_id = ? AND status = 'active'`, tenantId);
  let n = 0;
  removeAllVectors(tenantId);
  for (const doc of docs) {
    const chunks = d.all(`SELECT id, content, heading, space_id FROM chunks WHERE doc_id = ? ORDER BY seq`, doc.id);
    if (chunks.length) {
      indexChunks(tenantId, chunks.map((c) => ({ ...c, title: doc.title })));
      indexVectors(tenantId, chunks.map((c) => ({
        id: c.id, docId: doc.id, spaceId: c.space_id, heading: c.heading, content: c.content,
      })));
      n += chunks.length;
    }
  }
  bumpEpoch();
  return { documents: docs.length, chunks: n, vectors: n };
}
