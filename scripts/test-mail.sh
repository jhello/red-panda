#!/usr/bin/env bash
# 用当前 .env 的邮件配置发送一封测试邮件。
# 用法: ./scripts/test-mail.sh you@example.com
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $# -lt 1 ]]; then
  echo "用法: $0 <收件邮箱>" >&2
  exit 1
fi

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

cd "$ROOT/server"
node --input-type=module - "$1" <<'NODE'
import { loadConfig } from './src/config.js';
import { createMailer } from './src/mailer.js';

const to = process.argv[2];
const config = loadConfig();
const mailer = createMailer(config);
const smtp = config.mail.smtp;

console.log(`邮件模式: ${mailer.mode}`);
if (mailer.mode === 'smtp') {
  console.log(`SMTP: ${smtp.host}:${smtp.port} secure=${smtp.secure} user=${smtp.user || '（无）'}`);
}
console.log(`发件人: ${config.mail.from}`);
console.log(`收件人: ${to}`);

try {
  await mailer.send({
    to,
    subject: '小熊猫 · 邮件发送测试',
    text: [
      '这是一封来自小熊猫服务端的测试邮件。',
      '',
      `发送时间: ${new Date().toISOString()}`,
      '如果你看到这封邮件，说明 SMTP 配置成功，激活邮件和重置密码邮件也能正常送达。',
      '',
      '—— 小熊猫 · Red Panda',
    ].join('\n'),
  });
  console.log('已提交发送。若几分钟内没收到，请检查垃圾箱或查看服务端日志。');
} catch (error) {
  console.error(`发送失败: ${error.message}`);
  process.exit(1);
}
NODE
