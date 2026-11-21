/**
 * 模拟 embedding 服务 —— 只用于验证「远程向量模型」这条链路是否真的通。
 *
 * 它不是模型，只是一个把「同义说法」映射到同一组概念维度的规则向量器：
 *   酒店 / 住宿 / 住一晚 → 同一个概念维
 *   打回 / 到账 / 打款   → 同一个概念维
 * 这样可以在没有 API Key、没有外网的情况下，
 * 端到端证明：配置 embeddings 后，换词提问确实能被向量召回。
 *
 * 用法：
 *   node scripts/mock-embed-server.js            # 默认 7799 端口
 *   KB_EMBED_BASE_URL=http://127.0.0.1:7799 KB_EMBED_MODEL=mock-semantic KB_EMBED_DIM=96 \
 *     node scripts/eval-retrieval.js
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_EMBED_PORT || 7799);
const DIM = Number(process.env.MOCK_EMBED_DIM || 96);

const CONCEPTS = [
  ['住宿', ['住宿', '酒店', '住一晚', '宾馆', '房费', '每晚']],
  ['到账', ['到账', '打回', '打款', '退款', '退钱', '多久', '几个工作日', '银行卡']],
  ['审批', ['审批', '签字', '批准', '复核', '负责人', '总经理']],
  ['金额', ['金额', '大件', '五万', '预算', '限额', '多少钱']],
  ['网盘', ['网盘', '云盘', '个人存储', '自己的网盘']],
  ['远程', ['远程', '在家上班', '居家办公', '在家办公', '远程办公']],
  ['报销', ['报销', '发票', '差旅', '票据', '抬头']],
  ['年假', ['年假', '带薪', '休假', '留到明年']],
  ['病假', ['病假', '医院', '证明', '病休']],
  ['加班', ['加班', '调休', '补休']],
  ['报修', ['报修', '坏了', '开不了机', '故障', '维修']],
  ['VPN', ['vpn', '令牌', '远程接入', '网关']],
  ['打印', ['打印', '打印机', '彩色']],
  ['供应商', ['供应商', '名录', '合格供方']],
  ['试用期', ['试用期', '转正', '答辩']],
  ['离职', ['离职', '交接', '提前多少天']],
  ['保密', ['保密', '客户资料', '数据分级', '禁止外传']],
  ['会议室', ['会议室', '预订', '工位']],
  ['补贴', ['补贴', '通讯', '交通', '补助']],
  ['折旧', ['折旧', '固定资产', '年限']],
  ['备份', ['备份', '恢复', '保留多久']],
];

function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function embed(text) {
  const s = String(text || '').toLowerCase();
  const v = new Float32Array(DIM);
  CONCEPTS.forEach(([, words], idx) => {
    for (const w of words) {
      let at = 0;
      while ((at = s.indexOf(w, at)) >= 0) {
        v[idx] += 1;
        at += w.length;
      }
    }
  });
  // 字面兜底：保证完全没见过概念词的文本也有可区分的向量
  for (let i = 0; i < s.length; i++) {
    const h = fnv(s.slice(i, i + 2));
    v[32 + (h % (DIM - 32))] += 0.15;
  }
  let n = 0;
  for (let i = 0; i < DIM; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n) for (let i = 0; i < DIM; i++) v[i] /= n;
  return [...v];
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', dim: DIM, concepts: CONCEPTS.length }));
    return;
  }
  if (req.method !== 'POST' || !req.url.startsWith('/embeddings')) {
    res.writeHead(404).end();
    return;
  }
  let buf = '';
  req.on('data', (c) => { buf += c; });
  req.on('end', () => {
    try {
      const body = JSON.parse(buf || '{}');
      const input = Array.isArray(body.input) ? body.input : [body.input ?? ''];
      const data = input.map((t, index) => ({ object: 'embedding', index, embedding: embed(t) }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', model: body.model || 'mock-semantic', data }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message } }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock embedding 服务已启动 http://127.0.0.1:${PORT}  (dim=${DIM})`);
});
