import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 生成 config.json（仅首次）。注意：本模块刻意不 import './config.js'，
 * 以便调用方在 config 被缓存之前先把文件写出来。
 */
export function ensureConfigFile() {
  const p = process.env.KB_CONFIG || join(ROOT, 'config.json');
  if (existsSync(p)) {
    return { created: false, path: p, config: JSON.parse(readFileSync(p, 'utf8')) };
  }
  const rootKey = `kb_root_${randomBytes(24).toString('hex')}`;
  const tpl = {
    host: '127.0.0.1',
    port: 7300,
    instance: {
      // 这套服务代表哪个企业（仅用于展示与数据标记）
      id: 'default',
      name: '我的企业',
    },
    dataDir: 'data',
    // 一个企业一个数据库文件。换成其他路径即可把数据放到别处，
    // 例如 "D:/kb-data/acme/kb.db"；也可以用环境变量 KB_DB 覆盖。
    database: 'data/kb.db',
    rootKey,
    retrieval: {
      topK: 8,
      minScore: 0.1,
      maxChunkChars: 700,
      overlapChars: 80,
      bm25K1: 1.2,
      bm25B: 0.75,
      titleBoost: 2,
      lexicalWeight: 0.7,
      vectorWeight: 0.3,
      minCosine: 0.12,
    },
    // 留空 = 用本地确定性向量（零依赖、离线可用）
    embeddings: { baseUrl: '', apiKey: '', model: '', dim: 768 },
    session: { ttlHours: 12, secure: false },
    llm: { baseUrl: '', apiKey: '', model: '' },
    cors: '*',
    defaultRateLimit: 120,
  };
  writeFileSync(p, `${JSON.stringify(tpl, null, 2)}\n`, 'utf8');
  return { created: true, path: p, rootKey, config: tpl };
}

/** 初始化目录 + 数据库。返回前会确保 config.json 已落盘。 */
export async function initAll() {
  const cfg = ensureConfigFile();
  const dataDir = resolve(ROOT, cfg.config.dataDir || 'data');
  mkdirSync(dataDir, { recursive: true });
  const { getDb, ensureInstance } = await import('./db.js');
  const { migrateLegacyLayout, ensureFilesDir } = await import('./tenant-db.js');
  getDb();
  ensureInstance({ name: cfg.config.instance?.name });
  ensureFilesDir();
  // 从旧的多租户目录（data/tenants/<id>/）并入单库，只在新库为空时执行
  const migrated = migrateLegacyLayout();
  return { ...cfg, dataDir, migrated };
}
