import { config } from './config.js';

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/**
 * 把一段文本按段落累积到 maxChars 以内，超长单段硬切。
 */
function packParagraphs(paras, maxChars, out) {
  let cur = '';
  const push = (s) => {
    const t = s.trim();
    if (t) out.push(t);
  };

  for (const raw of paras) {
    const p = raw.trim();
    if (!p) continue;

    if (p.length > maxChars) {
      if (cur) { push(cur); cur = ''; }
      const step = Math.max(50, Math.floor(maxChars * 0.9));
      for (let i = 0; i < p.length; i += step) push(p.slice(i, i + maxChars));
      continue;
    }
    if (!cur) {
      cur = p;
    } else if (cur.length + 1 + p.length <= maxChars) {
      cur += '\n' + p;
    } else {
      push(cur);
      cur = p;
    }
  }
  if (cur) push(cur);
}

/**
 * 按标题层级切分，产出 [{ heading, content }]
 * @param {string} text markdown 或纯文本
 * @param {{maxChars?:number, overlap?:number, title?:string}} opts
 *        title 传文档标题，用于把「首个 H1 就是标题」的情况从 heading 路径里去掉
 */
export function splitText(text, opts = {}) {
  const maxChars = opts.maxChars ?? config.retrieval.maxChunkChars;
  const overlap = opts.overlap ?? config.retrieval.overlapChars;
  const docTitle = String(opts.title || '').trim();

  const src = String(text || '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');

  const stack = []; // [{ level, title }]
  const sections = []; // { heading, titleLine, body: [] }
  let cur = { heading: '', titleLine: '', body: [] };

  // 保留所有层级，只在第一段恰好等于文档标题时剥掉它。
  // 早期版本直接丢掉 H1，导致「用 H1 分章节」的文档所有章节 heading 都变空，
  // 后续按 heading 判断的重叠与合并全都会误伤。
  const headingPath = () => {
    const parts = stack.map((s) => s.title);
    if (docTitle && parts[0] === docTitle) parts.shift();
    return parts.join(' > ');
  };

  for (const line of lines) {
    const m = line.match(HEADING_RE);
    if (m) {
      if (cur.body.some((l) => l.trim())) sections.push(cur);
      const level = m[1].length;
      const title = m[2].trim();
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title });
      cur = { heading: headingPath(), titleLine: title, body: [title] };
      continue;
    }
    cur.body.push(line);
  }
  if (cur.body.some((l) => l.trim())) sections.push(cur);

  const chunks = [];
  for (const sec of sections) {
    const paras = sec.body.join('\n').split(/\n\s*\n/);
    const pieces = [];
    packParagraphs(paras, maxChars, pieces);
    for (const p of pieces) {
      // 整块内容就是标题本身 = 这一节没有任何正文，留着只会污染检索
      if (sec.titleLine && p.trim() === sec.titleLine) continue;
      chunks.push({ heading: sec.heading, content: p });
    }
  }

  // 加重叠：同章节相邻块，后一块前置上一块的尾部若干字符
  if (overlap > 0 && chunks.length > 1) {
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1];
      const cur2 = chunks[i];
      if (prev.heading !== cur2.heading) continue;
      // 上一块本身很短，说明它只是标题行或一句话，搬过来只会制造重复
      if (prev.content.length < Math.max(120, overlap * 2)) continue;
      const tail = prev.content.slice(-overlap);
      const cut = tail.search(/[。！？!?；;\n]/);
      const seam = (cut >= 0 ? tail.slice(cut + 1) : tail).trim();
      if (!seam || cur2.content.includes(seam)) continue;
      cur2.content = `${seam}\n${cur2.content}`;
    }
  }

  // 短块合并：小于 60 字且同章节，与上一块合并，避免碎片污染检索
  const merged = [];
  for (const c of chunks) {
    const last = merged[merged.length - 1];
    if (last && last.heading === c.heading && last.content.length < 60 && last.content.length + c.content.length <= maxChars) {
      last.content += `\n${c.content}`;
    } else {
      merged.push({ ...c });
    }
  }

  // 丢弃「只有标题没有正文」的块，这类块会污染检索结果
  return merged.filter((c) => {
    const text = c.content.trim();
    if (!text) return false;
    const firstLine = text.split('\n')[0].trim();
    const leafHeading = (c.heading || '').split(' > ').pop();
    if (leafHeading && firstLine === leafHeading) {
      const rest = text.split('\n').slice(1).join('').trim();
      return rest.length >= 15;
    }
    return text.length >= 12;
  });
}

/** 纯文本无标题时，按空行 + 长度切分，给每块一个「第 N 段」标注 */
export function splitPlain(text, opts = {}) {
  const chunks = splitText(text, opts);
  return chunks.map((c, i) => (c.heading ? c : { ...c, heading: `片段 ${i + 1}` }));
}
