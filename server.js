import { initAll } from './src/bootstrap.js';

const boot = await initAll();
const { createApp } = await import('./src/api.js');
const { config } = await import('./src/config.js');
const { getDb } = await import('./src/db.js');

getDb();

const app = createApp();
const shown = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;

app.listen(config.port, config.host, () => {
  console.log('');
  console.log('  企业外置知识库 · KB Hub（单实例）');
  console.log(`  ├─ 服务地址   http://${shown}:${config.port}`);
  console.log(`  ├─ 管理后台   http://${shown}:${config.port}/admin`);
  console.log(`  ├─ 检索控制台 http://${shown}:${config.port}/console`);
  console.log(`  ├─ 企业       ${config.instance.name} (${config.instance.id})`);
  console.log(`  ├─ 数据库     ${config.database}`);
  console.log(`  ├─ 原件目录   ${config.filesDir}`);
  console.log(`  ├─ 管理根密钥 ${config.rootKey ? config.rootKey.slice(0, 14) + '…' : '(未配置)'}`);
  console.log(`  └─ 配置文件   ${boot.path}${boot.created ? '  ← 本次新建' : ''}`);
  if (boot.created) {
    console.log('');
    console.log('  ⚠ 首次启动已生成 config.json，管理根密钥保存在其中，请妥善保管。');
  }
  console.log('');
});

app.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`✗ 端口 ${config.port} 已被占用，请修改 config.json 的 port 或设置环境变量 KB_PORT`);
  } else {
    console.error('✗ 服务启动失败:', e.message);
  }
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n· 正在关闭服务…');
    app.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
