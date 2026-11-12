import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { loadConfig } from '../src/config.js';
import { buildRawMessage, createMailer } from '../src/mailer.js';

function configFor(overrides = {}) {
  return {
    mail: {
      mode: 'smtp',
      from: 'Red Panda <no-reply@red-panda.local>',
      outboxDir: '',
      command: '',
      apiUrl: '',
      apiKey: '',
      smtp: {
        host: '127.0.0.1',
        port: 465,
        secure: true,
        user: '',
        pass: '',
        rejectUnauthorized: true,
        ...overrides,
      },
    },
  };
}

test('buildRawMessage 使用 CRLF、UTF-8 主题与 base64 正文', () => {
  const config = configFor();
  const raw = buildRawMessage(
    config,
    { to: 'you@example.com', subject: '激活你的小熊猫账户', text: '你好，世界' },
    { encoding: 'base64' },
  );

  assert.match(raw, /^From: Red Panda <no-reply@red-panda.local>\r\n/);
  assert.match(raw, /\r\nTo: you@example\.com\r\n/);
  assert.match(raw, /\r\nSubject: =\?UTF-8\?B\?/);
  assert.match(raw, /\r\nContent-Transfer-Encoding: base64\r\n/);
  assert.ok(!/[^\r]\n/.test(raw), '正文和头部都应使用 CRLF');
  const body = raw.split('\r\n\r\n')[1].trim();
  assert.equal(Buffer.from(body, 'base64').toString('utf8'), '你好，世界');
});

test('loadConfig 从 SMTP 用户名推导发件人并读取 SMTP 选项', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'red-panda-mail-'));
  try {
    const config = loadConfig({
      RED_PANDA_DATA_DIR: tempDir,
      RED_PANDA_MAIL_MODE: 'smtp',
      RED_PANDA_SMTP_HOST: 'smtp.126.com',
      RED_PANDA_SMTP_PORT: '587',
      RED_PANDA_SMTP_SECURE: '0',
      RED_PANDA_SMTP_USER: 'you@126.com',
      RED_PANDA_SMTP_PASS: 'secret',
      RED_PANDA_SMTP_REJECT_UNAUTHORIZED: '0',
    });

    assert.equal(config.mail.from, 'Red Panda <you@126.com>');
    assert.equal(config.mail.smtp.host, 'smtp.126.com');
    assert.equal(config.mail.smtp.port, 587);
    assert.equal(config.mail.smtp.secure, false);
    assert.equal(config.mail.smtp.user, 'you@126.com');
    assert.equal(config.mail.smtp.pass, 'secret');
    assert.equal(config.mail.smtp.rejectUnauthorized, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('SMTP 服务器不支持 STARTTLS 时给出明确错误', async () => {
  const received = [];
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('220 fake.smtp ESMTP\r\n');
    socket.on('data', (chunk) => {
      for (const line of chunk.split('\r\n').filter(Boolean)) {
        received.push(line);
        if (/^EHLO /i.test(line)) {
          socket.write('250-fake.smtp\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
        }
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const mailer = createMailer(configFor({ port, secure: false }));
    await assert.rejects(
      mailer.send({ to: 'you@example.com', subject: 'hi', text: 'hello' }),
      /STARTTLS/,
    );
    assert.ok(received.some((line) => /^EHLO /i.test(line)));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('SMTP 服务器拒绝连接时把错误抛给调用方', async () => {
  const received = [];
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('554 go away\r\n');
    socket.on('data', (chunk) => received.push(chunk));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const mailer = createMailer(configFor({ port, secure: false }));
    await assert.rejects(
      mailer.send({ to: 'you@example.com', subject: 'hi', text: 'hello' }),
      /拒绝连接/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('未知邮件模式会报错', async () => {
  const config = configFor();
  config.mail.mode = 'pigeon';
  const mailer = createMailer(config);
  await assert.rejects(
    mailer.send({ to: 'you@example.com', subject: 'hi', text: 'hello' }),
    /未知的邮件模式/,
  );
});
