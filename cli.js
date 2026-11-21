#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { initAll } from './src/bootstrap.js';

function parseArgs(args) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[a.slice(2)] = next;
          i += 1;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

const HELP = `企业外置知识库 · 命令行

  初始化
    node cli.js init
    node cli.js seed                         载入演示数据

  企业与密钥（单实例：一个企业一套服务）
    node cli.js tenant:create <企业名称> [--owner-email a@b.com]   初始化本企业
    node cli.js tenant:list                                       查看本企业
    node cli.js key:create [--scopes search,read,write] [--reader-level 5]
    node cli.js key:list
    node cli.js key:revoke <密钥ID>

  后台账号与权限
    node cli.js admin:create <邮箱> [--role admin] [--level 3] [--name 张三]
    node cli.js admin:list
    node cli.js admin:reset <邮箱>
    node cli.js admin:roles

  向量库
    node cli.js vector:stats [--tenant t_demo]
    node cli.js vector:rebuild [--tenant t_demo]

  知识入库
    node cli.js add <文件路径> [--tenant t_demo] [--space 产品文档] [--tags 接入,api] [--level 1]
    node cli.js add-dir <目录> [--tenant t_demo] [--space 产品文档]
    node cli.js faq:add "问题" "答案" [--tags a,b]
    node cli.js list [--tenant t_demo]
    node cli.js delete <文档ID> [--tenant t_demo]
    node cli.js reindex

  验证
    node cli.js search "查询词" [--tenant t_demo] [--top 5]
    node cli.js ask "问题" [--tenant t_demo]
    node cli.js stats [--tenant t_demo]
`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const { flags, pos } = parseArgs(argv.slice(1));

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return;
  }

  await initAll();

  const store = await import('./src/store.js');
  const ingest = await import('./src/ingest.js');
  const indexer = await import('./src/indexer.js');
  const answer = await import('./src/answer.js');

  const { config } = await import('./src/config.js');
  // 单实例：所有命令都作用在本企业上，--tenant 仅为兼容旧脚本保留
  const tenantOf = () => config.instance.id;

  switch (cmd) {
    case 'init': {
      console.log('✓ 初始化完成');
      console.log(`  数据库: ${(await import('./src/config.js')).config.dbPath}`);
      const cfg = JSON.parse((await import('node:fs')).readFileSync(
        (await import('node:path')).join((await import('./src/bootstrap.js')).ROOT, 'config.json'), 'utf8',
      ));
      console.log(`  管理根密钥: ${cfg.rootKey}`);
      console.log('\n下一步: node cli.js tenant:create "我的公司"   （初始化本企业并签发首个密钥）');
      break;
    }

    case 'seed': {
      await import('./scripts/seed-demo.js');
      break;
    }

    case 'tenant:create': {
      // 单实例：不再是「新建一个租户」，而是初始化/重命名本企业
      const name = pos[0] || flags.name;
      if (!name) throw new Error('请提供企业名称');
      const t = store.ensureInstance({ name });
      const key = store.createApiKey({
        tenantId: t.id,
        name: flags['key-name'] || '初始密钥',
        scopes: (flags.scopes || 'search,read,write').split(',').map((s) => s.trim()).filter(Boolean),
        readerLevel: Number(flags['reader-level']) || 5,
      });
      const rbac = await import('./src/rbac.js');
      const owner = rbac.ensureOwner(t.id, {
        email: flags['owner-email'],
        password: flags['owner-password'],
        name: flags['owner-name'],
      });
      console.log(`✓ 企业已初始化: ${t.id}  ${t.name}`);
      console.log(`  数据库: ${config.database}   （一个企业一个文件）`);
      console.log(`  原件目录: ${config.filesDir}`);
      console.log(`\n  API Key（仅显示一次，请立即保存）:\n  ${key.plaintext}`);
      if (owner.created) {
        console.log(`\n  后台账号: ${owner.user.email} / ${owner.password}`);
        console.log(`  后台地址: http://127.0.0.1:${config.port}/admin`);
      }
      break;
    }

    case 'tenant:list': {
      const t = store.getInstance();
      if (!t) {
        console.log('还没有初始化，先执行：node cli.js tenant:create "公司名"');
        break;
      }
      const vs = await import('./src/vectors.js');
      const rbac = await import('./src/rbac.js');
      const stats = indexer.getStats(t.id);
      const docs = store.listDocuments(t.id, { limit: 1 }).total;
      const v = vs.vectorStats(t.id);
      console.log('ID\t名称\t文档\t块\t向量\t成员\t数据库');
      console.log(`${t.id}\t${t.name}\t${docs}\t${stats.n_chunks}\t${v.chunks}\t${rbac.memberCount(t.id)}\t${config.database}`);
      console.log('\n单实例部署：一个企业一个数据库文件，用 config.database 或环境变量 KB_DB 指定。');
      break;
    }

    case 'admin:create': {
      const tid = pos[0] || flags.tenant || config.instance.id;
      const email = pos[1] || flags.email;
      if (!email) throw new Error('用法: admin:create [租户ID] <邮箱> [--role admin] [--level 3]');
      const rbac = await import('./src/rbac.js');
      const r = rbac.createMember({
        tenantId: tid,
        email,
        name: flags.name,
        password: flags.password,
        role: flags.role || 'admin',
        level: Number(flags.level) || 3,
        department: flags.department,
        createdBy: 'cli',
        mustChange: !flags.password,
      });
      console.log(`✓ 已创建后台账号 ${r.user.email}`);
      console.log(`  角色 ${r.user.role_name}（${r.user.permissions.join(',')}）`);
      console.log(`  员工等级 L${r.user.level} ${r.user.level_name}`);
      if (!flags.password) console.log(`  初始密码（仅显示一次）: ${r.password}`);
      break;
    }

    case 'admin:list': {
      const tid = pos[0] || flags.tenant || config.instance.id;
      const rbac = await import('./src/rbac.js');
      const items = rbac.listMembers(tid);
      if (!items.length) { console.log('该企业还没有后台账号'); break; }
      console.log('邮箱\t\t姓名\t角色\t等级\t状态\t最近登录');
      for (const m of items) {
        console.log(`${m.email}\t${m.name}\t${m.role}\tL${m.level}\t${m.status}\t${m.last_login_at || '—'}`);
      }
      break;
    }

    case 'admin:reset': {
      const tid = pos[0] || flags.tenant || config.instance.id;
      const email = pos[1];
      if (!email) throw new Error('用法: admin:reset [租户ID] <邮箱>');
      const rbac = await import('./src/rbac.js');
      const found = rbac.findMemberByEmail(email).find((u) => u.tenant_id === tid) || rbac.findMemberByEmail(email)[0];
      if (!found) throw new Error(`该企业下没有这个账号: ${email}`);
      const pwd = flags.password || rbac.randomPassword();
      rbac.updateMember(tid, found.id, { password: pwd, mustChange: true });
      rbac.revokeUserSessions(found.id);
      console.log(`✓ 已重置 ${email} 的密码（所有会话已失效）\n  新密码: ${pwd}`);
      break;
    }

    case 'admin:roles': {
      const rbac = await import('./src/rbac.js');
      console.log('角色\t\t名称\t\t权限');
      for (const [key, r] of Object.entries(rbac.ROLES)) {
        console.log(`${key}\t${r.name}\t${r.perms.join(', ')}`);
      }
      console.log('\n员工等级：');
      for (const l of rbac.LEVELS) console.log(`  L${l.level} ${l.name} — ${l.desc}`);
      break;
    }

    case 'vector:stats':
    case 'vector:rebuild': {
      const vs = await import('./src/vectors.js');
      const tid = flags.tenant || pos[0] || config.instance.id;
      if (cmd === 'vector:rebuild') {
        const r = ingest.reindexTenant(tid || tenantOf(flags));
        console.log(`✓ 已重建：${r.documents} 篇文档 / ${r.chunks} 块 / ${r.vectors} 条向量`);
      }
      const v = vs.vectorStats(tid || tenantOf(flags));
      console.log(`租户 ${tid || tenantOf(flags)}`);
      console.log(`  向量 ${v.chunks} 条，${v.dim} 维，模型 ${v.model || '—'}${v.stale ? '（已过期，需重建）' : ''}`);
      console.log(`  占用 ${(v.bytes / 1048576).toFixed(2)}MB  ${v.file}`);
      break;
    }

    case 'key:create': {
      const tid = pos[0] || flags.tenant || config.instance.id;
      const key = store.createApiKey({
        tenantId: tid,
        name: flags.name,
        scopes: (flags.scopes || 'search,read,write').split(',').map((s) => s.trim()).filter(Boolean),
        rateLimit: flags['rate-limit'],
        expiresAt: flags.expires,
        readerLevel: Number(flags['reader-level']) || 5,
      });
      console.log(`✓ 密钥已创建（仅显示一次）:\n  ${key.plaintext}`);
      console.log(`  scopes: ${key.scopes.join(', ')}  可读等级: L${key.readerLevel}`);
      break;
    }

    case 'key:list': {
      const tid = pos[0] || flags.tenant || config.instance.id;
      for (const k of store.listApiKeys(tid)) {
        console.log(`${k.id}  ${k.key_prefix}  scopes=${JSON.parse(k.scopes).join(',')}  L${k.reader_level}  ${k.revoked_at ? '已吊销' : '有效'}  ${k.name || ''}`);
      }
      break;
    }

    case 'key:revoke': {
      const id = pos[0];
      if (!id) throw new Error('请提供密钥 ID');
      store.revokeApiKey(id);
      console.log(`✓ 已吊销 ${id}`);
      break;
    }

    case 'add': {
      const file = pos[0];
      if (!file) throw new Error('请提供文件路径');
      const abs = resolve(file);
      if (!existsSync(abs)) throw new Error(`文件不存在: ${abs}`);
      const r = ingest.ingestFile(tenantOf(flags), abs, {
        spaceSlug: flags.space,
        tags: flags.tags ? String(flags.tags).split(',').map((s) => s.trim()).filter(Boolean) : [],
        minLevel: Number(flags.level) || 1,
      });
      console.log(`✓ ${r.status}: ${r.title}  ${r.chunkCount} 块 / ${r.charCount} 字${r.reason ? '（' + r.reason + '）' : ''}`);
      break;
    }

    case 'add-dir': {
      const dir = pos[0];
      if (!dir) throw new Error('请提供目录路径');
      const r = ingest.ingestDirectory(tenantOf(flags), resolve(dir), {
        spaceSlug: flags.space,
        tags: flags.tags ? String(flags.tags).split(',').map((s) => s.trim()).filter(Boolean) : [],
      });
      console.log(`✓ 扫描 ${r.total} 个文件：新增 ${r.created}，更新 ${r.updated}，跳过 ${r.skipped}，失败 ${r.failed.length}`);
      for (const f of r.failed.slice(0, 10)) console.log(`  ✗ ${f.file}: ${f.error}`);
      break;
    }

    case 'faq:add': {
      const hasTenant = pos.length >= 3;
      const tid = hasTenant ? pos[0] : config.instance.id;
      const question = hasTenant ? pos[1] : pos[0];
      const ans = hasTenant ? pos[2] : pos[1];
      if (!question || !ans) throw new Error('用法: faq:add ["租户ID"] "问题" "答案"');
      const f = store.createFaq({
        tenantId: tid,
        question,
        answer: ans,
        tags: flags.tags ? String(flags.tags).split(',').map((s) => s.trim()).filter(Boolean) : [],
      });
      console.log(`✓ FAQ 已录入 ${f.id}`);
      break;
    }

    case 'list': {
      const r = store.listDocuments(tenantOf(flags), { limit: flags.limit || 50 });
      console.log(`共 ${r.total} 篇：`);
      for (const d of r.items) {
        console.log(`  ${d.id}  ${d.title}  [${d.space_id}] ${d.chunk_count}块 ${String(d.updated_at).slice(0, 10)}`);
      }
      break;
    }

    case 'delete': {
      const id = pos[0];
      if (!id) throw new Error('请提供文档 ID');
      const r = ingest.deleteDocument(tenantOf(flags), id);
      if (!r) throw new Error(`文档不存在: ${id}`);
      console.log(`✓ 已删除 ${r.title}`);
      break;
    }

    case 'reindex': {
      const tid = pos[0] || flags.tenant || config.instance.id;
      const r = ingest.reindexTenant(tid);
      console.log(`✓ 重建索引：${r.documents} 篇文档 / ${r.chunks} 块`);
      break;
    }

    case 'search': {
      const query = pos.join(' ');
      if (!query) throw new Error('请提供查询词');
      const r = indexer.search(tenantOf(flags), { query, topK: Number(flags.top) || 5 });
      console.log(`「${query}」 命中 ${r.total} 条，耗时 ${r.took_ms}ms\n`);
      for (const h of r.hits) {
        console.log(`[${h.score}] 《${h.doc_title}》${h.heading ? ' / ' + h.heading : ''}`);
        console.log(`    ${h.content.replace(/\n/g, ' ').slice(0, 90)}`);
      }
      break;
    }

    case 'ask': {
      const query = pos.join(' ');
      if (!query) throw new Error('请提供问题');
      const r = await answer.ask({ tenantId: tenantOf(flags), query });
      console.log(`\n${r.answer}\n`);
      console.log(`模式: ${r.mode}  置信度: ${r.confidence}  耗时: ${r.took_ms}ms`);
      if (r.citations?.length) {
        console.log('来源:');
        for (const c of r.citations) {
          console.log(`  ${c.index}. 《${c.doc_title}》${c.heading ? ' / ' + c.heading : ''}`);
        }
      }
      break;
    }

    case 'stats': {
      const tid = tenantOf(flags);
      const s = indexer.getStats(tid);
      const docs = store.listDocuments(tid, { limit: 1 });
      const faqs = store.listFaqs(tid, { limit: 1 });
      const vs = await import('./src/vectors.js');
      const st = await import('./src/storage.js');
      const rbac = await import('./src/rbac.js');
      const v = vs.vectorStats(tid);
      console.log(`租户 ${tid}`);
      console.log(`  文档 ${docs.total} 篇，段落 ${s.n_chunks} 段，FAQ ${faqs.total} 条`);
      console.log(`  平均块长 ${s.avg_len.toFixed(1)} 词`);
      console.log(`  向量 ${v.chunks} 条（${v.dim} 维，${v.model || '未建'}）`);
      console.log(`  原始件 ${st.storageStats(tid).files} 个 / ${st.storageStats(tid).mb}MB`);
      console.log(`  后台账号 ${rbac.memberCount(tid)} 个`);
      for (const sp of store.listSpaces(tid)) {
        console.log(`  空间 ${sp.name}(${sp.slug}) ${sp.doc_count} 篇`);
      }
      break;
    }

    default:
      console.log(`未知命令: ${cmd}\n`);
      console.log(HELP);
  }
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
