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
import { resetEmail, verificationEmail } from './emails.js';
import {
  MAX_MEDIA_BYTES,
  mediaFileName,
  mediaFilePath,
  mediaKindFor,
  mimeForFile,
  removeMediaFile,
  saveMediaFile,
} from './media.js';

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

/** 读取请求体的原始字节（上传照片 / 视频时用）。 */
function readRaw(req, maxBytes = MAX_MEDIA_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, '文件太大了', 'payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
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

/** Journey rows carry the plan as JSON; expose it as an object. */
function publicJourney(row) {
  if (!row) return row;
  let plan = null;
  if (row.plan) {
    try {
      plan = JSON.parse(row.plan);
    } catch {
      plan = null;
    }
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    plan,
    depart_time: row.depart_time || '',
    return_time: row.return_time || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** 行程里的目的地（可能有好几个）。 */
function destinationsOf(journey) {
  const items = journey?.plan?.items;
  if (!Array.isArray(items) || !items.length) return '';
  return items
    .map((item) => String(item?.destination ?? '').trim())
    .filter(Boolean)
    .join(' · ');
}

/** 回忆里的一张照片 / 视频。 */
function publicMedia(row) {
  return {
    id: row.id,
    memoryId: row.memory_id,
    kind: row.kind,
    mime: row.mime,
    size: row.size,
    url: `/api/media/${row.access_key}`,
    createdAt: row.created_at,
  };
}

/** 一条回忆：文字 + 照片 / 视频。 */
function publicMemory(row) {
  return {
    id: row.id,
    journeyId: row.journey_id,
    note: row.note,
    createdAt: row.created_at,
    media: (row.media ?? []).map(publicMedia),
  };
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
  if (/^zh\b|^zh[-_]/.test(text)) return 'zh';
  if (/^en\b|^en[-_]/.test(text)) return 'en';
  if (/^de\b|^de[-_]/.test(text)) return 'de';
  return '';
}

/** Language for a user's emails: stored preference → request → Accept-Language. */
function localeForUser(user, body, req) {
  return (
    normalizeLocale(user?.locale) ||
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
    displayName: row.display_name || row.username,
    username: row.username,
    emailVerified: Boolean(row.email_verified),
    locale: row.locale || 'zh',
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

/** 发送照片 / 视频，支持 Range 请求（浏览器播放视频需要拖动进度）。 */
function serveMedia(req, res, filePath, mime) {
  const stat = fs.statSync(filePath);
  const headers = {
    'Content-Type': mime || mimeForFile(filePath),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
  };
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '').trim());
  if (match) {
    let start = match[1] === '' ? null : Number(match[1]);
    let end = match[2] === '' ? null : Number(match[2]);
    if (start === null && end !== null) {
      start = Math.max(0, stat.size - end);
      end = stat.size - 1;
    } else if (start === null) {
      start = 0;
    }
    if (end === null || end >= stat.size) end = stat.size - 1;
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1,
    });
    if (req.method === 'HEAD') {
      res.end();
    } else {
      fs.createReadStream(filePath, { start, end }).pipe(res);
    }
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') {
    res.end();
  } else {
    fs.createReadStream(filePath).pipe(res);
  }
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
    routes.push({
      method,
      pattern,
      handler,
      auth: options.auth === true,
      admin: options.admin === true,
      raw: options.raw === true,
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
        username: row.username,
        email: row.email,
        display_name: row.display_name,
        email_verified: row.email_verified,
        locale: row.locale,
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
    if (entry.count >= 20) {
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
      locale: localeForUser(user, context.body, context.req),
    });
    await mailer.send({ to: user.email, ...mail });
    return link;
  }

  async function sendResetEmail(user, context = {}) {
    const token = newSessionToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.resetMinutes * 60 * 1000);
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
      minutes: config.resetMinutes,
      locale: localeForUser(user, context.body, context.req),
    });
    await mailer.send({ to: user.email, ...mail });
    return link;
  }

  function buildStatus() {
    const now = Date.now();
    const memory = process.memoryUsage();
    const users = db.listUsers().map((user) => ({
      id: user.id,
      username: user.username,
      email: user.email || null,
      displayName: user.display_name || user.username,
      emailVerified: Boolean(user.email_verified),
      createdAt: user.created_at,
      lastLoginAt: user.last_login_at,
      lastSeenAt: user.last_seen_at,
      journeyCount: user.journey_count,
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
    const locale =
      normalizeLocale(body.locale) || normalizeLocale(req.headers['accept-language']) || 'zh';
    const now = new Date().toISOString();

    const existing = db.findUserByEmail(email);
    if (existing) {
      if (existing.email_verified) {
        throw new HttpError(409, '这个邮箱已经注册过了', 'email_taken');
      }
      // Unverified accounts may re-register: update the password and resend.
      db.setPassword(existing.id, hashPassword(password));
      db.setLocale(existing.id, locale);
      try {
        await sendVerificationEmail(db.findUserById(existing.id));
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
      userId = db.createUser({ email, passwordHash: hashPassword(password), locale, now });
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) {
        throw new HttpError(409, '这个邮箱已经注册过了', 'email_taken');
      }
      throw error;
    }

    const user = db.findUserById(userId);
    try {
      await sendVerificationEmail(user);
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
    const identifier =
      typeof body.email === 'string' && body.email.trim()
        ? body.email.trim().toLowerCase()
        : typeof body.username === 'string'
          ? body.username.trim()
          : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!identifier) throw new HttpError(400, '请输入邮箱', 'validation_error');
    if (!password) throw new HttpError(400, '请输入密码', 'validation_error');

    // New accounts use email; legacy accounts may still log in with a username.
    let user = db.findUserByEmail(identifier) || db.findUserByUsername(identifier);
    if (!user || !verifyPassword(password, user.password_hash)) {
      noteLoginFailure(ip);
      throw new HttpError(401, '邮箱或密码不正确', 'invalid_credentials');
    }
    if (!user.email_verified) {
      throw new HttpError(403, '邮箱尚未验证，请查收验证邮件并点击激活链接', 'email_not_verified');
    }
    loginAttempts.delete(ip);
    // Keep the stored email language in sync with the app language so later
    // emails (password reset, etc.) arrive in the language the user picked.
    const locale = normalizeLocale(body.locale);
    if (locale && locale !== normalizeLocale(user.locale)) {
      db.setLocale(user.id, locale);
      user = { ...user, locale };
    }
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
    if (token) {
      const row = db.consumeEmailVerification(hashToken(token), new Date().toISOString());
      if (row) {
        db.markEmailVerified(row.user_id);
        verified = true;
      }
    }
    const location = verified ? '/app/#/login?verified=1' : '/app/#/login?verify=invalid';
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
    ({ auth }) => ({
      status: 200,
      body: { user: publicUser(auth.user) },
    }),
    { auth: true },
  );

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

  route(
    'PUT',
    /^\/api\/me\/locale$/,
    ({ auth, body }) => {
      const locale = normalizeLocale(body.locale);
      if (!locale) {
        throw new HttpError(400, '语言仅支持 zh / en / de', 'validation_error');
      }
      db.setLocale(auth.user.id, locale);
      return { status: 200, body: { locale } };
    },
    { auth: true },
  );

  route(
    'GET',
    /^\/api\/journeys$/,
    ({ auth }) => ({
      status: 200,
      body: { journeys: db.listJourneys(auth.user.id).map(publicJourney) },
    }),
    { auth: true },
  );

  route(
    'POST',
    /^\/api\/journeys$/,
    ({ auth, body }) => {
      const name = requiredString(body.name, '旅程名称', { min: 1, max: 80 });
      const description = optionalString(body.description, '旅程描述', 5000);
      const plan = normalizeJourneyPlan(body.plan);
      const journey = db.createJourney({
        userId: auth.user.id,
        name,
        description,
        plan: plan ? JSON.stringify(plan) : '',
        departTime: plan?.departTime ?? '',
        returnTime: plan?.returnTime ?? '',
        now: new Date().toISOString(),
      });
      return { status: 201, body: { journey: publicJourney(journey) } };
    },
    { auth: true },
  );

  route(
    'GET',
    /^\/api\/journeys\/(\d+)$/,
    ({ auth, params }) => {
      const journey = db.getJourney(auth.user.id, Number(params[0]));
      if (!journey) throw new HttpError(404, '旅程不存在', 'not_found');
      return { status: 200, body: { journey: publicJourney(journey) } };
    },
    { auth: true },
  );

  route(
    'PUT',
    /^\/api\/journeys\/(\d+)$/,
    ({ auth, params, body }) => {
      const name = requiredString(body.name, '旅程名称', { min: 1, max: 80 });
      const description = optionalString(body.description, '旅程描述', 5000);
      const plan = normalizeJourneyPlan(body.plan);
      const journey = db.updateJourney({
        userId: auth.user.id,
        id: Number(params[0]),
        name,
        description,
        plan: plan ? JSON.stringify(plan) : '',
        departTime: plan?.departTime ?? '',
        returnTime: plan?.returnTime ?? '',
        now: new Date().toISOString(),
      });
      if (!journey) throw new HttpError(404, '旅程不存在', 'not_found');
      return { status: 200, body: { journey: publicJourney(journey) } };
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

  // ---- 回忆（照片 / 视频 / 文字）-------------------------------------------

  route(
    'GET',
    /^\/api\/memories$/,
    ({ auth, query }) => {
      const journeyId = query.journeyId ? Number(query.journeyId) : null;
      if (journeyId !== null && !Number.isInteger(journeyId)) {
        throw new HttpError(400, '行程编号不正确', 'validation_error');
      }
      return {
        status: 200,
        body: {
          memories: db.listMemories(auth.user.id, journeyId).map(publicMemory),
          counts: db.countMemoriesByJourney(auth.user.id),
        },
      };
    },
    { auth: true },
  );

  route(
    'POST',
    /^\/api\/memories$/,
    ({ auth, body }) => {
      const raw = body.journeyId;
      const journeyId =
        raw === undefined || raw === null || raw === '' ? null : Number(raw);
      if (journeyId !== null && !Number.isInteger(journeyId)) {
        throw new HttpError(400, '行程编号不正确', 'validation_error');
      }
      if (journeyId !== null && !db.getJourney(auth.user.id, journeyId)) {
        throw new HttpError(404, '行程不存在', 'not_found');
      }
      const note = optionalString(body.note, '回忆文字', 2000);
      if (!note && journeyId === null) {
        throw new HttpError(400, '写点什么，或者选一段行程', 'validation_error');
      }
      const memory = db.createMemory({
        userId: auth.user.id,
        journeyId,
        note,
        now: new Date().toISOString(),
      });
      return { status: 201, body: { memory: publicMemory(memory) } };
    },
    { auth: true },
  );

  route(
    'DELETE',
    /^\/api\/memories\/(\d+)$/,
    ({ auth, params }) => {
      const result = db.deleteMemory(auth.user.id, Number(params[0]));
      if (!result) throw new HttpError(404, '回忆不存在', 'not_found');
      for (const item of result.media) {
        removeMediaFile(
          config.dataDir,
          auth.user.id,
          mediaFileName(item.access_key, item.mime),
        );
      }
      return { status: 204 };
    },
    { auth: true },
  );

  // 上传照片 / 视频：请求体就是文件本身，Content-Type 说明类型。
  route(
    'POST',
    /^\/api\/memories\/(\d+)\/media$/,
    ({ auth, params, body, req }) => {
      const memory = db.getMemory(auth.user.id, Number(params[0]));
      if (!memory) throw new HttpError(404, '回忆不存在', 'not_found');
      const buffer = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
      if (!buffer.length) throw new HttpError(400, '文件内容为空', 'validation_error');
      const mime = String(req.headers['content-type'] ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      const kind = mediaKindFor(mime);
      if (!kind) {
        throw new HttpError(415, '只支持照片和视频', 'unsupported_media');
      }
      const saved = saveMediaFile(config.dataDir, auth.user.id, buffer, mime);
      const media = db.createMedia({
        memoryId: memory.id,
        userId: auth.user.id,
        accessKey: saved.key,
        kind,
        mime,
        size: buffer.length,
        now: new Date().toISOString(),
      });
      return { status: 201, body: { media: publicMedia(media) } };
    },
    { auth: true, raw: true },
  );

  // 媒体文件：访问密钥本身就是凭证，方便 <img> / <video> 直接引用。
  route('GET', /^\/api\/media\/([a-f0-9]{32})$/, ({ params, res, req }) => {
    const item = db.getMediaByKey(params[0]);
    if (!item) throw new HttpError(404, '文件不存在', 'not_found');
    const fileName = mediaFileName(item.access_key, item.mime);
    const filePath = mediaFilePath(config.dataDir, item.user_id, fileName);
    if (!filePath || !fs.existsSync(filePath)) {
      throw new HttpError(404, '文件不存在', 'not_found');
    }
    serveMedia(req, res, filePath, item.mime);
    return { status: 200 };
  });

  route(
    'POST',
    /^\/api\/ai\/memory-recap$/,
    async ({ auth, body, req }) => {
      const journeyId = Number(body.journeyId);
      if (!Number.isInteger(journeyId)) {
        throw new HttpError(400, '行程编号不正确', 'validation_error');
      }
      const journey = db.getJourney(auth.user.id, journeyId);
      if (!journey) throw new HttpError(404, '行程不存在', 'not_found');
      const memories = db.listMemories(auth.user.id, journeyId);
      const media = memories.flatMap((item) => item.media ?? []);
      const context = {
        journeyName: journey.name,
        destination: destinationsOf(journey),
        departTime: journey.depart_time || '',
        returnTime: journey.return_time || '',
        photos: media.filter((item) => item.kind === 'image').length,
        videos: media.filter((item) => item.kind === 'video').length,
        notes: memories.map((item) => item.note).filter(Boolean),
      };
      const locale = localeForUser(auth.user, body, req);
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
          body = matched.raw ? await readRaw(req) : await readJson(req);
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
