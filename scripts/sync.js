// 通用知识同步器：把外部内容推进知识库。
//
// 用法：
//   # 同步本地目录（递归，支持 md/txt/html/docx/pdf）
//   node scripts/sync.js --from "D:/项目文档" --space 项目文档
//
//   # 同步在线文档（任意返回 markdown/纯文本的 URL）
//   node scripts/sync.js --url https://wiki.example.com/a.md --space 产品文档
//
//   # 从文件批量导入 URL 列表（每行一个，格式：URL 或 URL<TAB>标题）
//   node scripts/sync.js --url-file urls.txt --space 产品文档
//
// 单实例部署下不再需要 --tenant，服务只认自己那一个库；旧脚本带着也不报错。
//
// 飞书 / 腾讯文档接入方式：
//   先用平台能力把文档导出成 markdown 存到本地目录，再走 --from 目录同步，
//   或用 --url-file 批量导入导出后的下载链接。同步游标记在 sync_cursors 表。

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { initAll } from '../src/bootstrap.js';

function parseArgs(argv) {
  const out = { urls: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    if (key === 'url') out.urls.push(val);
    else out[key] = val;
  }
  return out;
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'kb-hub-sync/0.1', Accept: 'text/markdown,text/plain,text/html,*/*' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { config } = await import('../src/config.js');
  // --tenant 仅为兼容旧脚本保留，单实例下恒等于本实例 id
  const tenantId = args.tenant || args.t || config.instance.id;

  await initAll();
  const { ingestFile, ingestDirectory, ingestDocument } = await import('../src/ingest.js');
  const { ensureSpace, getInstance, ensureInstance } = await import('../src/store.js');
  const { q, now } = await import('../src/db.js');

  if (args.tenant && args.tenant !== config.instance.id) {
    console.warn(`[sync] 忽略 --tenant ${args.tenant}（本实例 id = ${config.instance.id}）`);
  }
  if (!getInstance(tenantId)) ensureInstance();

  const tags = args.tags ? String(args.tags).split(',').map((s) => s.trim()).filter(Boolean) : [];
  const spaceSlug = args.space || 'default';
  const space = ensureSpace(tenantId, spaceSlug, args['space-name'] || spaceSlug);
  const t0 = Date.now();
  let stats = { created: 0, updated: 0, skipped: 0, failed: 0 };

  // ---- 目录同步 ----
  if (args.from) {
    const dir = resolve(args.from);
    if (!existsSync(dir)) {
      console.error(`目录不存在: ${dir}`);
      process.exit(1);
    }
    console.log(`▸ 扫描目录 ${dir}`);
    const r = ingestDirectory(tenantId, dir, { spaceSlug, tags });
    stats = { created: r.created, updated: r.updated, skipped: r.skipped, failed: r.failed.length };
    for (const f of r.failed.slice(0, 10)) console.log(`  ✗ ${f.file}: ${f.error}`);
  }

  // ---- URL 同步 ----
  const targets = [...(args.urls || [])];
  if (args['url-file']) {
    const lines = readFileSync(resolve(args['url-file']), 'utf8').split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const [url, ...titleParts] = t.split('\t');
      targets.push(titleParts.length ? `${url}\t${titleParts.join(' ')}` : url);
    }
  }

  for (const raw of targets) {
    const [url, ...titleParts] = String(raw).split('\t');
    try {
      const text = await fetchText(url);
      const r = ingestDocument({
        tenantId,
        spaceId: space.id,
        title: titleParts.join(' ') || url.split('/').pop().split('?')[0] || '未命名',
        text,
        docType: url.endsWith('.html') ? 'html' : 'md',
        sourceType: 'url',
        sourceUri: url,
        tags,
      });
      if (r.status === 'created') stats.created += 1;
      else if (r.status === 'updated') stats.updated += 1;
      else stats.skipped += 1;
      console.log(`  ${r.status === 'skipped' ? '·' : '✓'} ${url} — ${r.status}`);
    } catch (e) {
      stats.failed += 1;
      console.log(`  ✗ ${url}: ${e.message}`);
    }
  }

  // ---- 记录同步游标 ----
  const ref = args.from ? resolve(args.from) : 'url-batch';
  q.run(
    `INSERT INTO sync_cursors(id, tenant_id, source_type, source_ref, cursor, last_run_at, last_status, stats)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id, source_type, source_ref) DO UPDATE SET
       cursor = excluded.cursor, last_run_at = excluded.last_run_at,
       last_status = excluded.last_status, stats = excluded.stats`,
    `sync_${Date.now()}`, tenantId, args.from ? 'dir' : 'url', ref,
    now(), now(), stats.failed ? 'partial' : 'ok', JSON.stringify(stats),
  );

  console.log(`\n完成：新增 ${stats.created}，更新 ${stats.updated}，跳过 ${stats.skipped}，失败 ${stats.failed}（${Date.now() - t0}ms）`);
}

main().catch((e) => {
  console.error('同步失败:', e.message);
  process.exit(1);
});
