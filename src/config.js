import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, '..');

function loadFileConfig() {
  const p = process.env.KB_CONFIG || join(ROOT, 'config.json');
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`config.json 解析失败: ${e.message}`);
  }
}

const file = loadFileConfig();
const env = process.env;

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** 实例 ID 只允许安全字符，避免拼进路径时出问题 */
function safeId(v, fallback) {
  const s = String(v || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
  return s || fallback;
}

const dataDir = resolve(ROOT, env.KB_DATA_DIR || file.dataDir || 'data');

// 单实例：一个企业一套服务，数据库文件由配置指定（可用 KB_DB 覆盖）。
// 不再有 data/tenants/<id>/ 这层，也不再有租户注册表。
// 用 getter 而不是常量：脚本（如评测）可以在 import 之后设置 KB_DB，
// 只要第一次打开数据库之前设置就生效，方便用一份独立库做实验。
const resolveDb = () => resolve(ROOT, env.KB_DB || file.database || join(dataDir, 'kb.db'));

export const config = {
  host: env.KB_HOST || file.host || '127.0.0.1',
  port: num(env.KB_PORT || file.port, 7300),

  // 这套服务代表哪个企业（只用于展示与数据标记，不再有多租户切换）
  instance: {
    id: safeId(env.KB_INSTANCE_ID || file.instance?.id, 'default'),
    name: env.KB_INSTANCE_NAME || file.instance?.name || '企业知识库',
    // 从旧的多租户目录升级时优先搬哪个租户的数据；不填则自动选文档最多的
    legacyTenant: file.instance?.legacyTenant || env.KB_LEGACY_TENANT || '',
  },

  dataDir,
  get database() {
    return resolveDb();
  },
  filesDir: resolve(dataDir, 'files'),
  /** @deprecated 保留给旧调用点，等价于 database */
  get dbPath() {
    return this.database;
  },

  // 管理根密钥：调用 /v1/admin/* 用，不分配给任何租户
  rootKey: env.KB_ROOT_KEY || file.rootKey || '',

  retrieval: {
    topK: num(file.retrieval?.topK, 8),
    minScore: num(file.retrieval?.minScore, 0.1),
    maxChunkChars: num(file.retrieval?.maxChunkChars, 700),
    overlapChars: num(file.retrieval?.overlapChars, 80),
    bm25K1: num(file.retrieval?.bm25K1, 1.2),
    bm25B: num(file.retrieval?.bm25B, 0.75),
    titleBoost: num(file.retrieval?.titleBoost, 2.0),
    // 相对分数下限：低于最高分这个比例的命中直接丢弃，压制长尾噪声
    relativeFloor: num(file.retrieval?.relativeFloor, 0.1),
    // 混合检索权重：词法占大头（精确匹配优先），向量负责补召回
    lexicalWeight: num(file.retrieval?.lexicalWeight, 0.7),
    vectorWeight: num(file.retrieval?.vectorWeight, 0.3),
    // 向量余弦低于该值视为噪声，不进入候选（0 表示不做过滤）
    minCosine: num(file.retrieval?.minCosine, 0.12),
  },

  // 向量化：默认本地确定性哈希向量；配置 baseUrl + model 后走真实 embedding 接口
  embeddings: {
    baseUrl: env.KB_EMBED_BASE_URL || file.embeddings?.baseUrl || '',
    apiKey: env.KB_EMBED_API_KEY || file.embeddings?.apiKey || '',
    model: env.KB_EMBED_MODEL || file.embeddings?.model || '',
    dim: num(env.KB_EMBED_DIM || file.embeddings?.dim, 768),
    timeoutMs: num(file.embeddings?.timeoutMs, 20000),
  },

  // 后台会话
  session: {
    ttlHours: num(file.session?.ttlHours, 12),
    cookieName: file.session?.cookieName || 'kb_admin_sid',
    // 生产环境走 HTTPS 时置 true
    secure: Boolean(file.session?.secure),
  },

  // 可选：配置后 /v1/ask 从"抽取式"升级为"生成式 RAG"
  llm: {
    baseUrl: env.KB_LLM_BASE_URL || file.llm?.baseUrl || '',
    apiKey: env.KB_LLM_API_KEY || file.llm?.apiKey || '',
    model: env.KB_LLM_MODEL || file.llm?.model || '',
    timeoutMs: num(file.llm?.timeoutMs, 30000),
  },

  cors: file.cors ?? '*',
  defaultRateLimit: num(file.defaultRateLimit, 120),
  maxBodyBytes: num(file.maxBodyBytes, 32 * 1024 * 1024),
};

export function llmEnabled() {
  return Boolean(config.llm.baseUrl && config.llm.apiKey && config.llm.model);
}
