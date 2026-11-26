import fs from 'node:fs';
import path from 'node:path';

import { sendJson } from './http-utils.js';

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

export function safeJoin(baseDir, relativePath) {
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

export function serveFile(req, res, filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const isServiceWorker = path.basename(filePath) === 'sw.js';
  const headers = {
    'Content-Type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': isServiceWorker ? 'no-cache, no-store, must-revalidate' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  };
  if (isServiceWorker) {
    headers['Service-Worker-Allowed'] = '/app/';
  }

  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
  } else {
    fs.createReadStream(filePath).pipe(res);
  }
  return true;
}

export function notFound(req, res) {
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

export function resolveStaticPath(pathname, config) {
  if (pathname === '/' || pathname === '/dashboard' || pathname === '/dashboard/') {
    return path.join(config.dashboardDir, 'index.html');
  }
  if (pathname.startsWith('/dashboard/')) {
    return safeJoin(config.dashboardDir, pathname.slice('/dashboard/'.length));
  }
  if (pathname === '/app/') {
    return path.join(config.webDir, 'index.html');
  }
  if (pathname.startsWith('/app/')) {
    return safeJoin(config.webDir, pathname.slice('/app/'.length));
  }
  if (pathname === '/favicon.ico') {
    return path.join(config.webDir, 'icon-192.png');
  }
  return null;
}
