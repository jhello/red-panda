const MAX_BODY_BYTES = 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUPPORTED_LOCALES = new Set(['zh', 'en', 'de']);

export class HttpError extends Error {
  constructor(status, message, code = 'error') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export function sendJson(res, status, payload) {
  if (res.headersSent) return;
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function sendEmpty(res, status) {
  if (res.headersSent) return;
  res.writeHead(status);
  res.end();
}

export function setApiHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Admin-Token');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

export function readJson(req) {
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

export function requiredString(value, label, { min = 0, max = 200, trim = true } = {}) {
  if (typeof value !== 'string') {
    throw new HttpError(400, `${label}格式不正确`, 'validation_error');
  }
  const text = trim ? value.trim() : value;
  if (text.length < min) throw new HttpError(400, `${label}不能为空`, 'validation_error');
  if (text.length > max) throw new HttpError(400, `${label}不能超过 ${max} 个字符`, 'validation_error');
  return text;
}

export function optionalString(value, label, max = 5000) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new HttpError(400, `${label}格式不正确`, 'validation_error');
  const text = value.trim();
  if (text.length > max) throw new HttpError(400, `${label}不能超过 ${max} 个字符`, 'validation_error');
  return text;
}

export function normalizeEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (email.length < 5 || email.length > 254 || !EMAIL_RE.test(email)) {
    throw new HttpError(400, '请输入有效的邮箱地址', 'validation_error');
  }
  return email;
}

/** Accept "zh", "en", "de" and common BCP-47 tags such as zh-Hans-DE or de-AT. */
export function normalizeLocale(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (SUPPORTED_LOCALES.has(text)) return text;
  if (text.startsWith('zh')) return 'zh';
  if (text.startsWith('en')) return 'en';
  if (text.startsWith('de')) return 'de';
  return '';
}

export function localeForUser(body, req) {
  return (
    normalizeLocale(body?.locale) ||
    normalizeLocale(req?.headers?.['accept-language']) ||
    'zh'
  );
}

export function validatePassword(value) {
  const password = typeof value === 'string' ? value : '';
  if (password.length < 8) throw new HttpError(400, '密码至少需要 8 个字符', 'validation_error');
  if (password.length > 128) throw new HttpError(400, '密码不能超过 128 个字符', 'validation_error');
  return password;
}

export function publicUser(row) {
  return {
    id: row.id,
    email: row.email || null,
    emailVerified: Boolean(row.email_verified),
    createdAt: row.created_at,
  };
}

/**
 * Resolve the client IP address. Only trusts X-Forwarded-For / X-Real-IP when
 * RED_PANDA_TRUST_PROXY=1 is explicitly configured.
 */
export function getClientIp(req, config) {
  if (config?.trustProxy) {
    const forwarded = req?.headers?.['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      const first = forwarded.split(',')[0].trim();
      if (first) return first;
    }
    const realIp = req?.headers?.['x-real-ip'];
    if (typeof realIp === 'string' && realIp.trim()) {
      return realIp.trim();
    }
  }
  return req?.socket?.remoteAddress ?? 'unknown';
}
