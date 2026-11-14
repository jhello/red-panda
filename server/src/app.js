import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { URL } from 'node:url';

import { AIError, aiStatus, chat, mockPlan, mockRecap } from './ai.js';
import { hashPassword, hashToken, newSessionToken, safeEqual, verifyPassword } from './auth.js';
import { fileSize, openDatabase } from './db.js';
import { getLanUrls } from './config.js';
import { createMailer } from './mailer.js';
import { emailChangeVerificationEmail, resetEmail, verificationEmail } from './emails.js';

const MAX_BODY_BYTES = 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
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

function normalizeEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (email.length < 5 || email.length > 254 || !EMAIL_RE.test(email)) {
    throw new HttpError(400, '请输入有效的邮箱地址', 'validation_error');
  }
  return email;
}

const SUPPORTED_LOCALES = new Set(['zh', 'en', 'de']);

/** Accept "zh", "en", "de" and common BCP-47 tags such as zh-Hans-DE or de-AT. */
function normalizeLocale(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (SUPPORTED_LOCALES.has(text)) return text;
  if (text.startsWith('zh')) return 'zh';
  if (text.startsWith('en')) return 'en';
  if (text.startsWith('de')) return 'de';
  return '';
}

/** Field aliases a model may use for each field of a journey plan. */
const PLAN_FIELD_ALIASES = {
  destination: ['destination', 'dest', 'place', 'city', 'spot', 'name', '目的地', '地点', '城市'],
  departTime: [
    'departTime', 'departureTime', 'departure_time', 'departureDate', 'departure_date',
    'depart', 'departure', 'start', 'startTime', 'start_time', '出发时间', '出发日期', '出发',
  ],
  returnTime: [
    'returnTime', 'return_time', 'returnDate', 'return_date', 'return',
    'end', 'endTime', 'end_time', 'finish', 'finishTime', '返回时间', '返回日期', '返回',
  ],
};

function pickPlanField(raw, kind) {
  for (const key of PLAN_FIELD_ALIASES[kind]) {
    const value = raw[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

/** Normalize a date/time string to YYYY-MM-DDTHH:mm (empty when unusable). */
function normalizePlanTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const dateTime = /^(\d{4})-(\d{1,2})-(\d{1,2})[T\s]+(\d{1,2}):(\d{2})/.exec(text);
  if (dateTime) {
    const [, y, m, d, hh, mm] = dateTime;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${mm}`;
  }
  const dateOnly = /^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?$/.exec(text);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T09:00`;
  }
  return '';
}

/** Today's date, so the model can resolve relative dates like "下个月15号". */
function todayContext() {
  const now = new Date();
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}（星期${weekdays[now.getDay()]}）`;
}

/**
 * Turn an LLM answer into a normalized journey plan:
 * { items: [{ destination, departTime, returnTime }] }.
 * Models answer in slightly different shapes, so accept a single object,
 * an array, or { items: [...] }, and read common field aliases.
 */
export function parseJourneyPlan(content) {
  let text = String(content ?? '').trim();
  const fence = /```(?:json)?/i.exec(text);
  if (fence) {
    const start = text.indexOf(fence[0]);
    const end = text.indexOf('```', start + fence[0].length);
    if (start !== -1 && end > start) text = text.slice(start + fence[0].length, end);
  }

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (parsed === null) {
    const arrayStart = text.indexOf('[');
    const arrayEnd = text.lastIndexOf(']');
    if (arrayStart !== -1 && arrayEnd > arrayStart) {
      try {
        parsed = JSON.parse(text.slice(arrayStart, arrayEnd + 1));
      } catch {
        parsed = null;
      }
    }
  }
  if (parsed === null) {
    const objectStart = text.indexOf('{');
    const objectEnd = text.lastIndexOf('}');
    if (objectStart !== -1 && objectEnd > objectStart) {
      try {
        parsed = JSON.parse(text.slice(objectStart, objectEnd + 1));
      } catch {
        parsed = null;
      }
    }
  }
  if (parsed === null) {
    throw new AIError('AI 返回内容格式不正确', 502, 'ai_invalid_json');
  }

  let rawItems;
  if (Array.isArray(parsed)) rawItems = parsed;
  else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) rawItems = parsed.items;
  else if (parsed && typeof parsed === 'object') rawItems = [parsed];
  else rawItems = [];

  const items = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue;
    const departTime = normalizePlanTime(pickPlanField(raw, 'departTime'));
    const returnTime = normalizePlanTime(pickPlanField(raw, 'returnTime'));
    const destination = pickPlanField(raw, 'destination');
    // Some models put several stops into one array field.
    const destinations = Array.isArray(destination) ? destination : [destination];
    for (const one of destinations) {
      const name = String(one ?? '').trim();
      if (!name) continue;
      items.push({ destination: name.slice(0, 80), departTime, returnTime });
    }
  }
  if (items.length === 0) throw new AIError('AI 没有返回可用的旅程计划', 502, 'ai_empty');
  return { items };
}

/**
 * Normalize the structured trip plan sent by the client:
 * { items: [{ destination, departTime, returnTime }], departTime, returnTime }.
 * Returns null when there is nothing usable.
 */
function normalizeJourneyPlan(value) {
  if (!value || typeof value !== 'object') return null;
  const rawItems = Array.isArray(value.items) ? value.items : Array.isArray(value) ? value : [];
  const items = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue;
    const destination = String(raw.destination ?? '').trim();
    if (!destination) continue;
    items.push({
      destination: destination.slice(0, 80),
      departTime: String(raw.departTime ?? '').trim().slice(0, 16),
      returnTime: String(raw.returnTime ?? '').trim().slice(0, 16),
    });
  }
  if (items.length === 0) return null;
  const departs = items.map((item) => item.departTime).filter(Boolean).sort();
  const returns = items.map((item) => item.returnTime).filter(Boolean).sort();
  return {
    items,
    departTime: departs[0] ?? '',
    returnTime: returns.at(-1) ?? '',
  };
}

function localeForUser(body, req) {
  return (
    normalizeLocale(body?.locale) ||
    normalizeLocale(req?.headers?.['accept-language']) ||
    'zh'
  );
}

function validatePassword(value) {
  const password = typeof value === 'string' ? value : '';
  if (password.length < 8) throw new HttpError(400, '密码至少需要 8 个字符', 'validation_error');
  if (password.length > 128) throw new HttpError(400, '密码不能超过 128 个字符', 'validation_error');
  return password;
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email || null,
    emailVerified: Boolean(row.email_verified),
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

export function createApp(config, options = {}) {
  const db = openDatabase(config.dbPath);
  const uploadRoot = path.join(config.dataDir, 'uploads');
  if (fs.existsSync(uploadRoot)) {
    const activeUserIds = new Set(db.raw.prepare('SELECT id FROM users').all().map((row) => String(row.id)));
    for (const entry of fs.readdirSync(uploadRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && /^\d+$/.test(entry.name) && !activeUserIds.has(entry.name)) {
        fs.rmSync(path.join(uploadRoot, entry.name), { recursive: true, force: true });
      }
    }
  }
  const mailer = options.mailer || createMailer(config);
  const startedAt = new Date();
  const lanUrls = getLanUrls(config.port);
  const state = {
    startedAt,
    lanUrls,
    requestLog: [],
    metrics: { total: 0, byStatus: {}, aiCalls: 0 },
  };
  const loginAttempts = new Map();
  const emailAttempts = new Map();

  const routes = [];

  function route(method, pattern, handler, options = {}) {
    const methodUpper = method.toUpperCase();
    const routePath = pattern.source.replaceAll('\\/', '/').replace(/^\^/, '').replace(/\$$/, '');
    routes.push({
      method: methodUpper,
      pattern,
      handler,
      auth: options.auth === true,
      admin: options.admin === true,
    });
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
    // Sliding session: an active device stays signed in until it has been
    // unused for the whole session window, or the user logs out manually.
    const renewedUntil = new Date(
      Date.now() + config.sessionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    db.touchSeen(row.user_id, now);
    db.touchSession(tokenHash, now, renewedUntil);
    return {
      tokenHash,
      user: {
        id: row.user_id,
        email: row.email,
        email_verified: row.email_verified,
        created_at: row.user_created_at,
      },
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

  function checkEmailRate(ip) {
    const now = Date.now();
    const entry = emailAttempts.get(ip);
    if (!entry || entry.resetAt <= now) {
      emailAttempts.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 });
      return;
    }
    if (entry.count >= config.emailRateLimit) {
      throw new HttpError(429, '操作过于频繁，请十分钟后再试', 'rate_limited');
    }
    entry.count += 1;
  }

  function publicBaseUrl() {
    if (config.publicUrl) return config.publicUrl;
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : config.port;
    const lan = getLanUrls(port).find((entry) => entry.name !== 'localhost');
    return lan?.url || `http://127.0.0.1:${port}`;
  }

  async function sendVerificationEmail(user, context = {}) {
    const token = newSessionToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.verificationHours * 60 * 60 * 1000);
    db.createEmailVerification({
      tokenHash: hashToken(token),
      userId: user.id,
      now: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    const link = `${publicBaseUrl()}/api/auth/verify?token=${encodeURIComponent(token)}`;
    const mail = verificationEmail({
      link,
      email: user.email,
      hours: config.verificationHours,
      locale: localeForUser(context.body, context.req),
    });
    await mailer.send({ to: user.email, ...mail });
    return link;
  }

  async function sendEmailChangeVerification(user, email, context = {}) {
    const token = newSessionToken();
    const now = new Date();
    const hours = 24;
    const expiresAt = new Date(now.getTime() + hours * 60 * 60 * 1000);
    db.createEmailVerification({ tokenHash: hashToken(token), userId: user.id, now: now.toISOString(), expiresAt: expiresAt.toISOString(), targetEmail: email });
    const link = `${publicBaseUrl()}/api/auth/verify?token=${encodeURIComponent(token)}`;
    const mail = emailChangeVerificationEmail({ link, email, hours, locale: localeForUser(context.body, context.req) });
    try {
      await mailer.send({ to: email, ...mail });
    } catch (error) {
      db.deletePendingEmailChange(user.id);
      throw error;
    }
    return { pendingEmail: email, pendingEmailExpiresAt: expiresAt.toISOString() };
  }

  async function sendResetEmail(user, context = {}) {
    const token = newSessionToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.resetMinutes * 60 * 1000);
    db.deleteResetsForUser(user.id);
    db.createPasswordReset({
      tokenHash: hashToken(token),
      userId: user.id,
      now: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    const link = `${publicBaseUrl()}/app/#/reset-password?token=${encodeURIComponent(token)}`;
    const mail = resetEmail({
      link,
      email: user.email,
      hours: Math.ceil(config.resetMinutes / 60),
      locale: localeForUser(context.body, context.req),
    });
    try {
      await mailer.send({ to: user.email, ...mail });
    } catch (error) {
      db.deleteResetsForUser(user.id);
      throw error;
    }
    return { pendingResetExpiresAt: expiresAt.toISOString() };
  }

  function buildStatus() {
    const now = Date.now();
    const memory = process.memoryUsage();
    const users = db.listUsers().map((user) => ({
      id: user.id,
      email: user.email,
      displayName: user.email.split('@')[0],
      emailVerified: Boolean(user.email_verified),
      createdAt: user.created_at,
      lastLoginAt: user.last_login_at,
      lastSeenAt: user.last_seen_at,
      online: Boolean(user.last_seen_at) && now - Date.parse(user.last_seen_at) < ONLINE_WINDOW_MS,
    }));
    return {
      server: {
        name: 'Red Panda',
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
      service: 'red-panda',
      name: '小熊猫',
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
    const ip = req.socket.remoteAddress ?? 'unknown';
    checkEmailRate(ip);
    const email = normalizeEmail(body.email);
    const password = validatePassword(body.password);
    const now = new Date().toISOString();

    const existing = db.findUserByEmail(email);
    if (existing) {
      if (existing.email_verified) {
        throw new HttpError(409, '这个邮箱已经注册过了', 'email_taken');
      }
      // Unverified accounts may re-register: update the password and resend.
      db.setPassword(existing.id, hashPassword(password));
      try {
        await sendVerificationEmail(db.findUserById(existing.id), { body, req });
      } catch (error) {
        console.error('[red-panda] 验证邮件发送失败:', error);
        throw new HttpError(502, '账户已存在，但验证邮件发送失败，请稍后重试', 'mail_failed');
      }
      return {
        status: 200,
        body: {
          status: 'pending_verification',
          email,
          message: '验证邮件已重新发送，请查收',
        },
      };
    }

    let userId;
    try {
      userId = db.createUser({ email, passwordHash: hashPassword(password), now });
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) {
        throw new HttpError(409, '这个邮箱已经注册过了', 'email_taken');
      }
      throw error;
    }

    const user = db.findUserById(userId);
    try {
      await sendVerificationEmail(user, { body, req });
    } catch (error) {
      console.error('[red-panda] 验证邮件发送失败:', error);
      throw new HttpError(502, '账户已创建，但验证邮件发送失败，请稍后重试', 'mail_failed');
    }

    return {
      status: 201,
      body: {
        status: 'pending_verification',
        email,
        message: '验证邮件已发送，请查收并点击链接激活账户',
      },
    };
  });

  route('POST', /^\/api\/auth\/login$/, async ({ body, req }) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    checkLoginRate(ip);
    const identifier = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!identifier) throw new HttpError(400, '请输入邮箱', 'validation_error');
    if (!password) throw new HttpError(400, '请输入密码', 'validation_error');

    // Email is the only login identifier; username-only legacy accounts are
    // removed by database migration and are no longer accepted.
    let user = db.findUserByEmail(identifier);
    if (!user || !verifyPassword(password, user.password_hash)) {
      noteLoginFailure(ip);
      throw new HttpError(401, '邮箱或密码不正确', 'invalid_credentials');
    }
    if (!user.email_verified) {
      throw new HttpError(403, '邮箱尚未验证，请查收验证邮件并点击激活链接', 'email_not_verified');
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

  route('GET', /^\/api\/auth\/verify$/, ({ req, res }) => {
    let token = '';
    try {
      token = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token') ?? '';
    } catch {
      token = '';
    }
    let verified = false;
    let emailChanged = false;
    if (token) {
      const row = db.consumeEmailVerification(hashToken(token), new Date().toISOString());
      if (row?.target_email) {
        const existing = db.findUserByEmail(row.target_email);
        if (!existing || existing.id === row.user_id) {
          db.setEmail(row.user_id, row.target_email);
          emailChanged = true;
          verified = true;
        }
      } else if (row) {
        db.markEmailVerified(row.user_id);
        verified = true;
      }
    }
    const location = emailChanged ? '/app/#/settings/account-security?emailChanged=1' : (verified ? '/app/#/login?verified=1' : '/app/#/login?verify=invalid');
    res.writeHead(302, { Location: location });
    res.end();
    return { status: 302 };
  });

  route('POST', /^\/api\/auth\/resend-verification$/, async ({ body, req }) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    checkEmailRate(ip);
    const email = normalizeEmail(body.email);
    const user = db.findUserByEmail(email);
    if (user && !user.email_verified) {
      try {
        await sendVerificationEmail(user, { body, req });
      } catch (error) {
        console.error('[red-panda] 验证邮件发送失败:', error);
      }
    }
    return {
      status: 200,
      body: {
        status: 'ok',
        message: '如果该邮箱存在且尚未验证，验证邮件已发送',
      },
    };
  });

  route('POST', /^\/api\/auth\/forgot-password$/, async ({ body, req }) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    checkEmailRate(ip);
    const email = normalizeEmail(body.email);
    const user = db.findUserByEmail(email);
    if (user) {
      try {
        if (user.email_verified) await sendResetEmail(user, { body, req });
        else await sendVerificationEmail(user, { body, req });
      } catch (error) {
        console.error('[red-panda] 邮件发送失败:', error);
      }
    }
    return {
      status: 200,
      body: {
        status: 'ok',
        message: '如果该邮箱已注册，重置邮件已发送',
      },
    };
  });

  route('POST', /^\/api\/auth\/reset-password$/, async ({ body, req }) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    checkEmailRate(ip);
    const token = requiredString(body.token, '重置令牌', { min: 10, max: 200 });
    const password = validatePassword(body.password);
    const row = db.consumePasswordReset(hashToken(token), new Date().toISOString());
    if (!row) {
      throw new HttpError(400, '重置链接无效或已过期，请重新申请', 'invalid_reset_token');
    }
    db.setPassword(row.user_id, hashPassword(password));
    db.deleteSessionsForUser(row.user_id);
    return { status: 204 };
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
    ({ auth }) => {
      const pending = db.pendingEmailChange(auth.user.id, new Date().toISOString());
      const pendingReset = db.pendingPasswordReset(auth.user.id, new Date().toISOString());
      return { status: 200, body: { user: { ...publicUser(auth.user), pendingEmail: pending?.target_email || null, pendingEmailExpiresAt: pending?.expires_at || null, pendingResetExpiresAt: pendingReset?.expires_at || null } } };
    },
    { auth: true },
  );

  route('PUT', /^\/api\/me\/email$/, async ({ auth, body, req }) => {
    const email = normalizeEmail(body.email);
    if (email === String(auth.user.email || '').toLowerCase()) {
      db.deletePendingEmailChange(auth.user.id);
      return { status: 200, body: { pendingEmail: null, pendingEmailExpiresAt: null } };
    }
    const existing = db.findUserByEmail(email);
    if (existing && existing.id !== auth.user.id) throw new HttpError(409, '这个邮箱已经注册过了', 'email_taken');
    checkEmailRate(req.socket.remoteAddress ?? 'unknown');
    const pending = await sendEmailChangeVerification(auth.user, email, { body, req });
    return { status: 200, body: pending };
  }, { auth: true });

  route('POST', /^\/api\/me\/password-reset$/, async ({ auth, body, req }) => {
    checkEmailRate(req.socket.remoteAddress ?? 'unknown');
    const pending = await sendResetEmail(auth.user, { body, req });
    return { status: 200, body: pending };
  }, { auth: true });

  route(
    'PUT',
    /^\/api\/me\/password$/,
    ({ auth, body }) => {
      const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
      const newPassword = validatePassword(body.newPassword);
      const row = db.findUserById(auth.user.id);
      if (!row || !verifyPassword(currentPassword, row.password_hash)) {
        throw new HttpError(401, '当前密码不正确', 'invalid_password');
      }
      db.setPassword(auth.user.id, hashPassword(newPassword));
      // Keep this session, sign out every other device.
      db.deleteOtherSessions(auth.user.id, auth.tokenHash);
      return { status: 204 };
    },
    { auth: true },
  );

  function requireTencentKey() {
    const key = config.tencentMap?.key || '';
    if (!key) throw new HttpError(503, '未配置腾讯地图 Key（TENCENT_MAP_KEY）', 'tencent_map_not_configured');
    return key;
  }
  async function tencentGet(path, params) {
    const key = requireTencentKey();
    const url = new URL(`https://apis.map.qq.com${path}`);
    url.searchParams.set('key', key);
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    let response;
    try { response = await fetch(url, { signal: AbortSignal.timeout(20_000) }); }
    catch { throw new HttpError(502, '腾讯地图服务暂时不可用，请稍后重试。', 'place_search_unavailable'); }
    let data;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok || !data || (data.status !== 0 && data.status !== undefined)) {
      const msg = data?.message || '地点服务暂时不可用，请稍后重试。';
      throw new HttpError(502, msg, 'place_search_unavailable');
    }
    return data;
  }
  const normalizePoi = (poi = {}) => {
    const loc = poi.location || {};
    const ad = poi.ad_info || {};
    return {
      id: poi.id || '',
      name: poi.title || poi.name || '',
      address: poi.address || [ad.province, ad.city, ad.district].filter(Boolean).join('') || '',
      lat: Number(loc.lat),
      lng: Number(loc.lng),
      distance: poi._distance ?? poi.distance ?? null,
      province: ad.province || '',
      city: ad.city || '',
      district: ad.district || '',
      category: poi.category || '',
    };
  };

  route('POST', /^\/api\/me\/usual-origin\/nearby$/, async ({ body }) => {
    const lat = Number(body.lat);
    const lng = Number(body.lng ?? body.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new HttpError(400, '地图坐标无效', 'validation_error');
    }
    const keyword = typeof body.keyword === 'string' ? body.keyword.trim().slice(0, 80) : '';
    const pageSize = Math.min(20, Math.max(1, Number(body.page_size) || 20));
    const pageIndex = Math.max(1, Number(body.page_index) || 1);
    const params = {
      boundary: `nearby(${lat},${lng},1000,1)`,
      page_size: pageSize,
      page_index: pageIndex,
      orderby: '_distance',
      get_subpois: 0,
    };
    if (keyword) params.keyword = keyword;
    const data = await tencentGet('/ws/place/v1/search', params);
    const pois = Array.isArray(data.data) ? data.data.map(normalizePoi) : [];
    return { status: 200, body: { pois, count: data.count || pois.length } };
  }, { auth: true });

  route('POST', /^\/api\/me\/usual-origin\/search$/, async ({ body }) => {
    const keyword = typeof body.keyword === 'string' ? body.keyword.trim().slice(0, 80) : (typeof body.query === 'string' ? body.query.trim().slice(0, 80) : '');
    if (keyword.length < 1) throw new HttpError(400, '请输入搜索关键词', 'validation_error');
    const lat = Number(body.lat);
    const lng = Number(body.lng ?? body.lon);
    const params = { keyword, page_size: Math.min(20, Math.max(1, Number(body.page_size) || 20)), page_index: Math.max(1, Number(body.page_index) || 1) };
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      params.boundary = `nearby(${lat},${lng},50000,1)`;
      params.orderby = '_distance';
    } else {
      params.boundary = `region(全国,0)`;
    }
    const data = await tencentGet('/ws/place/v1/search', params);
    const pois = Array.isArray(data.data) ? data.data.map(normalizePoi) : [];
    return { status: 200, body: { pois, count: data.count || pois.length } };
  }, { auth: true });

  route('POST', /^\/api\/me\/usual-origin\/reverse$/, async ({ body }) => {
    const lat = Number(body.lat);
    const lng = Number(body.lng ?? body.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new HttpError(400, '地图坐标无效', 'validation_error');
    }
    const data = await tencentGet('/ws/geocoder/v1/', { location: `${lat},${lng}`, get_poi: 1, poi_options: 'radius=1000;page_size=20;page_index=1;policy=1' });
    const result = data.result || {};
    const formatted = result.formatted_addresses?.recommend || result.address || '';
    const comp = result.address_component || {};
    const pois = Array.isArray(result.pois) ? result.pois.map((p) => {
      const loc = p.location || p.latlng || {};
      return normalizePoi({
        id: p.id, title: p.title, address: p.address || formatted,
        location: { lat: loc.lat ?? lat, lng: loc.lng ?? lng },
        ad_info: p.ad_info || { province: comp.province, city: comp.city, district: comp.district },
        _distance: p._distance ?? p.distance,
        category: p.category,
      });
    }) : [];
    return {
      status: 200,
      body: {
        address: formatted,
        component: { province: comp.province || '', city: comp.city || '', district: comp.district || '', street: comp.street || '', street_number: comp.street_number || '' },
        pois,
      },
    };
  }, { auth: true });

  route('GET', /^\/api\/map\/config$/, async () => {
    return { status: 200, body: { tencentKey: config.tencentMap?.key || '' } };
  }, { auth: true });

  route('POST', /^\/api\/me\/usual-origin\/parse$/, async ({ body }) => {
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, 1000) : '';
    if (!text) throw new HttpError(400, '请输入地点描述', 'validation_error');
    const result = await chat(config, [
      { role: 'system', content: '将用户给出的常用地址描述解析为 JSON 对象。只返回JSON，键名必须为name,country,province,city,district,township,street,streetNumber；无法确定的值为空字符串。name 用适合显示的简短地点名。' },
      { role: 'user', content: text },
    ], { maxTokens: 500, temperature: 0 });
    let origin;
    try { origin = result.mock ? { name: text } : JSON.parse(result.content.replace(/^```(?:json)?\s*|\s*```$/g, '')); }
    catch { throw new AIError('AI 返回的地点格式无法识别，请补充描述后重试。', 502, 'ai_invalid_json'); }
    const fields = ['name', 'country', 'province', 'city', 'district', 'township', 'street', 'streetNumber'];
    return { status: 200, body: { origin: Object.fromEntries(fields.map((key) => [key, String(origin[key] || '').slice(0, 160)])) } };
  }, { auth: true });

  route(
    'POST',
    /^\/api\/ai\/memory-recap$/,
    async ({ auth, body, req }) => {
      const supplied = (body.context && typeof body.context === 'object') ? body.context : {};
      const context = {
        journeyName: optionalString(supplied.journeyName, '旅程名称', 80),
        destination: optionalString(supplied.destination, '目的地', 500),
        departTime: optionalString(supplied.departTime, '出发时间', 40),
        returnTime: optionalString(supplied.returnTime, '返回时间', 40),
        photos: Math.max(0, Math.min(10000, Number(supplied.photos) || 0)),
        videos: Math.max(0, Math.min(10000, Number(supplied.videos) || 0)),
        notes: Array.isArray(supplied.notes) ? supplied.notes.slice(0, 100).map((note) => optionalString(note, '回忆文字', 2000)).filter(Boolean) : [],
      };
      const locale = localeForUser(body, req);
      if (config.ai.mock) {
        state.metrics.aiCalls += 1;
        return {
          status: 200,
          body: { recap: mockRecap(context, locale), model: 'mock', mock: true },
        };
      }
      const result = await chat(
        config,
        [
          {
            role: 'system',
            content:
              '你是「小熊猫」旅程应用里的回忆作者。' +
              '根据用户给某段行程添加的照片、视频和文字，写一段温柔、有画面感的旅行回忆。' +
              '不要罗列清单，不要标题，不要解释，控制在 200 字以内，只输出回忆正文。',
          },
          {
            role: 'user',
            content:
              `行程：${context.journeyName}\n` +
              (context.destination ? `目的地：${context.destination}\n` : '') +
              (context.departTime ? `出发：${context.departTime}\n` : '') +
              (context.returnTime ? `返回：${context.returnTime}\n` : '') +
              `照片 ${context.photos} 张，视频 ${context.videos} 段。\n` +
              (context.notes.length
                ? `用户写下的片段：\n${context.notes.map((note) => `- ${note}`).join('\n')}\n`
                : '用户还没有写下文字。\n') +
              '请写成一段旅行回忆。',
          },
        ],
        { maxTokens: 600, temperature: 0.9 },
      );
      state.metrics.aiCalls += 1;
      return {
        status: 200,
        body: { recap: result.content, model: result.model, mock: result.mock },
      };
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
              '你是「小熊猫」旅程应用的向导，擅长用简洁、富有画面感的中文为旅程写简介。' +
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
    /^\/api\/ai\/journey-plan$/,
    async ({ body }) => {
      const prompt = requiredString(body.prompt, '旅行想法', { min: 1, max: 500 });
      if (config.ai.mock) {
        state.metrics.aiCalls += 1;
        const plan = mockPlan(prompt);
        return { status: 200, body: { items: plan.items, model: 'mock', mock: true } };
      }
      const result = await chat(
        config,
        [
          {
            role: 'system',
            content:
              '你是「小熊猫」旅程应用的向导，擅长把旅行想法整理成可出发的旅程计划。' +
              '从用户描述里分析提取目的地（地点）和出发/返回时间。' +
              '只输出一个 JSON 对象，不要 Markdown 代码块，不要解释，不要多余文字。' +
              '格式必须严格为：{"items":[{"destination":"目的地名称","departTime":"出发时间","returnTime":"返回时间"}]}；' +
              '每个目的地占一项；时间为 24 小时制 YYYY-MM-DDTHH:mm，无法确定的写空字符串。',
          },
          {
            role: 'user',
            content:
              `今天是 ${todayContext()}。\n用户想去的地方：${prompt}\n` +
              '请把「下个月15号」「玩三天」这类相对说法换算成具体日期（以今天为基准），' +
              '并按上述格式输出旅程计划 JSON。',
          },
        ],
        { maxTokens: 900, temperature: 0.3 },
      );
      state.metrics.aiCalls += 1;
      const plan = parseJourneyPlan(result.content);
      return {
        status: 200,
        body: { items: plan.items, model: result.model, mock: result.mock },
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

        const query = Object.fromEntries(parsed.searchParams);
        const result = await matched.handler({ req, res, body, params, auth, query });
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
        filePath = path.join(config.webDir, 'icon-192.png');
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
        console.error('[red-panda] unhandled error:', error);
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
          `[red-panda] ${req.method} ${pathname} → ${status} (${duration}ms)`,
        );
      } else if (status >= 500) {
        console.error(`[red-panda] ${req.method} ${pathname} → ${status} (${duration}ms)`);
      }
    }
  });

  const cleanup = setInterval(() => {
    try {
      db.deleteExpiredSessions();
      db.deleteExpiredTokens();
    } catch (error) {
      console.error('[red-panda] session cleanup failed:', error);
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

export function startServer(config, options = {}) {
  const app = createApp(config, options);
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
