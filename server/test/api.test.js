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

const app = createApp(config);
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;

after(async () => {
  await app.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function request(pathname, { method = 'GET', token, body, admin } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (admin) headers['X-Admin-Token'] = admin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
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

test('注册校验与注册成功', async () => {
  const shortPassword = await request('/api/auth/register', {
    method: 'POST',
    body: { username: '旅人', password: 'short' },
  });
  assert.equal(shortPassword.status, 400);

  const badName = await request('/api/auth/register', {
    method: 'POST',
    body: { username: 'a', password: 'password123' },
  });
  assert.equal(badName.status, 400);

  const created = await request('/api/auth/register', {
    method: 'POST',
    body: { username: '旅人_测试', password: 'password123' },
  });
  assert.equal(created.status, 201);
  assert.ok(created.data.token);
  assert.equal(created.data.user.username, '旅人_测试');
  token = created.data.token;
  userId = created.data.user.id;

  const duplicate = await request('/api/auth/register', {
    method: 'POST',
    body: { username: '旅人_测试', password: 'password123' },
  });
  assert.equal(duplicate.status, 409);
});

test('登录与当前用户', async () => {
  const wrong = await request('/api/auth/login', {
    method: 'POST',
    body: { username: '旅人_测试', password: 'wrong-password' },
  });
  assert.equal(wrong.status, 401);

  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { username: '旅人_测试', password: 'password123' },
  });
  assert.equal(login.status, 200);
  assert.ok(login.data.token);
  token = login.data.token;

  const me = await request('/api/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.id, userId);

  const anonymous = await request('/api/me');
  assert.equal(anonymous.status, 401);
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

  const other = await request('/api/auth/register', {
    method: 'POST',
    body: { username: '另一位旅人', password: 'password456' },
  });
  assert.equal(other.status, 201);
  const foreign = await request(`/api/journeys/${journeyId}`, { token: other.data.token });
  assert.equal(foreign.status, 404);
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
  assert.equal(status.data.stats.users, 2);
  assert.equal(status.data.stats.journeys, 1);
  assert.equal(status.data.users.find((user) => user.id === userId).journeyCount, 1);
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
