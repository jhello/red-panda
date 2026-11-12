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

test('用户语言设置与本地化邮件', async () => {
  const bad = await request('/api/me/locale', {
    method: 'PUT',
    token,
    body: { locale: 'fr' },
  });
  assert.equal(bad.status, 400);

  const set = await request('/api/me/locale', {
    method: 'PUT',
    token,
    body: { locale: 'de' },
  });
  assert.equal(set.status, 200);
  assert.equal(set.data.locale, 'de');

  const me = await request('/api/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.locale, 'de');

  // The reset email now arrives in German.
  const forgot = await request('/api/auth/forgot-password', {
    method: 'POST',
    body: { email },
  });
  assert.equal(forgot.status, 200);
  const german = [...outbox]
    .reverse()
    .find((message) => message.to === email && /Passwort/i.test(message.subject));
  assert.ok(german, '应该有德语重置邮件');
  assert.ok(german.html.includes('Neues Passwort festlegen'));
  assert.ok(german.text.includes('Hallo,'));
  assert.match(german.text, /https?:\/\/\S+/);

  // Logging in with an app language keeps the stored preference in sync.
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'resetpassword1', locale: 'en' },
  });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.locale, 'en');

  // Restore Chinese so later tests see the default language.
  const restore = await request('/api/me/locale', {
    method: 'PUT',
    token: login.data.token,
    body: { locale: 'zh' },
  });
  assert.equal(restore.status, 200);
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

test('创建旅程时保存结构化行程，并按出发时间排序', async () => {
  const plan = {
    items: [
      { destination: '雅典卫城', departTime: '2026-12-20T09:00', returnTime: '2026-12-22T19:00' },
      { destination: '卢浮宫', departTime: '2026-11-19T09:30', returnTime: '2026-11-21T19:00' },
    ],
  };
  const created = await request('/api/journeys', {
    method: 'POST',
    token,
    body: { name: '卢浮宫', description: '两站行程', plan },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.journey.plan.items.length, 2);
  assert.equal(created.data.journey.plan.items[0].destination, '雅典卫城');
  // 最早出发时间与最晚返回时间被提取出来，便于按时间排序
  assert.equal(created.data.journey.depart_time, '2026-11-19T09:30');
  assert.equal(created.data.journey.return_time, '2026-12-22T19:00');

  const later = await request('/api/journeys', {
    method: 'POST',
    token,
    body: {
      name: '更早的旅程',
      description: '',
      plan: { items: [{ destination: '新天鹅堡', departTime: '2026-01-05T08:00', returnTime: '2026-01-07T20:00' }] },
    },
  });
  assert.equal(later.status, 201);

  const list = await request('/api/journeys', { token });
  assert.equal(list.status, 200);
  const names = list.data.journeys.map((journey) => journey.name);
  // 按出发时间升序：更早的行程排在前面
  assert.equal(names[0], '更早的旅程');
  assert.equal(names[names.length - 1], '卢浮宫');

  // 清理本次新增的两条，避免影响其它用例
  for (const journey of list.data.journeys) {
    if (journey.name === '更早的旅程' || journey.name === '卢浮宫') {
      await request(`/api/journeys/${journey.id}`, { method: 'DELETE', token });
    }
  }
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
  assert.match(appPage.text, /小熊猫/);

  const script = await request('/app/app.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);

  const redirect = await fetch(`${base}/app`, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
});

test('回忆：给走过的行程添加照片、视频和文字', async () => {
  const created = await request('/api/journeys', {
    method: 'POST',
    token,
    body: {
      name: '青丘旧事',
      plan: { items: [{ destination: '青丘', departTime: '2026-01-05T08:00', returnTime: '2026-01-07T20:00' }] },
    },
  });
  assert.equal(created.status, 201);
  const targetId = created.data.journey.id;

  const memory = await request('/api/memories', {
    method: 'POST',
    token,
    body: { journeyId: targetId, note: '那天风很大，狐狸在墙头看我。' },
  });
  assert.equal(memory.status, 201);
  assert.equal(memory.data.memory.note, '那天风很大，狐狸在墙头看我。');
  assert.equal(memory.data.memory.journeyId, targetId);
  assert.deepEqual(memory.data.memory.media, []);

  // 上传照片：请求体就是文件本身
  const upload = await request(`/api/memories/${memory.data.memory.id}/media`, {
    method: 'POST',
    token,
    raw: true,
    body: Buffer.from('89504e470d0a1a0a', 'hex'),
    contentType: 'image/png',
  });
  assert.equal(upload.status, 201);
  assert.equal(upload.data.media.kind, 'image');
  assert.equal(upload.data.media.mime, 'image/png');
  assert.match(upload.data.media.url, /^\/api\/media\/[a-f0-9]{32}$/);

  // 其它类型一律拒绝
  const bad = await request(`/api/memories/${memory.data.memory.id}/media`, {
    method: 'POST',
    token,
    raw: true,
    body: Buffer.from('hello'),
    contentType: 'text/plain',
  });
  assert.equal(bad.status, 415);

  // 媒体文件可以用访问密钥取回，并且支持 Range（视频要能拖进度）
  const file = await fetch(`${base}${upload.data.media.url}`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  const range = await fetch(`${base}${upload.data.media.url}`, { headers: { Range: 'bytes=0-3' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-length'), '4');

  // 列表：可以按行程过滤，并带上每段行程的回忆数量
  const list = await request(`/api/memories?journeyId=${targetId}`, { token });
  assert.equal(list.status, 200);
  assert.equal(list.data.memories.length, 1);
  assert.equal(list.data.memories[0].media.length, 1);
  assert.equal(list.data.counts[targetId], 1);

  // 别人的行程写不了回忆
  await registerAndVerify('stranger@example.com', 'password456');
  const stranger = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'stranger@example.com', password: 'password456' },
  });
  const foreign = await request('/api/memories', {
    method: 'POST',
    token: stranger.data.token,
    body: { journeyId: targetId, note: '偷偷写一条' },
  });
  assert.equal(foreign.status, 404);

  // 删除回忆时，照片也一起清掉
  const deleted = await request(`/api/memories/${memory.data.memory.id}`, { method: 'DELETE', token });
  assert.equal(deleted.status, 204);
  const gone = await fetch(`${base}${upload.data.media.url}`);
  assert.equal(gone.status, 404);

  await request(`/api/journeys/${targetId}`, { method: 'DELETE', token });
});

test('回忆：文字与行程至少要有一项', async () => {
  const empty = await request('/api/memories', { method: 'POST', token, body: { note: '   ' } });
  assert.equal(empty.status, 400);

  const anonymous = await request('/api/memories', { method: 'POST', body: { note: '没有登录' } });
  assert.equal(anonymous.status, 401);
});

test('AI 回忆生成（mock 模式）', async () => {
  const created = await request('/api/journeys', {
    method: 'POST',
    token,
    body: { name: '归墟' },
  });
  const targetId = created.data.journey.id;

  const recap = await request('/api/ai/memory-recap', {
    method: 'POST',
    token,
    body: { journeyId: targetId },
  });
  assert.equal(recap.status, 200);
  assert.equal(recap.data.mock, true);
  assert.ok(recap.data.recap.includes('归墟'));

  const missing = await request('/api/ai/memory-recap', {
    method: 'POST',
    token,
    body: { journeyId: 999999 },
  });
  assert.equal(missing.status, 404);

  await request(`/api/journeys/${targetId}`, { method: 'DELETE', token });
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
