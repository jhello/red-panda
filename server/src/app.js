import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { URL } from 'node:url';

import { AIError, aiStatus } from './ai.js';
import { hashToken, safeEqual } from './auth.js';
import { getLanUrls } from './config.js';
import { fileSize, openDatabase } from './db.js';
import {
  HttpError,
  getClientIp,
  readJson,
  sendEmpty,
  sendJson,
  setApiHeaders,
} from './http-utils.js';
import { createMailer } from './mailer.js';
import { RateLimiter } from './rate-limit.js';
import { parseJourneyPlan, registerAiRoutes } from './routes/ai.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerMapRoutes } from './routes/maps.js';
import { notFound, resolveStaticPath, serveFile } from './static.js';

const ONLINE_WINDOW_MS = 5 * 60 * 1000;
const RATE_WINDOW_MS = 10 * 60 * 1000;

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

  const loginLimiter = new RateLimiter({ max: 20, windowMs: RATE_WINDOW_MS });
  const emailLimiter = new RateLimiter({ max: config.emailRateLimit ?? 20, windowMs: RATE_WINDOW_MS });
  const aiLimiter = new RateLimiter({ max: config.aiRateLimit ?? 30, windowMs: RATE_WINDOW_MS });
  const mapLimiter = new RateLimiter({ max: config.mapRateLimit ?? 120, windowMs: RATE_WINDOW_MS });

  const routes = [];
  function route(method, pattern, handler, routeOptions = {}) {
    routes.push({
      method: method.toUpperCase(),
      pattern,
      handler,
      auth: routeOptions.auth === true,
      admin: routeOptions.admin === true,
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

  function publicBaseUrl() {
    if (config.publicUrl) return config.publicUrl;
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : config.port;
    const lan = getLanUrls(port).find((entry) => entry.name !== 'localhost');
    return lan?.url || `http://127.0.0.1:${port}`;
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

  // ---- core health & admin routes ------------------------------------------

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

  // ---- modular API routes --------------------------------------------------

  registerAuthRoutes({
    route,
    db,
    config,
    mailer,
    publicBaseUrl,
    loginLimiter,
    emailLimiter,
  });

  registerMapRoutes({
    route,
    config,
    state,
    mapLimiter,
    aiLimiter,
  });

  registerAiRoutes({
    route,
    config,
    state,
    aiLimiter,
  });

  // ---- HTTP request dispatcher --------------------------------------------

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

      if (pathname === '/app') {
        res.writeHead(302, { Location: '/app/' });
        res.end();
        status = 302;
        return;
      }

      let filePath = resolveStaticPath(pathname, config);
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
          ip: getClientIp(req, config),
        });
        if (state.requestLog.length > 200) state.requestLog.shift();
        console.log(`[red-panda] ${req.method} ${pathname} → ${status} (${duration}ms)`);
      } else if (status >= 500) {
        console.error(`[red-panda] ${req.method} ${pathname} → ${status} (${duration}ms)`);
      }
    }
  });

  const cleanup = setInterval(() => {
    try {
      db.deleteExpiredSessions();
      db.deleteExpiredTokens();
      loginLimiter.prune();
      emailLimiter.prune();
      aiLimiter.prune();
      mapLimiter.prune();
    } catch (error) {
      console.error('[red-panda] session cleanup failed:', error);
    }
  }, 60 * 60 * 1000);
  cleanup.unref();

  return {
    server,
    db,
    state,
    limiters: { loginLimiter, emailLimiter, aiLimiter, mapLimiter },
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

export { HttpError, parseJourneyPlan };
