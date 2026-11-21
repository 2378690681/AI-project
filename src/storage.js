import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { config } from './config.js';
import { now, newId, instanceId } from './db.js';
import { tdb, tenantFilesDir } from './tenant-db.js';

/**
 * 原始件存储 —— 文件也跟着租户走。
 *
 * 路径：data/tenants/<tenant_id>/files/<前2位>/<sha256>.<ext>
 *
 * 这样「导出/删除一个企业」只需要处理它自己的目录，
 * 不需要在一堆共享文件里挑出属于谁的；磁盘配额也天然按租户可测。
 *
 * 老版本文件在 data/files/ 下，读取时会自动回退到老路径（只读兼容），
 * 新写入一律进租户目录。
 */

const MIME = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

export function mimeFor(filename) {
  return MIME[extname(String(filename || '')).toLowerCase()] || 'application/octet-stream';
}

/** 租户文件根目录 */
export function filesRoot(tenantId) {
  return tenantId ? tenantFilesDir(tenantId) : resolve(config.dataDir, 'tenants', '_shared');
}

/** 老版本共享目录（只读兼容） */
export function legacyFilesRoot() {
  return resolve(config.dataDir, 'files');
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function wrap(row) {
  if (!row) return null;
  return {
    id: row.id,
    sha256: row.sha256,
    size: Number(row.size),
    mime: row.mime,
    ext: row.ext,
    filename: row.filename,
    storagePath: row.storage_path,
    createdAt: row.created_at,
  };
}

/**
 * 保存一份原始件（同租户同内容去重）
 * @param {{tenantId:string, buffer:Buffer, filename?:string}} input
 */
export function putFile({ tenantId, buffer, filename }) {
  tenantId = instanceId();
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('putFile 收到空文件');

  const d = tdb(tenantId);
  const hash = sha256(buffer);
  const safeName = String(filename || 'unnamed').replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);
  const ext = extname(safeName).toLowerCase().slice(0, 12) || '';

  const hit = d.get(`SELECT * FROM doc_files WHERE tenant_id = ? AND sha256 = ?`, tenantId, hash);
  if (hit) return { ...wrap(hit), deduped: true };

  const rel = join(hash.slice(0, 2), hash + ext);
  const abs = resolve(filesRoot(tenantId), rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, buffer);

  const id = newId('file_');
  const ts = now();
  d.run(
    `INSERT INTO doc_files(id, tenant_id, sha256, size, mime, ext, filename, storage_path, created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    id, tenantId, hash, buffer.length, mimeFor(safeName), ext, safeName, rel, ts,
  );

  return {
    id, sha256: hash, size: buffer.length, mime: mimeFor(safeName),
    ext, filename: safeName, storagePath: rel, createdAt: ts, deduped: false,
  };
}

/** 按 id 取原始件记录（强制带租户，防越权下载） */
export function getFileRecord(tenantId, fileId) {
  tenantId = instanceId();
  if (!fileId) return null;
  return wrap(tdb(tenantId).get(`SELECT * FROM doc_files WHERE id = ? AND tenant_id = ?`, fileId, tenantId));
}

/** 解析绝对路径，兼容老版本的共享目录 */
export function fileAbsPath(rec, tenantId) {
  const inTenant = resolve(filesRoot(tenantId), rec.storagePath);
  if (existsSync(inTenant)) return inTenant;
  const legacy = resolve(legacyFilesRoot(), rec.storagePath);
  if (existsSync(legacy)) return legacy;
  return inTenant;
}

export function readFileBuffer(rec, tenantId) {
  const abs = fileAbsPath(rec, tenantId);
  if (!existsSync(abs)) {
    throw new Error(`原始件在磁盘上缺失：${rec.storagePath}（元数据还在，需从备份恢复）`);
  }
  return readFileSync(abs);
}

export function fileExists(rec, tenantId) {
  try {
    const abs = fileAbsPath(rec, tenantId);
    return existsSync(abs) && statSync(abs).isFile();
  } catch {
    return false;
  }
}

/** 存储用量（运营看板用） */
export function storageStats(tenantId) {
  tenantId = instanceId();
  const row = tdb(tenantId).get(
    `SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM doc_files WHERE tenant_id = ?`,
    tenantId,
  );
  return {
    files: Number(row?.files || 0),
    bytes: Number(row?.bytes || 0),
    mb: Number((Number(row?.bytes || 0) / 1048576).toFixed(2)),
    dir: filesRoot(tenantId),
  };
}
