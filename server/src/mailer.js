import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { spawn } from 'node:child_process';

function sanitize(value) {
  return String(value).replace(/[^a-zA-Z0-9._@-]+/g, '_').slice(0, 80);
}

function encodeHeader(value) {
  const text = String(value ?? '');
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

function envelopeAddress(value) {
  const text = String(value ?? '').trim();
  const match = /<([^<>]+)>/.exec(text);
  if (match) return match[1].trim();
  const parts = text.split(/\s+/);
  return parts[parts.length - 1] || text;
}

function encodeBody(text, encoding) {
  if (encoding === 'base64') {
    return Buffer.from(String(text ?? ''), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  }
  // Normalize line endings so the raw message is always valid.
  return String(text ?? '').replace(/\r?\n/g, '\r\n');
}

export function buildRawMessage(config, message, options = {}) {
  const from = message.from || config.mail.from;
  const encoding = options.encoding === 'base64' ? 'base64' : '8bit';
  const headers = [
    `From: ${from}`,
    `To: ${message.to}`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
  ];

  // When an HTML body is available, send multipart/alternative so clients that
  // render HTML get a styled message (with a real clickable link) while strict
  // text-only clients (e.g. 126) still show the plain-text part.
  if (message.html) {
    const boundary = `red-panda-${crypto.randomBytes(12).toString('hex')}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const parts = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      `Content-Transfer-Encoding: ${encoding}`,
      '',
      encodeBody(message.text ?? '', encoding),
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      `Content-Transfer-Encoding: ${encoding}`,
      '',
      encodeBody(message.html, encoding),
      `--${boundary}--`,
    ];
    return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}\r\n`;
  }

  headers.push('Content-Type: text/plain; charset=utf-8');
  headers.push(`Content-Transfer-Encoding: ${encoding}`);
  return `${headers.join('\r\n')}\r\n\r\n${encodeBody(message.text ?? '', encoding)}\r\n`;
}

function sendLog(config, message) {
  const dir = config.mail.outboxDir;
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}-${sanitize(message.to)}.eml`);
  fs.writeFileSync(file, buildRawMessage(config, message), 'utf8');
  console.log(`[red-panda] [mail:log] → ${message.to} · ${message.subject}`);
  console.log(`[red-panda] [mail:log] 已写入 ${file}`);
  const link = /https?:\/\/\S+/.exec(message.text)?.[0];
  if (link) console.log(`[red-panda] [mail:log] 链接: ${link}`);
}

function sendCommand(config, message) {
  const command = config.mail.command;
  if (!command) {
    throw new Error('RED_PANDA_MAIL_MODE=command 需要设置 RED_PANDA_MAIL_COMMAND（例如 "msmtp -t"）');
  }
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`邮件命令退出码 ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
    });
    child.stdin.end(buildRawMessage(config, message));
  });
}

async function sendHttp(config, message) {
  const url = config.mail.apiUrl;
  if (!url) {
    throw new Error('RED_PANDA_MAIL_MODE=http 需要设置 RED_PANDA_MAIL_API_URL');
  }
  const headers = { 'Content-Type': 'application/json' };
  if (config.mail.apiKey) headers.Authorization = `Bearer ${config.mail.apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      from: message.from || config.mail.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html || undefined,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `邮件 API 返回 HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    );
  }
}

function decodeLine(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      // Some Chinese SMTP servers (126/163) answer with GBK.
      return new TextDecoder('gbk').decode(bytes);
    } catch {
      return bytes.toString('utf8');
    }
  }
}

/**
 * Minimal SMTP client. Supports implicit TLS (port 465) and STARTTLS
 * (usually port 587), plus AUTH PLAIN / AUTH LOGIN.
 */
class SmtpSession {
  constructor(socket) {
    this.buffer = Buffer.alloc(0);
    this.lines = [];
    this.waiters = [];
    this.error = null;
    this.attach(socket);
  }

  attach(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.lines = [];
    this.error = null;
    socket.setTimeout(30_000);
    socket.on('data', (chunk) => {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      this.flush();
    });
    socket.on('timeout', () => {
      socket.destroy(new Error('SMTP 连接超时'));
    });
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => {
      if (!this.error) this.fail(new Error('SMTP 连接已关闭'));
    });
  }

  fail(error) {
    if (!this.error) this.error = error;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.reject(this.error);
  }

  flush() {
    if (this.error) {
      this.fail(this.error);
      return;
    }
    while (this.waiters.length) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) break;
      let lineBytes = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (lineBytes.length && lineBytes[lineBytes.length - 1] === 0x0d) {
        lineBytes = lineBytes.subarray(0, lineBytes.length - 1);
      }
      const line = decodeLine(lineBytes);
      this.lines.push(line);
      // A line like "250-text" continues the response; "250 text" ends it.
      if (!/^\d{3} /.test(line)) continue;
      const waiter = this.waiters.shift();
      const lines = this.lines;
      this.lines = [];
      waiter.resolve({
        code: Number(line.slice(0, 3)),
        text: lines.map((entry) => entry.slice(4)).join('\n'),
        raw: `${lines.join('\r\n')}\r\n`,
      });
    }
  }

  read() {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.flush();
    });
  }

  write(line) {
    this.socket.write(`${line}\r\n`);
  }

  async command(line, expected) {
    this.write(line);
    const response = await this.read();
    if (expected && !expected.includes(response.code)) {
      throw new Error(`SMTP ${line.split(' ')[0]} 失败 (${response.code}): ${response.text}`);
    }
    return response;
  }

  async upgradeToTls(options) {
    const plain = this.socket;
    plain.removeAllListeners('data');
    plain.removeAllListeners('error');
    plain.removeAllListeners('close');
    plain.removeAllListeners('timeout');
    const secure = tls.connect({ socket: plain, ...options });
    await new Promise((resolve, reject) => {
      secure.once('secureConnect', resolve);
      secure.once('error', reject);
    });
    this.attach(secure);
  }

  close() {
    this.socket.end();
  }
}

async function sendSmtp(config, message) {
  const smtp = config.mail.smtp || {};
  if (!smtp.host) {
    throw new Error('RED_PANDA_MAIL_MODE=smtp 需要设置 RED_PANDA_SMTP_HOST');
  }

  const options = {
    host: smtp.host,
    port: smtp.port,
    servername: smtp.host,
    rejectUnauthorized: smtp.rejectUnauthorized !== false,
  };

  const socket = smtp.secure ? tls.connect(options) : net.connect({ host: smtp.host, port: smtp.port });
  const session = new SmtpSession(socket);

  try {
    if (smtp.secure) {
      await new Promise((resolve, reject) => {
        socket.once('secureConnect', resolve);
        socket.once('error', reject);
      });
    }

    const greeting = await session.read();
    if (greeting.code !== 220) {
      throw new Error(`SMTP 服务器拒绝连接 (${greeting.code}): ${greeting.text}`);
    }

    const heloName = os.hostname() || 'localhost';
    let ehlo = await session.command(`EHLO ${heloName}`, [250]);

    if (!smtp.secure) {
      if (!/\bSTARTTLS\b/i.test(ehlo.text)) {
        throw new Error('SMTP 服务器不支持 STARTTLS；请改用 465 端口并设置 RED_PANDA_SMTP_SECURE=1');
      }
      await session.command('STARTTLS', [220]);
      await session.upgradeToTls(options);
      ehlo = await session.command(`EHLO ${heloName}`, [250]);
    }

    if (smtp.user || smtp.pass) {
      const authLine = /\bAUTH[ =]([^\r\n]*)/i.exec(ehlo.text)?.[1] || '';
      if (/\bPLAIN\b/i.test(authLine)) {
        const token = Buffer.from(`\0${smtp.user}\0${smtp.pass}`, 'utf8').toString('base64');
        await session.command(`AUTH PLAIN ${token}`, [235]);
      } else if (/\bLOGIN\b/i.test(authLine)) {
        await session.command('AUTH LOGIN', [334]);
        await session.command(Buffer.from(smtp.user, 'utf8').toString('base64'), [334]);
        await session.command(Buffer.from(smtp.pass, 'utf8').toString('base64'), [235]);
      } else {
        throw new Error('SMTP 服务器没有提供 AUTH LOGIN / AUTH PLAIN 登录方式');
      }
    }

    const from = envelopeAddress(message.from || config.mail.from);
    const to = envelopeAddress(message.to);
    await session.command(`MAIL FROM:<${from}>`, [250]);
    await session.command(`RCPT TO:<${to}>`, [250, 251]);
    await session.command('DATA', [354]);

    const raw = buildRawMessage(config, message, { encoding: 'base64' }).replace(/\r?\n/g, '\r\n');
    session.socket.write(`${raw}.\r\n`);
    const accepted = await session.read();
    if (accepted.code !== 250) {
      throw new Error(`SMTP 拒收邮件 (${accepted.code}): ${accepted.text}`);
    }

    try {
      await session.command('QUIT', [221]);
    } catch {
      // The server may close immediately after accepting the message.
    }
    session.close();
  } catch (error) {
    session.socket?.destroy();
    throw error;
  }
}

/**
 * Create a mail transport. Modes:
 *   log     — write .eml files to data/outbox and log the link (default, no setup)
 *   smtp    — send through an SMTP server (126/163/Gmail, etc.)
 *   command — pipe the raw message to a command such as `msmtp -t`
 *   http    — POST { from, to, subject, text, html } to an HTTP API
 *
 * Tests can pass options.send to capture messages without touching disk.
 */
export function createMailer(config, options = {}) {
  const mode = String(config.mail.mode || 'log').toLowerCase();
  const send = async (message) => {
    if (typeof options.send === 'function') return options.send(message);
    switch (mode) {
      case 'log':
        return sendLog(config, message);
      case 'smtp':
        return sendSmtp(config, message);
      case 'command':
        return sendCommand(config, message);
      case 'http':
        return sendHttp(config, message);
      default:
        throw new Error(`未知的邮件模式: ${mode}（可选 log / smtp / command / http）`);
    }
  };
  return { mode, send };
}
