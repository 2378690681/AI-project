// 企业项目对接示例（Node 22+，无需任何依赖）
// 用法：
//   KB_BASE_URL=http://127.0.0.1:7300 KB_API_KEY=kb_live_xxx node examples/node-client.js "怎么申请发票"

const BASE = (process.env.KB_BASE_URL || 'http://127.0.0.1:7300').replace(/\/+$/, '');
const KEY = process.env.KB_API_KEY || '';

class KbClient {
  constructor({ base = BASE, key = KEY, timeoutMs = 30000, maxRetries = 2 } = {}) {
    if (!key) throw new Error('缺少 KB_API_KEY');
    this.base = base;
    this.key = key;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
  }

  async #request(method, path, body) {
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await fetch(this.base + path, {
          method,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.key}`,
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: ctrl.signal,
        });

        // 429 / 5xx 做指数退避
        if (res.status === 429 || res.status >= 500) {
          const retryAfter = Number(res.headers.get('retry-after'));
          const wait = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 2 ** attempt * 500;
          lastErr = new Error(`HTTP ${res.status}`);
          if (attempt < this.maxRetries) {
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          throw lastErr;
        }

        const text = await res.text();
        const data = text ? JSON.parse(text) : {};
        if (!res.ok) {
          // 4xx 不重试，直接抛出可读错误
          const err = new Error(data?.error?.message || `HTTP ${res.status}`);
          err.code = data?.error?.code;
          err.status = res.status;
          err.requestId = res.headers.get('x-request-id');
          throw err;
        }
        return data;
      } catch (e) {
        lastErr = e;
        if (e.status && e.status < 500) throw e;
        if (attempt >= this.maxRetries) throw e;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  /** 检索原文片段 */
  search(query, { spaceId, topK = 8, tags } = {}) {
    return this.#request('POST', '/v1/search', {
      query,
      space_id: spaceId,
      top_k: topK,
      tags,
    });
  }

  /** 问答，返回带引用的答案 */
  ask(query, { spaceId, topK } = {}) {
    return this.#request('POST', '/v1/ask', { query, space_id: spaceId, top_k: topK });
  }

  /** 文档入库（幂等） */
  ingest({ title, content, space, tags, sourceUri, visibility, allowedRoles }) {
    return this.#request('POST', '/v1/documents', {
      title,
      content,
      space,
      tags,
      source_uri: sourceUri,
      visibility,
      allowed_roles: allowedRoles,
    });
  }

  /** 上传本地文件（docx / md / html / txt），读成 base64 走接口 */
  async ingestFileBuffer(buffer, filename, { space, tags } = {}) {
    return this.#request('POST', '/v1/documents', {
      filename,
      file_base64: buffer.toString('base64'),
      space,
      tags,
    });
  }

  listDocuments(params = {}) {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]),
    );
    return this.#request('GET', `/v1/documents?${qs}`);
  }

  meta() {
    return this.#request('GET', '/v1/meta');
  }
}

// ---------------- 接入业务系统时的典型用法 ----------------
async function answerCustomerQuestion(question) {
  const kb = new KbClient();
  const r = await kb.ask(question);

  // mode 决定怎么给用户展示，这是最容易被忽略但最重要的一步
  switch (r.mode) {
    case 'faq':
    case 'llm':
      return { reply: r.answer, sources: r.citations, confident: true };

    case 'extractive':
      return {
        reply: `（以下为知识库原文摘录）\n${r.answer}`,
        sources: r.citations,
        confident: r.confidence > 0.6,
      };

    case 'empty':
    default:
      // 知识库没收录时不要放模型自由发挥，转人工或引导补充
      return {
        reply: '这个问题知识库暂未收录，已为你转接人工客服。',
        sources: [],
        confident: false,
        needHuman: true,
      };
  }
}

// ---------------- CLI 直跑 ----------------
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const question = process.argv.slice(2).join(' ') || '知识库能做什么';
  answerCustomerQuestion(question)
    .then((r) => {
      console.log(`\n${r.reply}\n`);
      if (r.sources?.length) {
        console.log('来源：');
        for (const c of r.sources) console.log(`  ${c.index}. 《${c.doc_title}》${c.heading ? ' / ' + c.heading : ''}`);
      }
      if (r.needHuman) console.log('（需转人工）');
    })
    .catch((e) => {
      console.error('调用失败:', e.message, e.requestId ? `(request_id: ${e.requestId})` : '');
      process.exit(1);
    });
}

export { KbClient, answerCustomerQuestion };
