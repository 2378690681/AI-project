// 中文 bigram + 英文词 分词器
// 不引入词典的原因：企业知识库的领域词汇（内部系统名、产品代号）任何开源词典都覆盖不好，
// bigram 对中文的召回率天然优于词典分词，且零维护成本。
// 代价是 term 数量约为字数的 1 倍，靠 BM25 的 idf 自然压制噪声。

import { applySynonyms } from './synonyms.js';

const ZH_STOP = new Set([
  '的了', '了一', '是的', '是在', '我们', '你们', '他们', '她们', '它们',
  '这个', '那个', '这些', '那些', '这样', '那样', '这里', '那里',
  '怎么', '如何', '什么', '哪些', '是否', '可以', '一个', '一下',
  '以及', '还是', '就是', '如果', '因为', '所以', '但是', '而且', '并且',
  '或者', '不是', '没有', '已经', '对于', '关于', '根据', '由于', '其中',
  '等等', '而言', '来说', '的话', '一些', '一次', '一样', '一直',
]);

const ZH_STOP_SINGLE = new Set([
  '的', '了', '是', '在', '和', '与', '及', '等', '有', '我', '你', '他',
  '她', '它', '这', '那', '就', '都', '而', '也', '吧', '吗', '呢', '啊',
  '把', '被', '给', '对', '为', '以', '于', '从', '到', '个', '们', '之',
  '上', '下', '中', '内', '外', '前', '后', '所', '其',
]);

// 只能出现在词尾的虚词：用来掐掉 "份的" / "程是" 这类跨词 bigram
const TAIL_STOP = new Set('的了是在和与及等把被就都而也吗呢吧啊之');
// 只能出现在词首的虚词
const HEAD_STOP = new Set('的了是');

const EN_STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with',
  'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'this', 'that', 'these', 'those', 'it', 'its', 'we', 'you', 'they',
  'not', 'no', 'but', 'if', 'then', 'than', 'so', 'such', 'can', 'will',
  'has', 'have', 'had', 'do', 'does', 'did', 'how', 'what', 'which', 'who',
  'when', 'where', 'why', 'all', 'any', 'some', 'more', 'most', 'other',
]);

/** 全角转半角 + 小写 */
export function normalize(text) {
  let s = String(text ?? '');
  s = s.replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = s.replace(/\u3000/g, ' ');
  return s.toLowerCase();
}

/**
 * 分词，返回 Map<term, tf>
 */
export function tokenize(text) {
  const s = applySynonyms(normalize(text));
  const counts = new Map();
  const add = (t, w = 1) => {
    if (!t) return;
    counts.set(t, (counts.get(t) || 0) + w);
  };

  for (const m of s.matchAll(/[a-z0-9][a-z0-9_+#'\-.]*/g)) {
    const w = m[0].replace(/[.'\-]+$/g, '');
    if (!w) continue;
    if (w.length < 2 && !/^\d$/.test(w)) continue;
    if (EN_STOP.has(w)) continue;
    add(w);
  }

  for (const m of s.matchAll(/[\u4e00-\u9fff]+/g)) {
    const seg = m[0];
    if (seg.length === 1) {
      if (!ZH_STOP_SINGLE.has(seg)) add(seg);
      continue;
    }
    for (let i = 0; i + 1 < seg.length; i++) {
      const bg = seg.slice(i, i + 2);
      if (ZH_STOP.has(bg)) continue;
      if (TAIL_STOP.has(bg[1]) || HEAD_STOP.has(bg[0])) continue;
      add(bg);
    }
  }

  return counts;
}

/** 只取词表（查询侧用） */
export function termsOf(text) {
  return [...tokenize(text).keys()];
}

/** 中文按句切分（抽取式摘要 / 切块用） */
export function splitSentences(text) {
  const out = [];
  const s = String(text ?? '').replace(/\r\n?/g, '\n');
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    buf += ch;
    if (ch === '\n' || '。！？!?；;'.includes(ch)) {
      const t = buf.trim();
      if (t) out.push(t);
      buf = '';
    }
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}
