/**
 * 向量库重建 / 补齐。
 *
 * 用法：
 *   node scripts/embed.js          # 补齐缺失的块
 *   node scripts/embed.js --force  # 清空后全量重建（换模型后用）
 *   node scripts/embed.js --stats  # 只看向量状态
 *
 * 单实例部署：向量存在本企业数据库的 vectors 表里（与原文同库），
 * --tenant 仅为兼容旧脚本保留，传了也会被忽略。
 */
import { existsSync } from 'node:fs';
import { listTenants } from '../src/store.js';
import { tdb } from '../src/tenant-db.js';
import { upsertVectors, vectorStats, removeAllVectors } from '../src/vectors.js';
import { currentModel, embedBatch } from '../src/embed.js';

const args = process.argv.slice(2);
const getArg = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const has = (name) => args.includes(`--${name}`);

async function main() {
  const only = getArg('tenant');
  const force = has('force');
  const statsOnly = has('stats');

  const tenants = listTenants().filter((t) => !only || t.id === only);
  if (!tenants.length) {
    console.error(`实例不存在: ${only || '—'}`);
    process.exit(1);
  }
  if (only && only !== tenants[0].id) console.warn(`[embed] 忽略 --tenant ${only}（本实例 id = ${tenants[0].id}）`);

  const model = currentModel();
  console.log(`▸ 向量模型：${model.model}（${model.dim} 维，${model.remote ? '远程接口' : '本地确定性'}）`);

  for (const t of tenants) {
    const d = tdb(t.id);
    if (!existsSync(d.path)) {
      console.log(`\n[${t.id}] 数据库不存在（${d.path}），跳过`);
      continue;
    }
    const chunks = d.all(`SELECT c.id, c.doc_id, c.space_id, c.heading, c.content
                          FROM chunks c JOIN documents d ON d.id = c.doc_id
                          WHERE d.status = 'active' ORDER BY c.doc_id, c.seq`);
    const before = vectorStats(t.id);
    console.log(`\n[${t.id}] ${t.name} · 块 ${chunks.length} · 现有向量 ${before.chunks}`);

    if (statsOnly) {
      console.log(`           模型 ${before.model || '—'}${before.stale ? '（与当前模型不一致，需重建）' : ''} · ${(before.bytes / 1048576).toFixed(1)}MB`);
      continue;
    }

    if (force) {
      removeAllVectors(t.id);
      console.log('           已清空旧向量');
    }

    const todo = force
      ? chunks
      : chunks.filter((c) => !d.get(`SELECT 1 AS x FROM vectors WHERE chunk_id = ?`, c.id));
    if (!todo.length) {
      console.log('           已是最新，无需处理');
      continue;
    }

    let done = 0;
    const BATCH = 32;
    for (let i = 0; i < todo.length; i += BATCH) {
      const slice = todo.slice(i, i + BATCH);
      const vecs = await embedBatch(slice.map((c) => `${c.heading || ''}\n${c.content || ''}`));
      upsertVectors(t.id, slice.map((c, k) => ({
        id: c.id, docId: c.doc_id, spaceId: c.space_id, vec: vecs[k],
      })), model);
      done += slice.length;
      process.stdout.write(`\r           已向量化 ${Math.min(i + BATCH, todo.length)}/${todo.length}`);
    }
    process.stdout.write('\n');
    const after = vectorStats(t.id);
    console.log(`           完成：新增 ${done} · 当前 ${after.chunks} 条 · ${(after.bytes / 1048576).toFixed(1)}MB`);
    console.log(`           文件：${after.file}`);
  }
  console.log('\n完成。');
}

main().catch((e) => {
  console.error('✗ 向量化失败:', e.message);
  process.exit(1);
});
