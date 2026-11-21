import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { extname, basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';

// ---------- 通用转义 ----------
function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

function unescapeHtml(s) {
  return unescapeXml(s).replace(/&nbsp;/g, ' ');
}

function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, '');
}

// ---------- ZIP（docx 是 zip 包） ----------
function readZipEntries(buf) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 docx/zip 文件（未找到目录结构）');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.set(name, { method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntry(buf, e) {
  const lo = e.localOff;
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('zip 本地头损坏');
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return data;
  if (e.method === 8) return inflateRawSync(data);
  throw new Error(`不支持的 zip 压缩方式: ${e.method}`);
}

// ---------- DOCX ----------
export function parseDocxBuffer(buf) {
  const entries = readZipEntries(buf);
  const target = entries.get('word/document.xml');
  if (!target) throw new Error('docx 内缺少 word/document.xml');
  const xml = readZipEntry(buf, target).toString('utf8');

  const paras = xml.split('</w:p>');
  const lines = [];
  for (const p of paras) {
    const texts = [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map((m) => unescapeXml(m[1]))
      .join('');
    const t = texts.replace(/\u00a0/g, ' ').trim();
    if (!t) continue;

    const styleM = p.match(/<w:pStyle\s+w:val="([^"]+)"/);
    const style = styleM ? styleM[1] : '';
    const hm = style.match(/^Heading(\d)$/i) || style.match(/^(\d)$/);
    if (hm) {
      const lv = Math.min(6, Math.max(1, Number(hm[1])));
      lines.push(`${'#'.repeat(lv)} ${t}`);
    } else if (/^Title$/i.test(style)) {
      lines.push(`# ${t}`);
    } else if (/^Subtitle$/i.test(style)) {
      lines.push(`## ${t}`);
    } else if (/^(ListParagraph|List)/i.test(style)) {
      lines.push(`- ${t}`);
    } else {
      lines.push(t);
    }
  }
  return lines.join('\n\n');
}

// ---------- HTML ----------
export function parseHtml(html) {
  let s = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '');

  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lv, inner) => {
    const txt = stripTags(inner).replace(/\s+/g, ' ').trim();
    return txt ? `\n\n${'#'.repeat(Number(lv))} ${txt}\n\n` : '\n';
  });
  s = s.replace(/<li[^>]*>/gi, '\n- ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|tr|ul|ol|table|blockquote|pre)>/gi, '\n\n');
  s = s.replace(/<td[^>]*>/gi, ' ');
  s = stripTags(s);
  s = unescapeHtml(s);
  return s
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- PPTX（同样是 zip，取每页的文字） ----------
export function parsePptxBuffer(buf) {
  const entries = readZipEntries(buf);
  const slides = [...entries.keys()]
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));
  if (!slides.length) throw new Error('pptx 内没有找到幻灯片');

  const out = [];
  slides.forEach((name, i) => {
    const xml = readZipEntry(buf, entries.get(name)).toString('utf8');
    // 每个 <a:p> 是一个段落，段内多个 <a:t> 拼起来才是整句
    const paras = xml
      .split('</a:p>')
      .map((p) => [...p.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((m) => unescapeXml(m[1])).join(''))
      .map((t) => t.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (!paras.length) return;
    const page = i + 1;
    // 首页第一段通常是标题，提成章标题便于检索时定位
    out.push(`## 第 ${page} 页\n\n${paras.join('\n\n')}`);
  });

  if (!out.length) throw new Error('pptx 解析后无文字内容（可能全是图片）');
  return out.join('\n\n');
}

// ---------- XLSX（sharedStrings + 各 sheet 转 markdown 表） ----------
const XLSX_MAX_ROWS = 800;

function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function mdCell(v) {
  return String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/** 把二维数组渲染成 markdown 表格；首行当表头 */
export function rowsToMarkdown(rows, { maxRows = XLSX_MAX_ROWS } = {}) {
  if (!rows.length) return '';
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  if (!width) return '';
  const norm = rows.map((r) => Array.from({ length: width }, (_, i) => mdCell(r[i])));
  const head = norm[0];
  const body = norm.slice(1, maxRows + 1);
  const lines = [
    `| ${head.join(' | ')} |`,
    `| ${new Array(width).fill('---').join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ];
  if (rows.length - 1 > maxRows) {
    lines.push(`\n（表格共 ${rows.length - 1} 行，此处展示前 ${maxRows} 行）`);
  }
  return lines.join('\n');
}

export function parseXlsxBuffer(buf) {
  const entries = readZipEntries(buf);

  // 共享字符串表
  const shared = [];
  const ssEntry = entries.get('xl/sharedStrings.xml');
  if (ssEntry) {
    const xml = readZipEntry(buf, ssEntry).toString('utf8');
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push(
        [...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((x) => unescapeXml(x[1])).join(''),
      );
    }
  }

  // 工作表名：workbook.xml 的 sheet(name, r:id) + rels 映射到文件
  const nameByRid = new Map();
  const wbEntry = entries.get('xl/workbook.xml');
  if (wbEntry) {
    const xml = readZipEntry(buf, wbEntry).toString('utf8');
    for (const m of xml.matchAll(/<sheet\b[^>]*>/g)) {
      const name = /\bname="([^"]*)"/.exec(m[0]);
      const rid = /\br:id="([^"]*)"/.exec(m[0]);
      if (name && rid) nameByRid.set(rid[1], unescapeXml(name[1]));
    }
  }
  const targetByRid = new Map();
  const relEntry = entries.get('xl/_rels/workbook.xml.rels');
  if (relEntry) {
    const xml = readZipEntry(buf, relEntry).toString('utf8');
    for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = /\bId="([^"]*)"/.exec(m[0]);
      const tgt = /\bTarget="([^"]*)"/.exec(m[0]);
      if (id && tgt) {
        let t = unescapeXml(tgt[1]);
        t = t.replace(/^\/?xl\//, '').replace(/^\//, '');
        targetByRid.set(id[1], `xl/${t}`);
      }
    }
  }

  const targets = [];
  for (const [rid, name] of nameByRid) {
    const p = targetByRid.get(rid);
    if (p && entries.has(p)) targets.push({ name, path: p });
  }
  if (!targets.length) {
    [...entries.keys()]
      .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')))
      .forEach((p, i) => targets.push({ name: `工作表 ${i + 1}`, path: p }));
  }
  if (!targets.length) throw new Error('xlsx 内没有找到工作表');

  const out = [];
  for (const t of targets) {
    const xml = readZipEntry(buf, entries.get(t.path)).toString('utf8');
    const rows = [];
    for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= XLSX_MAX_ROWS + 1) break;
      const cells = [];
      for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1] || '';
        const inner = cm[2] || '';
        const ref = (/\br="([A-Z]+)\d+"/.exec(attrs) || [])[1] || '';
        const type = (/\bt="([^"]+)"/.exec(attrs) || [])[1] || 'n';
        let v = '';
        if (type === 's') {
          const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
          v = vm ? (shared[Number(vm[1])] ?? '') : '';
        } else if (type === 'inlineStr') {
          v = [...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((x) => unescapeXml(x[1])).join('');
        } else {
          const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
          v = vm ? unescapeXml(vm[1]) : '';
        }
        const idx = ref ? colIndex(ref) : cells.length;
        if (idx >= 0) cells[idx] = v;
      }
      if (cells.some((c) => c != null && String(c).trim() !== '')) rows.push(cells);
    }
    const table = rowsToMarkdown(rows);
    if (table) out.push(`## ${t.name}\n\n${table}`);
  }

  if (!out.length) throw new Error('xlsx 解析后无文字内容');
  return out.join('\n\n');
}

// ---------- CSV ----------
export function parseCsvText(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\n') {
      row.push(field); field = '';
      if (row.some((c) => String(c).trim() !== '')) rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  row.push(field);
  if (row.some((c) => String(c).trim() !== '')) rows.push(row);

  const table = rowsToMarkdown(rows);
  if (!table) throw new Error('CSV 为空');
  return table;
}

// ---------- PDF（依赖外部能力，缺失时明确报错） ----------
function tryCommand(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

export function parsePdf(filePath) {
  const viaPoppler = tryCommand('pdftotext', ['-layout', '-enc', 'UTF-8', filePath, '-']);
  if (viaPoppler && viaPoppler.trim()) return viaPoppler.trim();

  const script = `
import sys
try:
    from pypdf import PdfReader
except ImportError:
    try:
        from PyPDF2 import PdfReader
    except ImportError:
        sys.exit(3)
r = PdfReader(sys.argv[1])
out = []
for p in r.pages:
    try:
        out.append(p.extract_text() or '')
    except Exception:
        pass
print('\\n\\n'.join(out))
`;
  for (const py of ['python', 'python3']) {
    const res = tryCommand(py, ['-c', script, filePath]);
    if (res && res.trim()) return res.trim();
  }

  throw new Error(
    'PDF 解析需要外部工具：请安装 poppler(pdftotext) 或执行 `python -m pip install pypdf`，也可先转成 docx/md 再入库',
  );
}

// ---------- PDF 内置抽取（不依赖外部工具，覆盖文本型 PDF） ----------
function decodePdfString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\') { out += ch; continue; }
    const nx = raw[++i];
    if (nx === 'n') out += '\n';
    else if (nx === 'r') out += '\r';
    else if (nx === 't') out += '\t';
    else if (nx === 'b' || nx === 'f') out += '';
    else if (nx === '(' || nx === ')' || nx === '\\') out += nx;
    else if (nx >= '0' && nx <= '7') {
      let oct = nx;
      while (oct.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else out += nx || '';
  }
  return out;
}

/** 从内容流里取字面串，遇 Td/TD/ET 断行 */
function extractTextOps(s) {
  const lines = [];
  let cur = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '(') {
      let depth = 1;
      let j = i + 1;
      let raw = '';
      while (j < s.length && depth > 0) {
        const c = s[j];
        if (c === '\\') { raw += c + (s[j + 1] ?? ''); j += 2; continue; }
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (!depth) break; }
        raw += c;
        j++;
      }
      cur += decodePdfString(raw);
      i = j + 1;
      continue;
    }
    if (ch === 'T' && (s[i + 1] === 'd' || s[i + 1] === 'D')) {
      if (cur) { lines.push(cur); cur = ''; }
      i += 2;
      continue;
    }
    if (ch === 'E' && s[i + 1] === 'T') {
      if (cur) { lines.push(cur); cur = ''; }
      i += 2;
      continue;
    }
    if (ch === 'T' && s[i + 1] === '*') {
      if (cur) { lines.push(cur); cur = ''; }
      i += 2;
      continue;
    }
    i++;
  }
  if (cur) lines.push(cur);
  return lines.map((l) => l.trim()).filter(Boolean).join('\n');
}

export function extractPdfTextBuiltin(buf) {
  const pieces = [];
  let pos = 0;
  while (pos < buf.length) {
    const i = buf.indexOf('stream', pos, 'latin1');
    if (i < 0) break;
    let start = i + 6;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;
    const j = buf.indexOf('endstream', start, 'latin1');
    if (j < 0) break;
    let data = buf.subarray(start, j);
    try { data = inflateSync(data); } catch { /* 未压缩流，原样使用 */ }
    const piece = extractTextOps(data.toString('latin1'));
    if (piece) pieces.push(piece);
    pos = j + 9;
  }
  return pieces.join('\n\n');
}

/** 可打印字符占比：判断抽出来的是真文本还是 CID 乱码 */
function textQuality(s) {
  if (!s) return 0;
  let good = 0;
  let n = 0;
  for (const ch of s) {
    n++;
    const c = ch.codePointAt(0);
    if (c === 9 || c === 10 || (c >= 32 && c <= 126) || (c >= 0x4e00 && c <= 0x9fff)) good++;
  }
  return n ? good / n : 0;
}

/**
 * PDF 解析（从内存 buffer）
 * 1. 先试内置抽取（快、无依赖，适合文本型 PDF）
 * 2. 质量不够（扫描件 / CID 编码中文）时落临时文件交给 pdftotext 或 pypdf
 * 3. 都失败则抛错，由上层把文档标记为 parse_status=failed，原始件仍然保留
 */
export function parsePdfBuffer(buf) {
  const builtin = extractPdfTextBuiltin(buf);
  if (builtin.length >= 30 && textQuality(builtin) >= 0.85) return builtin;

  const tmp = join(tmpdir(), `kb-pdf-${process.pid}-${Date.now()}.pdf`);
  writeFileSync(tmp, buf);
  try {
    return parsePdf(tmp);
  } finally {
    try { unlinkSync(tmp); } catch { /* 临时文件清理失败不影响结果 */ }
  }
}

// ---------- 统一入口 ----------
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.text', '.log', '.json', '.yaml', '.yml']);

export function detectType(filename) {
  const ext = extname(filename || '').toLowerCase();
  if (ext === '.docx') return 'docx';
  if (ext === '.pptx') return 'pptx';
  if (ext === '.xlsx') return 'xlsx';
  if (ext === '.csv') return 'csv';
  if (ext === '.md' || ext === '.markdown') return 'md';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.pdf') return 'pdf';
  if (TEXT_EXT.has(ext)) return 'txt';
  if (ext === '.doc' || ext === '.ppt' || ext === '.xls') return 'legacy-unsupported';
  return 'txt';
}

/** 支持解析的扩展名（上传接口据此做白名单提示，非硬拦截） */
export const SUPPORTED_EXTENSIONS = [
  '.md', '.markdown', '.txt', '.log', '.json', '.yaml', '.yml', '.csv',
  '.html', '.htm', '.docx', '.pptx', '.xlsx', '.pdf',
];

function stripExt(name) {
  return basename(String(name || '')).replace(/\.[^.]+$/, '') || '未命名文档';
}

/**
 * 从 buffer 解析（上传接口用，不落临时文件）
 * @returns {{text:string, docType:string, title:string}}
 */
export function parseBuffer(buffer, filename) {
  const docType = detectType(filename);
  const title = stripExt(filename);

  if (docType === 'docx') return { text: parseDocxBuffer(buffer), docType, title };
  if (docType === 'pptx') return { text: parsePptxBuffer(buffer), docType, title };
  if (docType === 'xlsx') return { text: parseXlsxBuffer(buffer), docType, title };
  if (docType === 'pdf') return { text: parsePdfBuffer(buffer), docType, title };
  if (docType === 'legacy-unsupported') {
    throw new Error('不支持旧版 .doc/.ppt/.xls，请另存为 .docx/.pptx/.xlsx 后再上传');
  }

  const raw = buffer.toString('utf8');
  if (docType === 'csv') return { text: parseCsvText(raw), docType, title };
  if (docType === 'html') return { text: parseHtml(raw), docType, title };
  return { text: raw, docType, title };
}

/**
 * 解析本地文件
 * @returns {{text:string, docType:string, title:string}}
 */
export function parseFile(filePath) {
  if (!existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);
  const docType = detectType(filePath);
  if (docType === 'pdf') {
    return { text: parsePdfBuffer(readFileSync(filePath)), docType, title: stripExt(filePath) };
  }
  if (docType === 'legacy-unsupported') {
    throw new Error('不支持旧版 .doc/.ppt/.xls，请另存为 .docx/.pptx/.xlsx 后再入库');
  }
  return parseBuffer(readFileSync(filePath), filePath);
}

/** 从 markdown 正文推断标题（首个 h1，否则首行） */
export function guessTitle(text, fallback = '未命名文档') {
  const m = String(text).match(/^#\s+(.+)$/m);
  if (m) return m[1].trim();
  const first = String(text).split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  if (first) return first.slice(0, 60);
  return fallback;
}
