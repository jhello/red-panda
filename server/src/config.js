import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_DIR = path.resolve(HERE, '..');
export const PROJECT_ROOT = path.resolve(SERVER_DIR, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'package.json'), 'utf8'));

function value(env, key, fallback) {
  const raw = env[key];
  return raw === undefined || raw === '' ? fallback : raw;
}

function readOrCreateAdminToken(dataDir, envToken) {
  if (envToken) return { token: envToken, source: 'env' };
  const file = path.join(dataDir, 'admin-token');
  if (fs.existsSync(file)) {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved) return { token: saved, source: 'file' };
  }
  const token = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return { token, source: 'generated' };
}

/**
 * Load runtime configuration from environment variables.
 * Everything is optional; sensible local-first defaults are used.
 */
export function loadConfig(env = process.env) {
  const dataDir = path.resolve(value(env, 'ODYSSEY_DATA_DIR', path.join(PROJECT_ROOT, 'data')));
  fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = path.resolve(value(env, 'ODYSSEY_DB', path.join(dataDir, 'odyssey.db')));
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const admin = readOrCreateAdminToken(dataDir, value(env, 'ODYSSEY_ADMIN_TOKEN', ''));
  const port = Number(value(env, 'PORT', '8787'));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT 不是合法端口: ${port}`);
  }

  const sessionDays = Number(value(env, 'ODYSSEY_SESSION_DAYS', '30'));

  return {
    version: pkg.version,
    host: value(env, 'HOST', '0.0.0.0'),
    port,
    dataDir,
    dbPath,
    adminToken: admin.token,
    adminTokenSource: admin.source,
    sessionDays: Number.isFinite(sessionDays) && sessionDays > 0 ? sessionDays : 30,
    webDir: path.resolve(value(env, 'ODYSSEY_WEB_DIR', path.join(PROJECT_ROOT, 'web'))),
    dashboardDir: path.join(SERVER_DIR, 'public', 'dashboard'),
    ai: {
      apiKey: value(env, 'OPENAI_API_KEY', ''),
      baseUrl: value(env, 'OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
      model: value(env, 'OPENAI_MODEL', 'gpt-4o-mini'),
      mock: value(env, 'ODYSSEY_AI_MOCK', '0') === '1',
    },
  };
}

export function getLanUrls(port) {
  const urls = [{ name: 'localhost', url: `http://127.0.0.1:${port}` }];
  const interfaces = os.networkInterfaces();
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        urls.push({ name, url: `http://${address.address}:${port}` });
      }
    }
  }
  return urls;
}
