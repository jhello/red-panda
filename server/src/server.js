import { loadConfig, getLanUrls } from './config.js';
import { startServer } from './app.js';
import { aiStatus } from './ai.js';
import { createMailer } from './mailer.js';

const config = loadConfig();
const mailer = createMailer(config);
const app = await startServer(config, { mailer });
const address = app.server.address();
const port = typeof address === 'object' && address ? address.port : config.port;
const urls = getLanUrls(port);
const ai = aiStatus(config);

const lan = urls.find((entry) => entry.name !== 'localhost');
const base = lan?.url ?? urls[0].url;

const mailHint = {
  log: `log · 邮件写入 ${config.mail.outboxDir}`,
  smtp: `smtp · ${config.mail.smtp.host || '未配置 RED_PANDA_SMTP_HOST'}:${config.mail.smtp.port}${config.mail.smtp.user ? ` · ${config.mail.smtp.user}` : ''}`,
  command: `command · ${config.mail.command || '未配置 RED_PANDA_MAIL_COMMAND'}`,
  http: `http · ${config.mail.apiUrl || '未配置 RED_PANDA_MAIL_API_URL'}`,
}[mailer.mode] ?? `${mailer.mode}（未知模式）`;

console.log('');
console.log('  小熊猫 · RED PANDA');
console.log('  ─────────────────────────────────────────────');
console.log(`  控制台      ${base}/`);
console.log(`  HTML5 应用  ${base}/app/`);
console.log(`  健康检查    ${base}/api/health`);
console.log(`  监听地址    ${config.host}:${port}`);
console.log(`  数据库      ${config.dbPath}`);
console.log(
  `  AI          ${ai.configured ? `已配置 · ${ai.model}${ai.mock ? ' (mock)' : ''}` : '未配置（设置 OPENAI_API_KEY 后重启）'}`,
);
console.log(`  邮件        ${mailHint}`);
console.log(`  公开地址    ${config.publicUrl || '自动检测（验证邮件中的链接以此为准）'}`);
console.log(`  管理员令牌  ${config.adminToken}`);
if (config.adminTokenSource !== 'env') {
  console.log(`              （保存在 ${config.dataDir}/admin-token）`);
}
console.log('  ─────────────────────────────────────────────');
console.log('  Ctrl+C 停止服务');
console.log('');

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n[red-panda] 收到 ${signal}，正在停止服务…`);
  const force = setTimeout(() => {
    console.error('[red-panda] 停止超时，强制退出');
    process.exit(1);
  }, 5000);
  force.unref();
  try {
    await app.close();
    console.log('[red-panda] 已停止。');
    process.exit(0);
  } catch (error) {
    console.error('[red-panda] 停止失败:', error);
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
