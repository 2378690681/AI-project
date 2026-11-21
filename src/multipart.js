/**
 * 零依赖 multipart/form-data 解析。
 *
 * 只做一件事：把「一次表单提交」拆成字段和文件。
 * 不处理嵌套、不处理 chunked 传输（HTTP 层已缓冲完整 body）。
 * 目的是让员工端能直接用标准表单上传 —— curl -F、浏览器 FormData、Postman 都能用。
 */

const CRLF = Buffer.from('\r\n');
const HEAD_END = Buffer.from('\r\n\r\n');

export function getBoundary(contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType || ''));
  if (!m) return null;
  return (m[1] || m[2]).trim();
}

function parseHeaders(buf) {
  const out = {};
  for (const line of buf.toString('utf8').split('\r\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

/** 从 Content-Disposition 里取 name / filename（支持 RFC 5987 的 filename*） */
function parseDisposition(v) {
  const s = String(v || '');
  const nameM = /\bname="([^"]*)"/i.exec(s) || /\bname=([^;]+)/i.exec(s);
  let filename = null;
  const starM = /\bfilename\*=UTF-8''([^;]+)/i.exec(s);
  if (starM) {
    try { filename = decodeURIComponent(starM[1]); } catch { filename = starM[1]; }
  } else {
    const fnM = /\bfilename="([^"]*)"/i.exec(s) || /\bfilename=([^;]+)/i.exec(s);
    if (fnM) filename = fnM[1];
  }
  return { name: nameM ? nameM[1] : '', filename };
}

/**
 * @param {Buffer} body
 * @param {string} contentType
 * @returns {{fields: Record<string,string>, files: Array<{field:string, filename:string, contentType:string, data:Buffer}>}}
 */
export function parseMultipart(body, contentType) {
  const boundary = getBoundary(contentType);
  if (!boundary) throw new Error('multipart 请求缺少 boundary');

  const delim = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = [];

  let pos = body.indexOf(delim);
  if (pos < 0) throw new Error('multipart 格式异常：未找到分隔符');

  while (pos >= 0) {
    let start = pos + delim.length;

    // "--" 结尾表示内容结束
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break;
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;

    const next = body.indexOf(delim, start);
    if (next < 0) break;

    // 分隔符前的 CRLF 属于边界，不属于内容
    let end = next;
    if (body[end - 2] === 0x0d && body[end - 1] === 0x0a) end -= 2;

    const part = body.subarray(start, end);
    const sep = part.indexOf(HEAD_END);
    const headerBuf = sep >= 0 ? part.subarray(0, sep) : Buffer.alloc(0);
    const data = sep >= 0 ? part.subarray(sep + HEAD_END.length) : part;
    const headers = parseHeaders(headerBuf);
    const { name, filename } = parseDisposition(headers['content-disposition']);

    if (filename != null) {
      files.push({
        field: name || 'file',
        filename: filename || 'unnamed',
        contentType: headers['content-type'] || 'application/octet-stream',
        data: Buffer.from(data),
      });
    } else if (name) {
      fields[name] = data.toString('utf8');
    }

    pos = next;
  }

  if (!Object.keys(fields).length && !files.length) {
    throw new Error('multipart 中没有可解析的字段或文件');
  }
  return { fields, files };
}

/** 粗判是否 multipart 请求 */
export function isMultipart(contentType) {
  return /^multipart\/form-data/i.test(String(contentType || ''));
}

export { CRLF };
