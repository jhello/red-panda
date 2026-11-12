import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odyssey-test-'));
const config = loadConfig({
  ...process.env,
  ODYSSEY_DATA_DIR: tempDir,
  ODYSSEY_DB: path.join(tempDir, 'test.db'),
  ODYSSEY_ADMIN_TOKEN: 'test-admin-token',
  ODYSSEY_AI_MOCK: '1',
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

async function request(pathname, { method = 'GET', token, body, admin, redirect } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (admin) headers['X-Admin-Token'] = admin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    redirect,
    body: body === undefined ? undefined : JSON.stringify(body),
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
  assert.equal(result.data.name, '山海经');
});

test('管理看板接口需要管理员令牌', async () => {
  const denied = await request('/api/admin/status');
  assert.equal(denied.status, 401);

  const wrong = await request('/api/admin/status', { admin: 'nope' });
  assert.equal(wrong.status, 401);

  const ok = await request('/api/admin/status', { admin: 'test-admin-token' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.server.name, 'Odyssey');
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
  assert.equal(me.data.user.displayName, 'traveler');

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

test('旅程 CRUD', async () => {
  const emptyName = await request('/api/journeys', {
    method: 'POST',
    token,
    body: { name: '   ', description: 'x' },
  });
  assert.equal(emptyName.status, 400);

  const created = await request('/api/journeys', {
    method: 'POST',
    token,
    body: { name: '昆仑之丘', description: '向西三千里，见山如黛。' },
  });
  assert.equal(created.status, 201);
  journeyId = created.data.journey.id;

  const list = await request('/api/journeys', { token });
  assert.equal(list.status, 200);
  assert.equal(list.data.journeys.length, 1);
  assert.equal(list.data.journeys[0].name, '昆仑之丘');

  const one = await request(`/api/journeys/${journeyId}`, { token });
  assert.equal(one.status, 200);
  assert.equal(one.data.journey.description, '向西三千里，见山如黛。');

  const updated = await request(`/api/journeys/${journeyId}`, {
    method: 'PUT',
    token,
    body: { name: '昆仑之丘 · 夜', description: '月色落在山脊上。' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.journey.name, '昆仑之丘 · 夜');

  await registerAndVerify('other@example.com', 'password456');
  const otherLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'other@example.com', password: 'password456' },
  });
  assert.equal(otherLogin.status, 200);
  const foreign = await request(`/api/journeys/${journeyId}`, {
    token: otherLogin.data.token,
  });
  assert.equal(foreign.status, 404);
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

  const link = linkFrom(lastMail(email, '重置'));
  assert.match(link, /\/app\/#\/reset-password\?token=/);
  const resetToken = tokenFrom(link);

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

test('管理员状态包含用户与旅程统计', async () => {
  const status = await request('/api/admin/status', { admin: 'test-admin-token' });
  assert.equal(status.status, 200);
  assert.equal(status.data.stats.users, 3);
  assert.equal(status.data.stats.journeys, 1);
  const user = status.data.users.find((entry) => entry.id === userId);
  assert.equal(user.journeyCount, 1);
  assert.equal(user.email, email);
  assert.equal(user.emailVerified, true);
  assert.ok(Array.isArray(status.data.requests));
  assert.ok(status.data.requests.some((entry) => entry.path === '/api/journeys'));
});

test('CORS 预检允许移动端 WebView', async () => {
  const result = await request('/api/journeys', { method: 'OPTIONS' });
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
  assert.match(appPage.text, /山海经/);

  const script = await request('/app/app.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);

  const redirect = await fetch(`${base}/app`, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
});

test('删除旅程与登出', async () => {
  const deleted = await request(`/api/journeys/${journeyId}`, { method: 'DELETE', token });
  assert.equal(deleted.status, 204);

  const missing = await request(`/api/journeys/${journeyId}`, { token });
  assert.equal(missing.status, 404);

  const logout = await request('/api/auth/logout', { method: 'POST', token });
  assert.equal(logout.status, 204);

  const afterLogout = await request('/api/me', { token });
  assert.equal(afterLogout.status, 401);
});
