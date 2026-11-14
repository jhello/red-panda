import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { createApp, parseJourneyPlan } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'red-panda-test-'));
const config = loadConfig({
  ...process.env,
  RED_PANDA_DATA_DIR: tempDir,
  RED_PANDA_DB: path.join(tempDir, 'test.db'),
  RED_PANDA_ADMIN_TOKEN: 'test-admin-token',
  RED_PANDA_RESET_MINUTES: '1440',
  RED_PANDA_EMAIL_RATE_LIMIT: '100',
  RED_PANDA_AI_MOCK: '1',
  PORT: '0',
  HOST: '127.0.0.1',
});

// Capture outgoing mail instead of writing files or talking to a network.
const outbox = [];
const mailer = {
  mode: 'test',
  async send(message) {
    outbox.push(message);
  },
};
const app = createApp(config, { mailer });
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;

after(async () => {
  await app.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function request(pathname, { method = 'GET', token, body, admin, redirect, raw, contentType } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (admin) headers['X-Admin-Token'] = admin;
  if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';
  if (raw && contentType) headers['Content-Type'] = contentType;
  const payload = body === undefined ? undefined : raw ? body : JSON.stringify(body);
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    redirect,
    body: payload,
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: response.status, data, text, headers: response.headers };
}

function lastMail(email, keyword) {
  const mail = [...outbox]
    .reverse()
    .find((message) => message.to === email && message.subject.includes(keyword));
  assert.ok(mail, `没有找到发往 ${email} 的「${keyword}」邮件`);
  return mail;
}

function linkFrom(mail) {
  const match = /https?:\/\/\S+/.exec(mail.text);
  assert.ok(match, '邮件正文里没有链接');
  return match[0];
}

function tokenFrom(link) {
  const match = /[?&]token=([^&\s]+)/.exec(link);
  assert.ok(match, `链接里没有令牌: ${link}`);
  return decodeURIComponent(match[1]);
}

async function registerAndVerify(email, password) {
  const created = await request('/api/auth/register', {
    method: 'POST',
    body: { email, password },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.status, 'pending_verification');
  const token = tokenFrom(linkFrom(lastMail(email, '激活')));
  const verify = await request(`/api/auth/verify?token=${encodeURIComponent(token)}`, {
    redirect: 'manual',
  });
  assert.equal(verify.status, 302);
  return verify;
}

const email = 'traveler@example.com';
const password = 'password123';
let token = '';
let userId = 0;
let journeyId = 0;

test('健康检查是公开的', async () => {
  const result = await request('/api/health');
  assert.equal(result.status, 200);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.name, '小熊猫');
});

test('管理看板接口需要管理员令牌', async () => {
  const denied = await request('/api/admin/status');
  assert.equal(denied.status, 401);

  const wrong = await request('/api/admin/status', { admin: 'nope' });
  assert.equal(wrong.status, 401);

  const ok = await request('/api/admin/status', { admin: 'test-admin-token' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.server.name, 'Red Panda');
  assert.equal(ok.data.ai.mock, true);
  assert.equal(ok.data.stats.users, 0);
});

test('注册校验、验证邮件与激活', async () => {
  const badEmail = await request('/api/auth/register', {
    method: 'POST',
    body: { email: 'not-an-email', password },
  });
  assert.equal(badEmail.status, 400);

  const shortPassword = await request('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'short' },
  });
  assert.equal(shortPassword.status, 400);

  const created = await request('/api/auth/register', {
    method: 'POST',
    body: { email, password },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.status, 'pending_verification');
  assert.equal(created.data.email, email);
  assert.equal(created.data.token, undefined);

  const mail = lastMail(email, '激活');
  const link = linkFrom(mail);
  assert.match(link, /\/api\/auth\/verify\?token=/);

  // Unverified accounts cannot log in yet.
  const blocked = await request('/api/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, 'email_not_verified');

  const verify = await request(new URL(link).pathname + new URL(link).search, {
    redirect: 'manual',
  });
  assert.equal(verify.status, 302);
  assert.match(verify.headers.get('location'), /\/app\/#\/login\?verified=1/);

  // The same token cannot be used twice.
  const reused = await request(new URL(link).pathname + new URL(link).search, {
    redirect: 'manual',
  });
  assert.equal(reused.status, 302);
  assert.match(reused.headers.get('location'), /verify=invalid/);

  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  assert.equal(login.status, 200);
  assert.ok(login.data.token);
  assert.equal(login.data.user.email, email);
  assert.equal(login.data.user.emailVerified, true);
  token = login.data.token;
  userId = login.data.user.id;

  const duplicate = await request('/api/auth/register', {
    method: 'POST',
    body: { email, password },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.code, 'email_taken');
});

test('重新发送验证邮件', async () => {
  const pendingEmail = 'pending@example.com';
  const created = await request('/api/auth/register', {
    method: 'POST',
    body: { email: pendingEmail, password },
  });
  assert.equal(created.status, 201);

  const before = outbox.filter((message) => message.to === pendingEmail).length;
  const resent = await request('/api/auth/resend-verification', {
    method: 'POST',
    body: { email: pendingEmail },
  });
  assert.equal(resent.status, 200);
  const after = outbox.filter((message) => message.to === pendingEmail).length;
  assert.equal(after, before + 1);

  // Unknown addresses get the same response and no mail.
  const unknown = await request('/api/auth/resend-verification', {
    method: 'POST',
    body: { email: 'nobody@example.com' },
  });
  assert.equal(unknown.status, 200);
  assert.equal(outbox.filter((message) => message.to === 'nobody@example.com').length, 0);

  // Re-registering an unverified address resends instead of failing.
  const again = await request('/api/auth/register', {
    method: 'POST',
    body: { email: pendingEmail, password: 'password456' },
  });
  assert.equal(again.status, 200);
  assert.equal(again.data.status, 'pending_verification');
});

test('当前用户与密码修改', async () => {
  const me = await request('/api/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.id, userId);
  assert.equal(me.data.user.email, email);
  assert.equal(me.data.user.displayName, undefined);
  assert.equal(me.data.user.locale, undefined);
  assert.equal(me.data.user.usualOrigin, undefined);

  const anonymous = await request('/api/me');
  assert.equal(anonymous.status, 401);

  const wrong = await request('/api/me/password', {
    method: 'PUT',
    token,
    body: { currentPassword: 'wrong-password', newPassword: 'newpassword123' },
  });
  assert.equal(wrong.status, 401);

  const tooShort = await request('/api/me/password', {
    method: 'PUT',
    token,
    body: { currentPassword: password, newPassword: 'short' },
  });
  assert.equal(tooShort.status, 400);

  const otherLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  assert.equal(otherLogin.status, 200);

  const changed = await request('/api/me/password', {
    method: 'PUT',
    token,
    body: { currentPassword: password, newPassword: 'newpassword123' },
  });
  assert.equal(changed.status, 204);

  // The session that made the change stays valid; other devices are signed out.
  const stillMe = await request('/api/me', { token });
  assert.equal(stillMe.status, 200);
  const otherMe = await request('/api/me', { token: otherLogin.data.token });
  assert.equal(otherMe.status, 401);

  const oldPassword = await request('/api/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  assert.equal(oldPassword.status, 401);

  const newPassword = await request('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'newpassword123' },
  });
  assert.equal(newPassword.status, 200);
  token = newPassword.data.token;
});

test('行程和回忆只允许保存在客户端', async () => {
  const created = await request('/api/journeys', {
    method: 'POST', token, body: { name: '本机行程不应上传' },
  });
  assert.equal(created.status, 404);
  const updated = await request('/api/journeys/1', { method: 'PUT', token, body: { name: '修改' } });
  assert.equal(updated.status, 404);
  const deleted = await request('/api/journeys/1', { method: 'DELETE', token });
  assert.equal(deleted.status, 404);
  const memory = await request('/api/memories', { method: 'POST', token, body: { note: '本机回忆' } });
  assert.equal(memory.status, 404);
  const uploaded = await request('/api/memories/1/media', { method: 'POST', token, raw: true, body: Buffer.from('x'), contentType: 'image/png' });
  assert.equal(uploaded.status, 404);
});

test('忘记密码与重置密码', async () => {
  const unknown = await request('/api/auth/forgot-password', {
    method: 'POST',
    body: { email: 'nobody@example.com' },
  });
  assert.equal(unknown.status, 200);

  const forgot = await request('/api/auth/forgot-password', {
    method: 'POST',
    body: { email },
  });
  assert.equal(forgot.status, 200);

  const initialLink = linkFrom(lastMail(email, '重置'));
  assert.match(initialLink, /\/app\/#\/reset-password\?token=/);
  const resetUser = app.db.findUserByEmail(email);
  const initialReset = app.db.raw.prepare('SELECT expires_at FROM password_resets WHERE user_id = ?').get(resetUser.id);
  const resetLifetimeMs = Date.parse(initialReset.expires_at) - Date.now();
  assert.ok(resetLifetimeMs > 23 * 60 * 60 * 1000 && resetLifetimeMs <= 24 * 60 * 60 * 1000);
  const accountProfile = await request('/api/me', { token });
  assert.equal(accountProfile.status, 200);
  assert.equal(accountProfile.data.user.pendingResetExpiresAt, initialReset.expires_at);

  const resent = await request('/api/auth/forgot-password', {
    method: 'POST',
    body: { email, locale: 'zh' },
  });
  assert.equal(resent.status, 200);
  const resentLink = linkFrom(lastMail(email, '重置'));
  const resentToken = tokenFrom(resentLink);
  assert.equal(app.db.raw.prepare('SELECT COUNT(*) AS count FROM password_resets WHERE user_id = ?').get(resetUser.id).count, 1);
  const previousReset = await request('/api/auth/reset-password', {
    method: 'POST',
    body: { token: tokenFrom(initialLink), password: 'resetpassword1' },
  });
  assert.equal(previousReset.status, 400, 'resending invalidates the previous reset link');

  app.db.raw.prepare('UPDATE password_resets SET expires_at = ? WHERE user_id = ?').run(new Date(Date.now() - 1000).toISOString(), resetUser.id);
  const expiredReset = await request('/api/auth/reset-password', {
    method: 'POST',
    body: { token: resentToken, password: 'resetpassword1' },
  });
  assert.equal(expiredReset.status, 400, 'expired reset links cannot be used');
  await request('/api/auth/forgot-password', { method: 'POST', body: { email, locale: 'zh' } });
  const resetToken = tokenFrom(linkFrom(lastMail(email, '重置')));

  const badToken = await request('/api/auth/reset-password', {
    method: 'POST',
    body: { token: 'not-a-real-token', password: 'resetpassword1' },
  });
  assert.equal(badToken.status, 400);

  const reset = await request('/api/auth/reset-password', {
    method: 'POST',
    body: { token: resetToken, password: 'resetpassword1' },
  });
  assert.equal(reset.status, 204);

  // Resetting signs out existing sessions.
  const stale = await request('/api/me', { token });
  assert.equal(stale.status, 401);

  const reused = await request('/api/auth/reset-password', {
    method: 'POST',
    body: { token: resetToken, password: 'anotherpass1' },
  });
  assert.equal(reused.status, 400);

  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'resetpassword1' },
  });
  assert.equal(login.status, 200);
  token = login.data.token;
});

test('账户内密码重置邮件有效24小时并可重发', async () => {
  const first = await request('/api/me/password-reset', {
    method: 'POST', token, body: { locale: 'de' },
  });
  assert.equal(first.status, 200);
  const firstLifetime = Date.parse(first.data.pendingResetExpiresAt) - Date.now();
  assert.ok(firstLifetime > 23 * 60 * 60 * 1000 && firstLifetime <= 24 * 60 * 60 * 1000);
  const firstMail = [...outbox].reverse().find((message) => message.to === email && /Passwort/i.test(message.subject));
  assert.ok(firstMail);
  assert.match(firstMail.text, /24 Stunden/);
  const firstToken = tokenFrom(linkFrom(firstMail));
  const profile = await request('/api/me', { token });
  assert.equal(profile.data.user.pendingResetExpiresAt, first.data.pendingResetExpiresAt);

  const resent = await request('/api/me/password-reset', {
    method: 'POST', token, body: { locale: 'zh' },
  });
  assert.equal(resent.status, 200);
  assert.ok(Date.parse(resent.data.pendingResetExpiresAt) > Date.parse(first.data.pendingResetExpiresAt));
  const oldToken = await request('/api/auth/reset-password', {
    method: 'POST', body: { token: firstToken, password: 'anotherpass1' },
  });
  assert.equal(oldToken.status, 400, 'resending invalidates the previous link');
  const newest = await request('/api/me', { token });
  assert.equal(newest.data.user.pendingResetExpiresAt, resent.data.pendingResetExpiresAt);
});

test('界面语言保存在客户端且邮件语言按请求选择', async () => {
  const set = await request('/api/me/locale', { method: 'PUT', token, body: { locale: 'de' } });
  assert.equal(set.status, 404);
  const me = await request('/api/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.locale, undefined);

  const german = await request('/api/auth/forgot-password', { method: 'POST', body: { email, locale: 'de' } });
  assert.equal(german.status, 200);
  const message = [...outbox].reverse().find((item) => item.to === email && /Passwort/i.test(item.subject));
  assert.ok(message);
  assert.ok(message.text.includes('Hallo,'));

  const chinese = await request('/api/auth/forgot-password', { method: 'POST', body: { email, locale: 'zh' } });
  assert.equal(chinese.status, 200);
  const chineseMessage = [...outbox].reverse().find((item) => item.to === email && /重置/.test(item.subject));
  assert.ok(chineseMessage.text.includes('你好，'));
});

test('常用出发地只保存在客户端，地点解析仍可用', async () => {
  const saved = await request('/api/me/usual-origin', { method: 'PUT', token, body: { origins: [{ name: '家', country: '中国' }] } });
  assert.equal(saved.status, 404);
  const current = await request('/api/me', { token });
  assert.equal(current.data.user.usualOrigin, undefined);
  const parsed = await request('/api/me/usual-origin/parse', { method: 'POST', token, body: { text: '上海浦东张江路 88 号' } });
  assert.equal(parsed.status, 200);
  assert.equal(parsed.data.origin.name, '上海浦东张江路 88 号');
});

test('AI 描述接口（mock 模式）', async () => {
  const result = await request('/api/ai/journey-description', {
    method: 'POST',
    token,
    body: { name: '归墟' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.mock, true);
  assert.ok(result.data.description.includes('归墟'));
});

test('AI 旅程规划接口（mock 模式）', async () => {
  const result = await request('/api/ai/journey-plan', {
    method: 'POST',
    token,
    body: { prompt: '想去卢浮宫，雅典卫城还是新天鹅堡？' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.mock, true);
  assert.ok(Array.isArray(result.data.items));
  assert.ok(result.data.items.length > 0);
  assert.ok(result.data.items[0].destination);
  assert.ok('departTime' in result.data.items[0]);
  assert.ok('returnTime' in result.data.items[0]);
});

test('AI 旅程规划接口校验输入', async () => {
  const empty = await request('/api/ai/journey-plan', {
    method: 'POST',
    token,
    body: { prompt: '   ' },
  });
  assert.equal(empty.status, 400);

  const anonymous = await request('/api/ai/journey-plan', {
    method: 'POST',
    body: { prompt: '想去卢浮宫' },
  });
  assert.equal(anonymous.status, 401);
});

test('行程计划解析：标准 items 结构', () => {
  const plan = parseJourneyPlan(
    '{"items":[{"destination":"卢浮宫","departTime":"2026-12-15T09:30","returnTime":"2026-12-18T19:00"}]}',
  );
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].destination, '卢浮宫');
  assert.equal(plan.items[0].departTime, '2026-12-15T09:30');
  assert.equal(plan.items[0].returnTime, '2026-12-18T19:00');
});

test('行程计划解析：Markdown 代码块与别名字段', () => {
  const plan = parseJourneyPlan(
    '好的：\n```json\n{"destination":"雅典卫城","departure_date":"2026-12-15","return_date":"2026-12-18"}\n```',
  );
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].destination, '雅典卫城');
  assert.equal(plan.items[0].departTime, '2026-12-15T09:00');
  assert.equal(plan.items[0].returnTime, '2026-12-18T09:00');
});

test('行程计划解析：单个目的地写成数组时拆成多行', () => {
  const plan = parseJourneyPlan(
    '{"destination":["卢浮宫","雅典卫城"],"departure_date":"2026-12-15","return_date":"2026-12-18"}',
  );
  assert.equal(plan.items.length, 2);
  assert.deepEqual(
    plan.items.map((item) => item.destination),
    ['卢浮宫', '雅典卫城'],
  );
});

test('行程计划解析：单对象 + 目的地数组 + 日期别名', () => {
  // 智谱 GLM 常见的返回形态：单个对象，destination 是数组，时间用 *_date
  const plan = parseJourneyPlan(
    '```json\n{"destination":["卢浮宫","雅典卫城"],"departure_date":"2026-12-15","return_date":"2026-12-18"}\n```',
  );
  assert.equal(plan.items.length, 2);
  assert.deepEqual(
    plan.items.map((item) => item.destination),
    ['卢浮宫', '雅典卫城'],
  );
  assert.equal(plan.items[0].departTime, '2026-12-15T09:00');
  assert.equal(plan.items[0].returnTime, '2026-12-18T09:00');
});

test('行程计划解析：中文字段名也能识别', () => {
  const plan = parseJourneyPlan(
    '{"目的地":"新天鹅堡","出发时间":"2026-12-01T09:00","返回时间":"2026-12-03T19:00"}',
  );
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].destination, '新天鹅堡');
  assert.equal(plan.items[0].departTime, '2026-12-01T09:00');
  assert.equal(plan.items[0].returnTime, '2026-12-03T19:00');
});

test('行程计划解析：无法解析时报错', () => {
  assert.throws(() => parseJourneyPlan('完全不是 JSON'), /格式不正确/);
  assert.throws(() => parseJourneyPlan('{"items":[]}'), /可用的旅程计划/);
});

test('服务端拒绝保存新的结构化行程', async () => {
  const result = await request('/api/journeys', {
    method: 'POST', token,
    body: { name: '卢浮宫', plan: { items: [{ destination: '卢浮宫', departTime: '2026-11-19T09:30' }] } },
  });
  assert.equal(result.status, 404);
});

test('管理员状态包含用户与旅程统计', async () => {
  const status = await request('/api/admin/status', { admin: 'test-admin-token' });
  assert.equal(status.status, 200);
  assert.equal(status.data.stats.users, app.db.stats().users);
  const user = status.data.users.find((entry) => entry.id === userId);
  assert.equal(user.email, email);
  assert.equal(user.emailVerified, true);
  assert.ok(Array.isArray(status.data.requests));
  assert.ok(status.data.requests.some((entry) => entry.path === '/api/journeys'));
});

test('CORS 预检允许移动端 WebView', async () => {
  const result = await request('/api/me', { method: 'OPTIONS' });
  assert.equal(result.status, 204);
  assert.equal(result.headers.get('access-control-allow-origin'), '*');
  assert.match(result.headers.get('access-control-allow-headers'), /Authorization/i);
});

test('静态页面：看板与 HTML5 应用', async () => {
  const dashboard = await request('/');
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.text, /服务看板/);

  const appPage = await request('/app/');
  assert.equal(appPage.status, 200);
  assert.match(appPage.text, /小熊猫/);

  const script = await request('/app/app.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);

  const redirect = await fetch(`${base}/app`, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
});

test('回忆文字和媒体均不再写入服务端', async () => {
  const text = await request('/api/memories', { method: 'POST', token, body: { note: '留在本机' } });
  assert.equal(text.status, 404);
  const media = await request('/api/memories/1/media', { method: 'POST', token, raw: true, body: Buffer.from('photo'), contentType: 'image/png' });
  assert.equal(media.status, 404);
});

test('服务端拒绝回忆写入，即使内容为空', async () => {
  assert.equal((await request('/api/memories', { method: 'POST', token, body: { note: '   ' } })).status, 404);
  assert.equal((await request('/api/memories', { method: 'POST', body: { note: '匿名' } })).status, 404);
});

test('AI 回忆生成只接收客户端提供的临时上下文', async () => {
  const recap = await request('/api/ai/memory-recap', {
    method: 'POST', token,
    body: { journeyId: 1, context: { journeyName: '归墟', destination: '东海', photos: 0, videos: 0, notes: ['海面有光'] } },
  });
  assert.equal(recap.status, 200);
  assert.equal(recap.data.mock, true);
  assert.ok(recap.data.recap.includes('归墟'));
  const missing = await request('/api/ai/memory-recap', { method: 'POST', token, body: { journeyId: 'bad' } });
  assert.equal(missing.status, 200);
});

test('服务端不能删除客户端行程，登出仍可用', async () => {
  assert.equal((await request('/api/journeys/1', { method: 'DELETE', token })).status, 404);
  const logout = await request('/api/auth/logout', { method: 'POST', token });
  assert.equal(logout.status, 204);
  assert.equal((await request('/api/me', { token })).status, 401);
  const login = await request('/api/auth/login', { method: 'POST', body: { email, password: 'resetpassword1' } });
  assert.equal(login.status, 200);
  token = login.data.token;
});

test('账户资料、昵称和邮箱更换验证', async () => {
  const oldEmail = 'profile-owner@example.com';
  const nextEmail = 'profile-owner-new@example.com';
  await registerAndVerify(oldEmail, password);
  const login = await request('/api/auth/login', { method: 'POST', body: { email: oldEmail, password, locale: 'de' } });
  assert.equal(login.status, 200);
  const profileToken = login.data.token;

  const profile = await request('/api/me/profile', {
    method: 'PUT', token: profileToken, body: { displayName: '旅人小林' },
  });
  assert.equal(profile.status, 404);

  const requestChange = await request('/api/me/email', {
    method: 'PUT', token: profileToken, body: { email: nextEmail, locale: 'zh' },
  });
  assert.equal(requestChange.status, 200);
  assert.equal(requestChange.data.pendingEmail, nextEmail);
  const localizedChangeMail = lastMail(nextEmail, '验证新的邮箱');
  assert.ok(localizedChangeMail.text.includes('确认更换邮箱'));
  assert.match(localizedChangeMail.html, /lang="zh-CN"/);
  const lifetimeMs = Date.parse(requestChange.data.pendingEmailExpiresAt) - Date.now();
  assert.ok(lifetimeMs > 23 * 60 * 60 * 1000 && lifetimeMs <= 24 * 60 * 60 * 1000);

  const beforeVerification = await request('/api/me', { token: profileToken });
  assert.equal(beforeVerification.data.user.email, oldEmail);
  assert.equal(beforeVerification.data.user.pendingEmail, nextEmail);
  assert.equal(beforeVerification.data.user.displayName, undefined);
  const firstChangeMail = lastMail(nextEmail, '验证新的邮箱');
  const firstChangeToken = tokenFrom(linkFrom(firstChangeMail));
  const resendChange = await request('/api/me/email', {
    method: 'PUT', token: profileToken, body: { email: nextEmail, locale: 'zh' },
  });
  assert.equal(resendChange.status, 200);
  assert.ok(Date.parse(resendChange.data.pendingEmailExpiresAt) > Date.parse(requestChange.data.pendingEmailExpiresAt));
  const oldChangeLink = await request(`/api/auth/verify?token=${encodeURIComponent(firstChangeToken)}`, { redirect: 'manual' });
  assert.match(oldChangeLink.headers.get('location'), /verify=invalid/);
  const expiredAt = new Date(Date.now() - 1000).toISOString();
  app.db.raw.prepare('UPDATE email_verifications SET expires_at = ? WHERE user_id = ? AND target_email IS NOT NULL').run(expiredAt, login.data.user.id);
  const afterExpiry = await request('/api/me', { token: profileToken });
  assert.equal(afterExpiry.data.user.email, oldEmail);
  assert.equal(afterExpiry.data.user.pendingEmail, null);
  const expiredMail = lastMail(nextEmail, '验证新的邮箱');
  const expired = await request(new URL(linkFrom(expiredMail)).pathname + new URL(linkFrom(expiredMail)).search, { redirect: 'manual' });
  assert.match(expired.headers.get('location'), /verify=invalid/);
  assert.equal((await request('/api/me', { token: profileToken })).data.user.email, oldEmail);

  const retry = await request('/api/me/email', { method: 'PUT', token: profileToken, body: { email: nextEmail, locale: 'zh' } });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.pendingEmail, nextEmail);
  const mail = lastMail(nextEmail, '验证新的邮箱');
  const verify = await request(new URL(linkFrom(mail)).pathname + new URL(linkFrom(mail)).search, { redirect: 'manual' });
  assert.match(verify.headers.get('location'), /settings\/account-security\?emailChanged=1/);

  const afterVerification = await request('/api/me', { token: profileToken });
  assert.equal(afterVerification.data.user.email, nextEmail);
  assert.equal(afterVerification.data.user.pendingEmail, null);
  const usernameLogin = await request('/api/auth/login', { method: 'POST', body: { username: 'profile-owner', password } });
  assert.equal(usernameLogin.status, 400);

});
