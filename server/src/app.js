import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { URL } from 'node:url';

import { AIError, aiStatus, chat } from './ai.js';
import { hashPassword, hashToken, newSessionToken, safeEqual, verifyPassword } from './auth.js';
import { fileSize, openDatabase } from './db.js';
import { getLanUrls } from './config.js';

const MAX_BODY_BYTES = 1024 * 1024;
const USERNAME_RE = /^[\p{L}\p{N}_-]{2,32}$/u;
const ONLINE_WINDOW_MS = 5 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message, code = 'error') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function sendJson(res, status, payload) {
  if (res.headersSent) return;
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendEmpty(res, status) {
  if (res.headersSent) return;
  res.writeHead(status);
  res.end();
}

function setApiHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Admin-Token');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, '请求内容过大', 'payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new HttpError(400, '请求体必须是 JSON 对象', 'bad_json'));
        }
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'JSON 格式不正确', 'bad_json'));
      }
    });
    req.on('error', reject);
  });
}

function requiredString(value, label, { min = 0, max = 200, trim = true } = {}) {
  if (typeof value !== 'string') {
    throw new HttpError(400, `${label}格式不正确`, 'validation_error');
  }
  const text = trim ? value.trim() : value;
  if (text.length < min) throw new HttpError(400, `${label}不能为空`, 'validation_error');
  if (text.length > max) throw new HttpError(400, `${label}不能超过 ${max} 个字符`, 'validation_error');
  return text;
}

function optionalString(value, label, max = 5000) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new HttpError(400, `${label}格式不正确`, 'validation_error');
  const text = value.trim();
  if (text.length > max) throw new HttpError(400, `${label}不能超过 ${max} 个字符`, 'validation_error');
  return text;
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    createdAt: row.created_at,
  };
}

function safeJoin(baseDir, relativePath) {
  let decoded;
  try {
    decoded = decodeURIComponent(relativePath);
  } catch {
    return null;
  }
  const resolved = path.resolve(baseDir, `.${path.sep}${decoded}`);
  const base = path.resolve(baseDir);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) return null;
  return resolved;
}

function serveFile(req, res, filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
  if (req.method === 'HEAD') {
    res.end();
  } else {
    fs.createReadStream(filePath).pipe(res);
  }
  return true;
}

function notFound(req, res) {
  if (req.url?.startsWith('/api/')) {
    sendJson(res, 404, { error: '接口不存在', code: 'not_found' });
    return;
  }
  const body = Buffer.from(
    '<!doctype html><meta charset="utf-8"><title>404</title>' +
      '<style>body{font-family:system-ui;background:#f7f2e8;color:#22282b;display:grid;place-items:center;height:100vh;margin:0}' +
      'div{text-align:center}h1{font-size:64px;margin:0;color:#a83a2c}p{color:#6b7375}</style>' +
      '<div><h1>404</h1><p>这一页山海尚未写成。</p><p><a href="/">返回控制台</a> · <a href="/app/">打开应用</a></p></div>',
  );
  res.writeHead(404, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(body);
}

export function createApp(config) {
  const db = openDatabase(config.dbPath);
  const startedAt = new Date();
  const lanUrls = getLanUrls(config.port);
  const state = {
    startedAt,
    lanUrls,
    requestLog: [],
    metrics: { total: 0, byStatus: {}, aiCalls: 0 },
  };
  const loginAttempts = new Map();

  const routes = [];

  function route(method, pattern, handler, options = {}) {
    routes.push({ method, pattern, handler, auth: options.auth === true, admin: options.admin === true });
  }

  function authenticate(req) {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return null;
    const tokenHash = hashToken(match[1].trim());
    const row = db.findSession(tokenHash);
    if (!row) return null;
    if (Date.parse(row.expires_at) <= Date.now()) {
      db.deleteSession(tokenHash);
      return null;
    }
    const now = new Date().toISOString();
    db.touchSeen(row.user_id, now);
    db.touchSession(tokenHash, now);
    return {
      tokenHash,
      user: { id: row.user_id, username: row.username, createdAt: row.user_created_at },
    };
  }

  function isAdmin(req) {
    const token = req.headers['x-admin-token'];
    if (typeof token !== 'string' || token === '') return false;
    return safeEqual(token, config.adminToken);
  }

  function issueSession(userId) {
    const token = newSessionToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.sessionDays * 24 * 60 * 60 * 1000);
    db.createSession({
      tokenHash: hashToken(token),
      userId,
      now: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    return { token, expiresAt: expiresAt.toISOString() };
  }

  function checkLoginRate(ip) {
    const now = Date.now();
    const entry = loginAttempts.get(ip);
    if (!entry || entry.resetAt <= now) {
      loginAttempts.set(ip, { count: 0, resetAt: now + 10 * 60 * 1000 });
      return;
    }
    if (entry.count >= 20) {
      throw new HttpError(429, '尝试次数过多，请十分钟后再试', 'rate_limited');
    }
  }

  function noteLoginFailure(ip) {
    const entry = loginAttempts.get(ip);
    if (entry) entry.count += 1;
  }

  function buildStatus() {
    const now = Date.now();
    const memory = process.memoryUsage();
    const users = db.listUsers().map((user) => ({
      id: user.id,
      username: user.username,
      createdAt: user.created_at,
      lastLoginAt: user.last_login_at,
      lastSeenAt: user.last_seen_at,
      journeyCount: user.journey_count,
      online: Boolean(user.last_seen_at) && now - Date.parse(user.last_seen_at) < ONLINE_WINDOW_MS,
    }));
    return {
      server: {
        name: 'Odyssey',
        version: config.version,
        startedAt: state.startedAt.toISOString(),
        uptimeSeconds: Math.floor((now - state.startedAt.getTime()) / 1000),
        hostname: os.hostname(),
        platform: `${os.type()} ${os.release()}`,
        arch: os.arch(),
        node: process.version,
        pid: process.pid,
        host: config.host,
        port: config.port,
        urls: state.lanUrls,
        memory: {
          rss: memory.rss,
          heapUsed: memory.heapUsed,
          heapTotal: memory.heapTotal,
        },
        loadavg: os.loadavg(),
        cpuCount: os.cpus().length,
        dbPath: config.dbPath,
        dbSizeBytes: fileSize(config.dbPath),
      },
      ai: aiStatus(config),
      stats: {
        ...db.stats(),
        requestsTotal: state.metrics.total,
        requestsByStatus: state.metrics.byStatus,
        aiCalls: state.metrics.aiCalls,
      },
      users,
      requests: state.requestLog.slice(-60).reverse(),
    };
  }

  // ---- public routes -------------------------------------------------------

  route('GET', /^\/api\/health$/, () => ({
    status: 200,
    body: {
      ok: true,
      service: 'odyssey',
      name: '山海经',
      version: config.version,
      time: new Date().toISOString(),
    },
  }));

  route(
    'GET',
    /^\/api\/admin\/status$/,
    () => ({ status: 200, body: buildStatus() }),
    { admin: true },
  );

  route('POST', /^\/api\/auth\/register$/, async ({ body, req }) => {
    const username = requiredString(body.username, '用户名', { min: 2, max: 32 });
    if (!USERNAME_RE.test(username)) {
      throw new HttpError(
        400,
        '用户名需为 2–32 位中文、字母、数字、下划线或短横线',
        'validation_error',
      );
    }
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 8) throw new HttpError(400, '密码至少需要 8 个字符', 'validation_error');
    if (password.length > 128) throw new HttpError(400, '密码不能超过 128 个字符', 'validation_error');

    const now = new Date().toISOString();
    let userId;
    try {
      userId = db.createUser({ username, passwordHash: hashPassword(password), now });
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) {
        throw new HttpError(409, '这个用户名已经被使用了', 'username_taken');
      }
      throw error;
    }
    const session = issueSession(userId);
    const user = db.findUserById(userId);
    return {
      status: 201,
      body: { token: session.token, expiresAt: session.expiresAt, user: publicUser(user) },
    };
  });

  route('POST', /^\/api\/auth\/login$/, async ({ body, req }) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    checkLoginRate(ip);
    const username = requiredString(body.username, '用户名', { min: 1, max: 32 });
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password) throw new HttpError(400, '请输入密码', 'validation_error');

    const user = db.findUserByUsername(username);
    if (!user || !verifyPassword(password, user.password_hash)) {
      noteLoginFailure(ip);
      throw new HttpError(401, '用户名或密码不正确', 'invalid_credentials');
    }
    loginAttempts.delete(ip);
    const now = new Date().toISOString();
    db.touchLogin(user.id, now);
    const session = issueSession(user.id);
    return {
      status: 200,
      body: { token: session.token, expiresAt: session.expiresAt, user: publicUser(user) },
    };
  });

  // ---- authenticated routes ------------------------------------------------

  route(
    'POST',
    /^\/api\/auth\/logout$/,
    ({ auth }) => {
      db.deleteSession(auth.tokenHash);
      return { status: 204 };
    },
    { auth: true },
  );

  route(
    'GET',
    /^\/api\/me$/,
    ({ auth }) => ({
      status: 200,
      body: { user: { id: auth.user.id, username: auth.user.username, createdAt: auth.user.createdAt } },
    }),
    { auth: true },
  );

  route(
    'GET',
    /^\/api\/journeys$/,
    ({ auth }) => ({
      status: 200,
      body: { journeys: db.listJourneys(auth.user.id) },
    }),
    { auth: true },
  );

  route(
    'POST',
    /^\/api\/journeys$/,
    ({ auth, body }) => {
      const name = requiredString(body.name, '旅程名称', { min: 1, max: 80 });
      const description = optionalString(body.description, '旅程描述', 5000);
      const journey = db.createJourney({
        userId: auth.user.id,
        name,
        description,
        now: new Date().toISOString(),
      });
      return { status: 201, body: { journey } };
    },
    { auth: true },
  );

  route(
    'GET',
    /^\/api\/journeys\/(\d+)$/,
    ({ auth, params }) => {
      const journey = db.getJourney(auth.user.id, Number(params[0]));
      if (!journey) throw new HttpError(404, '旅程不存在', 'not_found');
      return { status: 200, body: { journey } };
    },
    { auth: true },
  );

  route(
    'PUT',
    /^\/api\/journeys\/(\d+)$/,
    ({ auth, params, body }) => {
      const name = requiredString(body.name, '旅程名称', { min: 1, max: 80 });
      const description = optionalString(body.description, '旅程描述', 5000);
      const journey = db.updateJourney({
        userId: auth.user.id,
        id: Number(params[0]),
        name,
        description,
        now: new Date().toISOString(),
      });
      if (!journey) throw new HttpError(404, '旅程不存在', 'not_found');
      return { status: 200, body: { journey } };
    },
    { auth: true },
  );

  route(
    'DELETE',
    /^\/api\/journeys\/(\d+)$/,
    ({ auth, params }) => {
      const deleted = db.deleteJourney(auth.user.id, Number(params[0]));
      if (!deleted) throw new HttpError(404, '旅程不存在', 'not_found');
      return { status: 204 };
    },
    { auth: true },
  );

  route(
    'POST',
    /^\/api\/ai\/journey-description$/,
    async ({ body }) => {
      const name = requiredString(body.name, '旅程名称', { min: 1, max: 80 });
      const hint = optionalString(body.hint, '补充线索', 300);
      const result = await chat(
        config,
        [
          {
            role: 'system',
            content:
              '你是《山海经》世界的向导，擅长用简洁、富有画面感的中文为旅程写简介。' +
              '只输出简介正文，不要标题、不要引号，控制在 120 字以内。',
          },
          {
            role: 'user',
            content: `旅程名称：${name}\n${hint ? `补充线索：${hint}\n` : ''}请为这段旅程写一段简介。`,
          },
        ],
        { maxTokens: 400, temperature: 0.9 },
      );
      state.metrics.aiCalls += 1;
      return {
        status: 200,
        body: { description: result.content, model: result.model, mock: result.mock },
      };
    },
    { auth: true },
  );

  route(
    'POST',
    /^\/api\/ai\/chat$/,
    async ({ body }) => {
      const messages = Array.isArray(body.messages) ? body.messages : null;
      if (!messages || messages.length === 0 || messages.length > 20) {
        throw new HttpError(400, 'messages 需为 1–20 条消息', 'validation_error');
      }
      const cleaned = messages.map((message) => {
        if (!message || typeof message !== 'object') {
          throw new HttpError(400, '消息格式不正确', 'validation_error');
        }
        if (!['system', 'user', 'assistant'].includes(message.role)) {
          throw new HttpError(400, '消息角色不正确', 'validation_error');
        }
        if (typeof message.content !== 'string' || message.content.length === 0) {
          throw new HttpError(400, '消息内容不能为空', 'validation_error');
        }
        if (message.content.length > 4000) {
          throw new HttpError(400, '单条消息不能超过 4000 个字符', 'validation_error');
        }
        return { role: message.role, content: message.content };
      });
      if (typeof body.system === 'string' && body.system.trim()) {
        cleaned.unshift({ role: 'system', content: body.system.trim().slice(0, 2000) });
      }
      const result = await chat(config, cleaned, { maxTokens: 800, temperature: 0.7 });
      state.metrics.aiCalls += 1;
      return {
        status: 200,
        body: { content: result.content, model: result.model, usage: result.usage, mock: result.mock },
      };
    },
    { auth: true },
  );

  // ---- request handling ----------------------------------------------------

  const server = http.createServer(async (req, res) => {
    const started = performance.now();
    let status = 500;
    let pathname = '/';

    try {
      let parsed;
      try {
        parsed = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        pathname = decodeURIComponent(parsed.pathname);
      } catch {
        throw new HttpError(400, '请求地址不正确', 'bad_url');
      }

      if (pathname.startsWith('/api/')) {
        setApiHeaders(res);
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          status = 204;
          return;
        }

        const matched = routes.find(
          (candidate) => candidate.method === req.method && candidate.pattern.test(pathname),
        );
        if (!matched) throw new HttpError(404, '接口不存在', 'not_found');

        const params = matched.pattern.exec(pathname).slice(1);
        if (matched.admin && !isAdmin(req)) {
          throw new HttpError(401, '管理员令牌无效', 'admin_unauthorized');
        }

        let auth = null;
        if (matched.auth) {
          auth = authenticate(req);
          if (!auth) throw new HttpError(401, '登录已失效，请重新登录', 'unauthorized');
        }

        let body = {};
        if (['POST', 'PUT', 'PATCH'].includes(req.method ?? '')) {
          body = await readJson(req);
        }

        const result = await matched.handler({ req, res, body, params, auth });
        status = result?.status ?? 200;
        if (result?.body !== undefined) {
          sendJson(res, status, result.body);
        } else {
          sendEmpty(res, status);
        }
        return;
      }

      // Static content: dashboard at /, shared web client at /app/.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw new HttpError(405, '只支持 GET', 'method_not_allowed');
      }

      let filePath = null;
      if (pathname === '/' || pathname === '/dashboard' || pathname === '/dashboard/') {
        filePath = path.join(config.dashboardDir, 'index.html');
      } else if (pathname.startsWith('/dashboard/')) {
        filePath = safeJoin(config.dashboardDir, pathname.slice('/dashboard/'.length));
      } else if (pathname === '/app') {
        res.writeHead(302, { Location: '/app/' });
        res.end();
        status = 302;
        return;
      } else if (pathname === '/app/') {
        filePath = path.join(config.webDir, 'index.html');
      } else if (pathname.startsWith('/app/')) {
        filePath = safeJoin(config.webDir, pathname.slice('/app/'.length));
      } else if (pathname === '/favicon.ico') {
        filePath = path.join(config.webDir, 'icon.svg');
      }

      if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }

      if (filePath && serveFile(req, res, filePath)) {
        status = 200;
        return;
      }
      notFound(req, res);
      status = 404;
    } catch (error) {
      if (error instanceof HttpError) {
        status = error.status;
        sendJson(res, status, { error: error.message, code: error.code });
      } else if (error instanceof AIError) {
        status = error.status;
        sendJson(res, status, { error: error.message, code: error.code });
      } else {
        status = 500;
        console.error('[odyssey] unhandled error:', error);
        sendJson(res, 500, { error: '服务器内部错误', code: 'internal_error' });
      }
    } finally {
      const duration = Math.round(performance.now() - started);
      const tracked =
        pathname.startsWith('/api/') &&
        pathname !== '/api/health' &&
        pathname !== '/api/admin/status';

      if (tracked) {
        state.metrics.total += 1;
        state.metrics.byStatus[status] = (state.metrics.byStatus[status] ?? 0) + 1;
        state.requestLog.push({
          time: new Date().toISOString(),
          method: req.method,
          path: pathname,
          status,
          ms: duration,
          ip: req.socket.remoteAddress ?? '',
        });
        if (state.requestLog.length > 200) state.requestLog.shift();
        console.log(
          `[odyssey] ${req.method} ${pathname} → ${status} (${duration}ms)`,
        );
      } else if (status >= 500) {
        console.error(`[odyssey] ${req.method} ${pathname} → ${status} (${duration}ms)`);
      }
    }
  });

  const cleanup = setInterval(() => {
    try {
      db.deleteExpiredSessions();
    } catch (error) {
      console.error('[odyssey] session cleanup failed:', error);
    }
  }, 60 * 60 * 1000);
  cleanup.unref();

  return {
    server,
    db,
    state,
    async close() {
      clearInterval(cleanup);
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

export function startServer(config) {
  const app = createApp(config);
  return new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(config.port, config.host, () => {
      app.server.removeListener('error', reject);
      resolve(app);
    });
  });
}

export function adminTokenMatches(token, config) {
  return safeEqual(String(token ?? ''), config.adminToken);
}

export { HttpError };
