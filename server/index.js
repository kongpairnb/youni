const express = require('express');
const path = require('path');
const cors = require('cors');
const { ImapFlow } = require('imapflow');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.static(path.resolve(__dirname, '..')));
app.use(cors());
app.use(express.json({ limit: '5mb' }));

let imapConfig = null;

// Simple email source parser - extracts body text from raw email source
function parseBodyFromSource(source) {
  if (!source || !Buffer.isBuffer(source)) return '';
  let str = source.toString('utf8');
  // Headers end at first blank line (\r\n\r\n or \n\n)
  const headerEnd = str.indexOf('\r\n\r\n');
  const headerEnd2 = str.indexOf('\n\n');
  const splitIdx = headerEnd >= 0 ? headerEnd + 4 : (headerEnd2 >= 0 ? headerEnd2 + 2 : -1);
  let body = splitIdx >= 0 ? str.slice(splitIdx) : str;

  // Remove MIME boundaries and transfer encoding
  body = body.replace(/^--.*\r?\n/gm, '');
  body = body.replace(/^Content-.*\r?\n/gi, '');
  body = body.replace(/^\s*$/gm, '\n');

  // Decode quoted-printable (basic)
  body = body.replace(/=([0-9A-F]{2})/gi, (m, c) => String.fromCharCode(parseInt(c, 16)));

  // Remove HTML tags
  body = body.replace(/<[^>]+>/g, '');

  // Remove excess blank lines
  body = body.replace(/\n{3,}/g, '\n\n');

  return body.trim();
}

function getEmailText(bodyParts, source) {
  // Try bodyParts first
  if (bodyParts) {
    if (bodyParts instanceof Map) {
      // Try common body part keys
      for (const key of ['TEXT', '1', '1.1', '2', '2.1']) {
        if (bodyParts.has(key)) {
          const buf = bodyParts.get(key);
          if (buf && buf.length > 0) return buf.toString('utf8').trim();
        }
      }
    }
  }
  // Fallback to parsing source
  return parseBodyFromSource(source);
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