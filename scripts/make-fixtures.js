/**
 * 生成真实的 Office/PDF 测试件并立即用项目解析器验证。
 *
 * 为什么自己拼 zip：项目坚持零依赖，测试件也不该依赖 python-docx / openpyxl。
 * 这里手写 store 方式（不压缩）的 zip 写入器，产出的是 Word / Excel / PPT 能打开的合法包，
 * 同时也能反向验证 parsers.js 的 zip 读取逻辑。
 *
 * 用法：node scripts/make-fixtures.js
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  parseDocxBuffer, parsePptxBuffer, parseXlsxBuffer, parsePdfBuffer, parseCsvText,
} from '../src/parsers.js';

const OUT = resolve(process.cwd(), 'tmp-fixtures');

// ---------- 最小 zip 写入器 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function zipStore(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    lh.writeUInt16LE(0, 8);      // store
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    localParts.push(lh, name, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centralParts.push(ch, name);

    offset += 30 + name.length + data.length;
  }

  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, central, eocd]);
}

// ---------- 各格式样本 ----------
function buildDocx() {
  const p = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const body = [
    p('差旅报销制度', 'Title'),
    p('一、适用范围', 'Heading1'),
    p('本制度适用于公司全体正式员工与实习生，外包人员按合同约定执行。'),
    p('二、报销标准', 'Heading1'),
    p('住宿标准', 'Heading2'),
    p('一线城市每晚不超过 600 元，二线城市每晚不超过 400 元，其他城市每晚不超过 300 元。'),
    p('市内交通', 'Heading2'),
    p('单次不超过 100 元，超出部分需部门负责人签字说明原因。'),
    p('三、审批流程', 'Heading1'),
    p('员工在 OMS 系统提交报销单，经直属主管、部门负责人、财务三方审批后，7 个工作日内到账。'),
  ].join('');

  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;

  return zipStore([
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>` },
    { name: 'word/document.xml', data: xml },
  ]);
}

function buildPptx() {
  const slide = (paras) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${paras
    .map((t) => `<p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`)
    .join('')}</p:spTree></p:cSld></p:sld>`;

  return zipStore([
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>` },
    { name: 'ppt/slides/slide1.xml', data: slide(['2026 年 Q3 产品路线图', '本季度聚焦三个方向：检索质量、企业接入、移动端体验']) },
    { name: 'ppt/slides/slide2.xml', data: slide(['关键里程碑', '9 月完成混合检索上线', '10 月开放 MCP 插件', '11 月支持飞书文档同步']) },
    { name: 'ppt/slides/slide10.xml', data: slide(['风险提示', '第三方接口限流可能导致同步延迟，需提前压测']) },
  ]);
}

function buildXlsx() {
  // 索引 0=表头, 1..=数据行
  const strings = ['员工姓名', '部门', '工号', '入职日期', '王小明', '研发中心', 'NB1024', '2024-03-01', '李思思', '市场部', 'NB2088', '2025-07-15'];

  const cell = (ref, v, type) => `<c r="${ref}"${type ? ` t="${type}"` : ''}><v>${v}</v></c>`;
  const rows = [
    `<row r="1">${cell('A1', 0, 's')}${cell('B1', 1, 's')}${cell('C1', 2, 's')}${cell('D1', 3, 's')}</row>`,
    `<row r="2">${cell('A2', 4, 's')}${cell('B2', 5, 's')}${cell('C2', 6, 's')}${cell('D2', 7, 's')}</row>`,
    `<row r="3">${cell('A3', 8, 's')}${cell('B3', 9, 's')}${cell('C3', 10, 's')}${cell('D3', 11, 's')}</row>`,
  ].join('');

  const shared = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings
    .map((s) => `<si><t>${s}</t></si>`)
    .join('')}</sst>`;

  return zipStore([
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>` },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="在职员工" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    },
    { name: 'xl/sharedStrings.xml', data: shared },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
    },
  ]);
}

function buildPdf() {
  const lines = [
    'BT',
    '/F1 14 Tf',
    '72 760 Td',
    '(VPN Access Policy) Tj',
    '0 -24 Td',
    '/F1 11 Tf',
    '(All remote access must go through the corporate VPN gateway vpn.example.com.) Tj',
    '0 -18 Td',
    '(Tokens expire every 12 hours. Re-authenticate with SSO when prompted.) Tj',
    '0 -18 Td',
    '(Report lost devices to security@example.com within 24 hours.) Tj',
    'ET',
  ].join('\n');

  const objs = [];
  objs.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  objs.push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  objs.push('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n');
  objs.push(`4 0 obj\n<< /Length ${Buffer.byteLength(lines)} >>\nstream\n${lines}\nendstream\nendobj\n`);
  objs.push('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');

  const head = '%PDF-1.4\n';
  let body = '';
  const offsets = [];
  let cursor = Buffer.byteLength(head);
  for (const o of objs) {
    offsets.push(cursor);
    body += o;
    cursor += Buffer.byteLength(o);
  }
  const xrefStart = cursor;
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets
    .map((o) => String(o).padStart(10, '0') + ' 00000 n \n')
    .join('')}`;
  const trailer = `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(head + body + xref + trailer, 'latin1');
}

// ---------- 生成并验证 ----------
mkdirSync(OUT, { recursive: true });

const cases = [
  { file: '差旅报销制度.docx', build: buildDocx, parse: parseDocxBuffer },
  { file: 'Q3路线图.pptx', build: buildPptx, parse: parsePptxBuffer },
  { file: '员工名册.xlsx', build: buildXlsx, parse: parseXlsxBuffer },
  { file: 'VPN接入规范.pdf', build: buildPdf, parse: parsePdfBuffer },
];

let ok = 0;
let bad = 0;

for (const c of cases) {
  const buf = c.build();
  const p = join(OUT, c.file);
  writeFileSync(p, buf);
  try {
    const text = c.parse(buf);
    const preview = text.replace(/\n+/g, ' ⏎ ').slice(0, 110);
    console.log(`✓ ${c.file}  ${buf.length}B → ${text.length} 字符`);
    console.log(`   ${preview}…`);
    ok++;
  } catch (e) {
    console.log(`✗ ${c.file}  解析失败: ${e.message}`);
    bad++;
  }
}

// CSV 单独验证（不是二进制）
const csv = '部门,预算,负责人\n研发,1200000,张伟\n市场,800000,李娜\n';
writeFileSync(join(OUT, '部门预算.csv'), csv);
try {
  const text = parseCsvText(csv);
  console.log(`✓ 部门预算.csv → ${text.split('\n').length} 行 markdown 表`);
  ok++;
} catch (e) {
  console.log(`✗ 部门预算.csv  解析失败: ${e.message}`);
  bad++;
}

console.log(`\n生成于 ${OUT}`);
console.log(`通过 ${ok}，失败 ${bad}`);
process.exit(bad ? 1 : 0);
