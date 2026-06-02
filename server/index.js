const express = require('express');
const path = require('path');
const cors = require('cors');
const { ImapFlow } = require('imapflow');
const iconv = require('iconv-lite');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.static(path.resolve(__dirname, '..')));
app.use(cors());
app.use(express.json({ limit: '5mb' }));

let imapConfig = null;

// Extract header value from raw source (case-insensitive)
function getHeader(source, name) {
  if (!source || !Buffer.isBuffer(source)) return null;
  // Find header in raw bytes (headers are ASCII, so safe to search in buffer)
  const prefix = Buffer.from(name + ':', 'ascii');
  let idx = 0;
  while (idx < source.length) {
    // Check if current position starts with the header name (case-insensitive)
    let match = true;
    for (let i = 0; i < prefix.length; i++) {
      const a = source[idx + i];
      const b = prefix[i];
      if (a === undefined) { match = false; break; }
      // Case-insensitive comparison for alpha chars
      if (a >= 65 && a <= 90) { // uppercase
        if (a !== b && a + 32 !== b) { match = false; break; }
      } else if (a >= 97 && a <= 122) { // lowercase
        if (a !== b && a - 32 !== b) { match = false; break; }
      } else {
        if (a !== b) { match = false; break; }
      }
    }
    if (match) {
      const start = idx + prefix.length;
      // Read until end of line (\r\n or \n)
      let end = start;
      while (end < source.length && source[end] !== 0x0a) end++;
      // Handle continuation lines (starting with space or tab)
      let val = source.slice(start, end).toString('ascii').trim();
      while (end + 1 < source.length) {
        const next = end + 1;
        if (source[next] === 0x20 || source[next] === 0x09) {
          end = next + 1;
          while (end < source.length && source[end] !== 0x0a) end++;
          val += ' ' + source.slice(next + 1, end).toString('ascii').trim();
        } else break;
      }
      return val;
    }
    // Move to next line
    while (idx < source.length && source[idx] !== 0x0a) idx++;
    idx++; // skip \n
    if (idx < source.length && source[idx - 1] === 0x0d && source[idx] === 0x0a) idx++; // skip \n after \r\n
  }
  return null;
}

// Decode MIME encoded words like =?UTF-8?B?xxx?= or =?GBK?Q?xxx?=
function decodeMimeWords(str) {
  if (!str) return str;
  return str.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (m, charset, encoding, text) => {
    try {
      const buf = encoding.toUpperCase() === 'B'
        ? Buffer.from(text, 'base64')
        : decodeQuotedPrintable(Buffer.from(text, 'ascii'));
      return iconv.decode(buf, charset);
    } catch(e) {
      return m;
    }
  });
}

// Decode quoted-printable buffer
function decodeQuotedPrintable(buf) {
  const result = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x3d && i + 2 < buf.length) { // '='
      const hex = String.fromCharCode(buf[i+1], buf[i+2]);
      result.push(parseInt(hex, 16));
      i += 2;
    } else if (buf[i] !== 0x0d) { // skip \r
      result.push(buf[i]);
    }
  }
  return Buffer.from(result);
}

// Decode body content based on Content-Transfer-Encoding and charset
function decodeBody(bodyBuf, charset, encoding) {
  if (!bodyBuf || bodyBuf.length === 0) return '';
  let decoded;
  const enc = (encoding || '').toLowerCase().trim();
  if (enc === 'base64') {
    decoded = Buffer.from(bodyBuf.toString('ascii').replace(/[\s\r\n]+/g, ''), 'base64');
  } else if (enc === 'quoted-printable') {
    decoded = decodeQuotedPrintable(bodyBuf);
  } else {
    decoded = bodyBuf;
  }
  const cs = (charset || 'utf-8').toLowerCase().trim();
  try {
    if (iconv.encodingExists(cs)) {
      return iconv.decode(decoded, cs);
    }
  } catch(e) {}
  return decoded.toString('utf8');
}

// Find the body part in raw email source (handles multipart and single part)
function findBodyPart(source, parentContentType) {
  if (!source || !Buffer.isBuffer(source)) return { text: '', isHtml: false };

  const headerEnd = findHeaderEnd(source);
  if (headerEnd < 0) return { text: '', isHtml: false };

  const headerSection = source.slice(0, headerEnd);
  const bodySection = source.slice(headerEnd);

  const ct = getHeader(headerSection, 'content-type') || 'text/plain';
  const cte = getHeader(headerSection, 'content-transfer-encoding') || '';
  const charset = extractParam(ct, 'charset') || 'utf-8';

  // Check for multipart
  const boundary = extractParam(ct, 'boundary');
  if (boundary) {
    return parseMultipart(bodySection, boundary);
  }

  // Single part
  const isHtml = ct.includes('text/html');
  return { text: decodeBody(bodySection, charset, cte), isHtml };
}

function findHeaderEnd(source) {
  // Find \r\n\r\n or \n\n
  for (let i = 0; i < source.length - 3; i++) {
    if (source[i] === 0x0d && source[i+1] === 0x0a && source[i+2] === 0x0d && source[i+3] === 0x0a) return i + 4;
  }
  for (let i = 0; i < source.length - 1; i++) {
    if (source[i] === 0x0a && source[i+1] === 0x0a) return i + 2;
  }
  return -1;
}

function extractParam(contentType, param) {
  const re = new RegExp(param + '\\s*=\\s*["\']?([^"\';\\s]+)', 'i');
  const m = contentType.match(re);
  return m ? m[1] : null;
}

function parseMultipart(source, boundary) {
  const b = Buffer.from('--' + boundary);
  const e = Buffer.from('--' + boundary + '--');
  let text = '';
  let html = '';

  let start = 0;
  while (start < source.length) {
    // Find next boundary
    const partStart = indexOfBuffer(source, b, start);
    if (partStart < 0) break;
    const partEnd = indexOfBuffer(source, e, start);
    if (partEnd >= 0 && partEnd < partStart) break; // end boundary

    // Find next boundary or end
    const nextBoundary = indexOfBuffer(source, b, partStart + b.length);
    const endBoundary = indexOfBuffer(source, e, partStart + b.length);
    let end = -1;
    if (endBoundary >= 0 && (nextBoundary < 0 || endBoundary < nextBoundary)) {
      end = endBoundary;
    } else if (nextBoundary >= 0) {
      end = nextBoundary;
    } else {
      end = source.length;
    }

    if (end < 0) break;

    // Extract part content (skip the boundary line itself)
    const partRaw = source.slice(partStart + b.length, end);
    // Skip the \r\n after boundary
    const partBodyStart = findHeaderEnd(partRaw);
    if (partBodyStart >= 0) {
      const result = findBodyPart(partRaw, null);
      if (result.text) text += result.text + '\n';
      if (result.isHtml) html += result.text + '\n';
    }

    start = end;
    if (endBoundary >= 0 && endBoundary <= end) break; // hit end boundary
  }

  return { text: text || html, isHtml: !!html };
}

function indexOfBuffer(haystack, needle, fromIndex) {
  for (let i = fromIndex || 0; i <= haystack.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { match = false; break; }
    }
    if (match) return i;
  }
  return -1;
}

// Main function: extract email text from raw source
function extractBodyFromSource(source) {
  if (!source || !Buffer.isBuffer(source) || source.length === 0) return '';
  const result = findBodyPart(source, null);
  let text = result.text;
  // Remove HTML tags if any remain
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

// Count Chinese characters in a string
function countChineseChars(s) {
  let c = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0x4e00 && code <= 0x9fff) c++;
  }
  return c;
}

// Try bodyParts first, fallback to source parsing
function getEmailText(bodyParts, source) {
  if (bodyParts && bodyParts instanceof Map) {
    // Try all available body part keys
    const keys = [];
    bodyParts.forEach((v, k) => keys.push(k));
    // Prioritize text/plain parts
    const prioritized = ['TEXT', '1', '1.1', '1.2', '2', '2.1', ...keys.filter(k => !['TEXT','1','1.1','1.2','2','2.1'].includes(k))];
    for (const key of prioritized) {
      if (bodyParts.has(key)) {
        const buf = bodyParts.get(key);
        if (buf && buf.length > 0) {
          // Try multiple encodings and pick the one with most Chinese characters
          const candidates = [];
          for (const cs of ['gbk', 'gb2312', 'utf-8', 'utf8']) {
            try {
              if (iconv.encodingExists(cs)) {
                const text = iconv.decode(buf, cs);
                candidates.push({ text: text.trim(), cn: countChineseChars(text) });
              }
            } catch(e) {}
          }
          if (candidates.length > 0) {
            // Pick the encoding that produces most Chinese characters
            candidates.sort((a, b) => b.cn - a.cn);
            if (candidates[0].text.length > 0) return candidates[0].text;
          }
          return buf.toString('utf8').trim();
        }
      }
    }
  }
  // Fallback to parsing source
  return extractBodyFromSource(source);
}

// ========================================
// API: Configure IMAP
// ========================================
app.post('/api/connect', (req, res) => {
  const { email, password, host, port } = req.body;
  if (!email || !password || !host || !port) {
    return res.status(400).json({ error: '缺少必要参数（email, password, host, port）' });
  }
  imapConfig = { email, password, host, port: Number(port) };
  res.json({ success: true, message: `已配置 ${email}` });
});

app.post('/api/disconnect', (req, res) => {
  imapConfig = null;
  res.json({ success: true });
});

app.get('/api/status', (req, res) => {
  res.json({ connected: !!imapConfig, email: imapConfig?.email || null });
});

// ========================================
// API: Fetch emails from IMAP
// ========================================
app.get('/api/emails', async (req, res) => {
  if (!imapConfig) {
    return res.status(400).json({ error: '未配置邮箱，请先调用 /api/connect' });
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
  const client = new ImapFlow({
    host: imapConfig.host,
    port: imapConfig.port,
    secure: true,
    tls: { rejectUnauthorized: false },
    auth: { user: imapConfig.email, pass: imapConfig.password },
    logger: false
  });
  try {
    await client.connect();
    await client.mailboxOpen('INBOX');
    const total = client.mailbox.exists;
    if (total === 0) { await client.logout(); return res.json({ emails: [], total: 0, fetched: 0 }); }

    const start = Math.max(1, total - limit + 1);
    const messages = [];

    for await (const msg of client.fetch(`${start}:${total}`, {
      uid: false,
      envelope: true,
      bodyParts: ['TEXT', '1'],
      source: true,
      flags: true
    })) {
      const fromAddr = msg.envelope?.from?.map(v => v.address).filter(Boolean).join(', ') || '';
      const toAddr = msg.envelope?.to?.map(v => v.address).filter(Boolean).join(', ') || '';
      const body = getEmailText(msg.bodyParts, msg.source);
      messages.push({
        id: String(msg.uid),
        from: fromAddr,
        to: toAddr,
        subject: msg.envelope?.subject || '(无主题)',
        body: body,
        date: msg.envelope?.date ? msg.envelope.date.toISOString() : new Date().toISOString(),
        read: msg.flags ? !msg.flags.has('\\Seen') : true,
        hasHtml: false
      });
    }

    await client.logout();
    messages.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ emails: messages, total, fetched: messages.length });
  } catch (err) {
    let hint = err.message;
    if (err.message.includes('EHOSTUNREACH') || err.message.includes('ETIMEDOUT') || err.message.includes('ECONNREFUSED')) {
      hint = '无法连接到 IMAP 服务器。当前环境可能网络受限，请部署到公网服务后使用。';
    } else if (err.message.includes('authentication') || err.message.includes('Auth')) {
      hint = 'IMAP 认证失败：授权码错误或已过期。请重新在邮箱设置中生成新的授权码。';
    } else if (err.message.includes('LOGOUT')) {
      hint = 'IMAP 登录被拒绝：请检查授权码和邮箱地址是否正确。QQ邮箱请使用16位授权码。';
    }
    res.status(500).json({ error: hint });
  }
});

// ========================================
// API: Diagnose IMAP connection
// ========================================
app.get('/api/diagnose', async (req, res) => {
  if (!imapConfig) {
    return res.json({ connected: false, error: '未配置 IMAP', steps: ['请先绑定邮箱'] });
  }
  const result = {
    connected: false,
    email: imapConfig.email,
    host: imapConfig.host,
    port: imapConfig.port,
    steps: [],
    error: null
  };

  const client = new ImapFlow({
    host: imapConfig.host,
    port: imapConfig.port,
    secure: true,
    tls: { rejectUnauthorized: false },
    auth: { user: imapConfig.email, pass: imapConfig.password },
    logger: false
  });

  try {
    result.steps.push('[1/6] 正在连接 IMAP 服务器...');
    await client.connect();
    result.steps.push('  ✅ TCP/TLS 连接成功');
    result.connected = true;

    result.steps.push('[2/6] 正在查询 INBOX 状态...');
    const status = await client.status('INBOX', { messages: true, unseen: true });
    result.steps.push(`  ✅ INBOX: 共 ${status.messages} 封, ${status.unseen || 0} 封未读`);
    result.totalMessages = status.messages;

    if (status.messages === 0) {
      result.steps.push('[3/6] 跳过收件箱为空');
      result.steps.push('结论: 连接成功但收件箱为空');
      await client.logout();
      return res.json(result);
    }

    result.steps.push('[3/6] 正在打开收件箱...');
    await client.mailboxOpen('INBOX');
    result.steps.push('  ✅ 收件箱已打开');

    result.steps.push('[4/6] 正在获取最新邮件 (envelope)...');
    const lastSeq = client.mailbox.exists;
    const msg = await client.fetchOne(`${lastSeq}`, {
      uid: false,
      envelope: true,
      bodyParts: ['TEXT', '1'],
      source: true,
      flags: true
    });

    if (!msg) {
      result.steps.push('  ❌ fetchOne 返回空');
      await client.logout();
      return res.json(result);
    }

    const envelope = msg.envelope || {};
    result.steps.push(`  ✅ 获取成功! seq=${msg.seq}, uid=${msg.uid}`);
    result.steps.push(`  📧 主题: ${envelope.subject || '(无主题)'}`);
    result.steps.push(`  📧 发件人: ${envelope.from?.[0]?.address || '未知'}`);
    result.steps.push(`  📧 收件人: ${envelope.to?.[0]?.address || '未知'}`);
    result.steps.push(`  📧 日期: ${envelope.date ? envelope.date.toISOString() : '未知'}`);

    // Check body
    const body = getEmailText(msg.bodyParts, msg.source);
    result.steps.push(`  📝 正文长度: ${body.length} 字符`);
    if (body.length > 0) {
      result.steps.push(`  📝 正文预览: ${body.slice(0, 100).replace(/\n/g, ' ')}`);
    } else if (msg.source && msg.source.length > 0) {
      // Try raw source parsing
      const raw = parseBodyFromSource(msg.source);
      result.steps.push(`  📝 原始解析正文长度: ${raw.length} 字符`);
      result.steps.push(`  📝 原始大小: ${msg.source.length} 字节`);
    } else {
      result.steps.push('  ⚠️ 无法获取正文内容');
    }

    result.steps.push('[5/6] 断开连接...');
    await client.logout();
    result.steps.push('  ✅ IMAP 已断开');

    result.steps.push('[6/6] 结论: 连接成功, 可以正常收信');
  } catch (err) {
    result.error = err.message;
    result.steps.push(`  ❌ 错误: ${err.message}`);
    if (err.message.includes('connect')) {
      result.steps.push('  💡 提示: 服务器无法连接到 QQ/163 IMAP 服务器');
    } else if (err.message.includes('auth') || err.message.includes('Auth') || err.message.includes('LOGIN')) {
      result.steps.push('  💡 提示: 授权码错误或已过期，请重新生成16位授权码');
    }
    try { await client.logout(); } catch(e) {}
  }
  res.json(result);
});

// ========================================
// API: Test email (no IMAP needed)
// ========================================
app.post('/api/test-email', (req, res) => {
  const { from, subject, body } = req.body;
  if (!body) return res.status(400).json({ error: '缺少邮件正文' });
  res.json({
    email: {
      id: 'test_' + Date.now(),
      from: from || 'test@example.com',
      to: imapConfig?.email || 'you@example.com',
      subject: subject || '测试邮件',
      body: body,
      date: new Date().toISOString(),
      read: true
    }
  });
});

// Serve frontend for all non-API routes
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.resolve(__dirname, '..', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`📬 邮你服务运行在 http://0.0.0.0:${PORT}`);
});