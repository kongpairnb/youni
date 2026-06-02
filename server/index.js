const express = require('express');
const path = require('path');
const cors = require('cors');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.static(path.resolve(__dirname, '..')));
app.use(cors());
app.use(express.json({ limit: '5mb' }));

let imapConfig = null;

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
    if (total === 0) { await client.logout(); return res.json({ emails: [] }); }
    const start = Math.max(1, total - limit + 1);
    const messages = [];
    for await (const msg of client.fetch(`${start}:${total}`, { uid: false, source: true, flags: true })) {
      try {
        const parsed = await simpleParser(msg.source);
        const fromAddr = parsed.from ? parsed.from.value.map(v => v.address).filter(Boolean).join(', ') : '';
        const toAddr = parsed.to ? parsed.to.value.map(v => v.address).filter(Boolean).join(', ') : '';
        messages.push({
          id: String(msg.uid),
          from: fromAddr,
          to: toAddr,
          subject: parsed.subject || '(无主题)',
          body: parsed.text || parsed.html?.replace(/<[^>]+>/g, '') || '',
          date: parsed.date ? parsed.date.toISOString() : (msg.internalDate ? new Date(msg.internalDate).toISOString() : new Date().toISOString()),
          read: msg.flags ? !msg.flags.includes('\\Seen') : true,
          hasHtml: !!parsed.html
        });
      } catch (parseErr) {
        console.error('Parse error:', parseErr.message);
      }
    }
    await client.logout();
    messages.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ emails: messages, total, fetched: messages.length });
  } catch (err) {
    let hint = err.message;
    if (err.message.includes('connect EHOSTUNREACH') || err.message.includes('connect ETIMEDOUT') || err.message.includes('connect ECONNREFUSED')) {
      hint = '无法连接到 IMAP 服务器。当前环境可能网络受限，请部署到 Render/Railway 等公网服务后使用。';
    } else if (err.message.includes('authentication') || err.message.includes('Auth')) {
      hint = 'IMAP 认证失败：授权码错误或已过期。请重新在邮箱设置中生成新的授权码。';
    } else if (err.message.includes('LOGOUT')) {
      hint = 'IMAP 登录被拒绝：请检查授权码和邮箱地址是否正确。QQ邮箱请使用16位授权码而非登录密码。';
    }
    res.status(500).json({ error: hint });
  }
});

app.get('/api/diagnose', async (req, res) => {
  if (!imapConfig) {
    return res.json({ connected: false, error: '未配置 IMAP，请先绑定邮箱', steps: [] });
  }
  const result = { connected: false, email: imapConfig.email, host: imapConfig.host, port: imapConfig.port, steps: [], error: null };
  const client = new ImapFlow({
    host: imapConfig.host,
    port: imapConfig.port,
    secure: true,
    tls: { rejectUnauthorized: false },
    auth: { user: imapConfig.email, pass: imapConfig.password },
    logger: false
  });
  try {
    result.steps.push('正在连接 IMAP 服务器...');
    await client.connect();
    result.steps.push('TCP/TLS 连接成功');
    result.connected = true;

    result.steps.push('正在查询 INBOX 状态...');
    const status = await client.status('INBOX', { messages: true, unseen: true, recent: true });
    result.steps.push(`INBOX 状态: 共 ${status.messages} 封邮件, ${status.unseen || 0} 封未读`);
    result.totalMessages = status.messages;

    result.steps.push('正在列出邮箱文件夹...');
    const mailboxes = [];
    try {
      client.mailboxes.forEach((mb, path) => {
        if (path && !path.startsWith('[') && mailboxes.length < 5) {
          mailboxes.push(path);
        }
      });
    } catch(e) {}
    result.steps.push(`找到文件夹: ${mailboxes.join(', ') || '仅 INBOX'}`);

    if (status.messages > 0) {
      result.steps.push('正在打开收件箱...');
      try {
        await client.mailboxOpen('INBOX');
        result.steps.push('收件箱已打开');
      } catch (openErr) {
        result.steps.push(`打开收件箱失败: ${openErr.message}`);
      }
      result.steps.push('正在尝试获取最新一封邮件...');
      try {
        const msg = await client.fetchOne('1:*', { source: true, flags: true, envelope: true });
        if (msg) {
          result.steps.push(`成功获取到邮件 seq=${msg.seq} uid=${msg.uid}`);
          if (msg.envelope) {
            result.steps.push(`主题: ${msg.envelope.subject || '(无主题)'}`);
            result.steps.push(`发件人: ${msg.envelope.from && msg.envelope.from[0] ? msg.envelope.from[0].address : '未知'}`);
          }
          if (msg.source) {
            result.steps.push(`邮件原始大小: ${msg.source.length} 字节`);
            try {
              const { simpleParser } = require('mailparser');
              const parsed = await simpleParser(msg.source);
              result.steps.push(`解析成功! 主题: ${parsed.subject || '(无)'}, 正文长度: ${(parsed.text || '').length} 字符`);
            } catch (parseErr) {
              result.steps.push(`解析失败: ${parseErr.message}`);
              // Try a different approach - show first 200 bytes of source
              const preview = msg.source.slice(0, 200).toString('utf8').replace(/\n/g, '\\n').replace(/\r/g, '');
              result.steps.push(`原始内容前200字节: ${preview}`);
            }
          } else {
            result.steps.push('警告: source 字段为空!');
          }
        } else {
          result.steps.push('fetchOne 返回空');
        }
      } catch (fetchErr) {
        result.steps.push(`获取邮件失败: ${fetchErr.message}`);
      }
    }

    await client.logout();
    result.steps.push('IMAP 已断开连接');
  } catch (err) {
    result.error = err.message;
    result.steps.push(`错误: ${err.message}`);
    if (err.message.includes('connect')) {
      result.steps.push('提示: Railway 服务器可能无法连接到 QQ 的 IMAP 服务器，请检查网络');
    } else if (err.message.includes('auth') || err.message.includes('Auth') || err.message.includes('LOGIN')) {
      result.steps.push('提示: 授权码错误或已过期，请在 QQ 邮箱重新生成 16 位授权码');
    }
  }
  res.json(result);
});

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

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.resolve(__dirname, '..', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`📬 邮你服务运行在 http://0.0.0.0:${PORT}`);
});