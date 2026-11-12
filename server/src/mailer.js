import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

function sanitize(value) {
  return String(value).replace(/[^a-zA-Z0-9._@-]+/g, '_').slice(0, 80);
}

function encodeHeader(value) {
  const text = String(value ?? '');
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

export function buildRawMessage(config, message) {
  const from = message.from || config.mail.from;
  const headers = [
    `From: ${from}`,
    `To: ${message.to}`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${message.text}\r\n`;
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

/**
 * Create a mail transport. Modes:
 *   log     — write .eml files to data/outbox and log the link (default, no setup)
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
      case 'command':
        return sendCommand(config, message);
      case 'http':
        return sendHttp(config, message);
      default:
        throw new Error(`未知的邮件模式: ${mode}（可选 log / command / http）`);
    }
  };
  return { mode, send };
}
