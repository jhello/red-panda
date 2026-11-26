import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { mockRecap } from '../src/ai.js';
import { createApp } from '../src/app.js';
import { hashPassword, hashPasswordAsync, verifyPassword, verifyPasswordAsync } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { getClientIp } from '../src/http-utils.js';
import { RateLimiter } from '../src/rate-limit.js';
import {
  buildJourneyDescriptionMessages,
  buildJourneyPlanMessages,
  buildMemoryRecapMessages,
} from '../src/routes/ai.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'red-panda-sec-'));

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('异步密码哈希与校验正常工作且与同步实现互相兼容', async () => {
  const asyncHash = await hashPasswordAsync('secret-pass-123');
  assert.ok(asyncHash.startsWith('scrypt$'));
  assert.equal(await verifyPasswordAsync('secret-pass-123', asyncHash), true);
  assert.equal(await verifyPasswordAsync('wrong-pass', asyncHash), false);
  assert.equal(verifyPassword('secret-pass-123', asyncHash), true);

  const syncHash = hashPassword('legacy-pass-456');
  assert.equal(await verifyPasswordAsync('legacy-pass-456', syncHash), true);
  assert.equal(await verifyPasswordAsync('wrong', syncHash), false);
});

test('RateLimiter 支持窗口限流、重置与过期条目清理', () => {
  let clock = 1_000;
  const limiter = new RateLimiter({ max: 2, windowMs: 10_000, now: () => clock });

  assert.equal(limiter.consume('u1'), true);
  assert.equal(limiter.consume('u1'), true);
  assert.equal(limiter.consume('u1'), false);
  assert.equal(limiter.consume('u2'), true);
  assert.equal(limiter.size, 2);

  clock += 10_001;
  assert.equal(limiter.prune(), 2);
  assert.equal(limiter.size, 0);
  assert.equal(limiter.consume('u1'), true);
});

test('getClientIp 仅在开启 trustProxy 时采信 X-Forwarded-For', () => {
  const fakeReq = {
    headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
    socket: { remoteAddress: '127.0.0.1' },
  };
  assert.equal(getClientIp(fakeReq, { trustProxy: false }), '127.0.0.1');
  assert.equal(getClientIp(fakeReq, { trustProxy: true }), '203.0.113.9');
});

test('地图双 Key 配置拆分生效且向下兼容回退', () => {
  const split = loadConfig({
    ...process.env,
    RED_PANDA_DATA_DIR: tempDir,
    RED_PANDA_DB: path.join(tempDir, 'split.db'),
    AMAP_MAP_KEY: 'amap-server-secret',
    AMAP_BROWSER_KEY: 'amap-browser-public',
    GOOGLE_MAPS_API_KEY: 'google-server-secret',
    GOOGLE_MAPS_BROWSER_KEY: 'google-browser-public',
  });
  assert.equal(split.map.amap.serverKey, 'amap-server-secret');
  assert.equal(split.map.amap.browserKey, 'amap-browser-public');
  assert.equal(split.map.google.serverKey, 'google-server-secret');
  assert.equal(split.map.google.browserKey, 'google-browser-public');

  const fallback = loadConfig({
    ...process.env,
    RED_PANDA_DATA_DIR: tempDir,
    RED_PANDA_DB: path.join(tempDir, 'fallback.db'),
    AMAP_MAP_KEY: 'only-one-amap-key',
    AMAP_BROWSER_KEY: '',
    RED_PANDA_AMAP_BROWSER_KEY: '',
    GOOGLE_MAPS_API_KEY: 'only-one-google-key',
    GOOGLE_MAPS_BROWSER_KEY: '',
    RED_PANDA_GOOGLE_MAPS_BROWSER_KEY: '',
  });
  assert.equal(fallback.map.amap.browserKey, 'only-one-amap-key');
  assert.equal(fallback.map.google.browserKey, 'only-one-google-key');
});

test('AI 提示词与 mockRecap 支持 zh / en / de 三语', () => {
  const ctx = { journeyName: 'Kyoto', destination: 'Kyoto', photos: 2, videos: 1, notes: ['Autumn leaves'] };
  const enRecap = buildMemoryRecapMessages(ctx, 'en');
  assert.match(enRecap[0].content, /English/);
  const deRecap = buildMemoryRecapMessages(ctx, 'de');
  assert.match(deRecap[0].content, /Deutsch/);
  const zhRecap = buildMemoryRecapMessages(ctx, 'zh');
  assert.match(zhRecap[0].content, /旅行回忆/);

  assert.match(buildJourneyDescriptionMessages('Alps', '', 'en')[0].content, /English/);
  assert.match(buildJourneyDescriptionMessages('Alps', '', 'de')[0].content, /Deutsch/);
  assert.match(buildJourneyPlanMessages('Berlin tomorrow', 'de')[0].content, /Reiseplaner/);
  assert.match(buildJourneyPlanMessages('Tokyo next week', 'en')[0].content, /trip planner/);

  assert.match(mockRecap(ctx, 'de'), /Fotos/);
  assert.match(mockRecap(ctx, 'en'), /photos/);
  assert.match(mockRecap(ctx, 'zh'), /张照片/);
});

test('接口级验证：地图浏览器 Key 下发、AI 按用户限流与 sw.js 响应头', async () => {
  const dbPath = path.join(tempDir, 'ratelimit.db');
  const outbox = [];
  const config = loadConfig({
    ...process.env,
    RED_PANDA_DATA_DIR: tempDir,
    RED_PANDA_DB: dbPath,
    RED_PANDA_ADMIN_TOKEN: 'sec-admin',
    RED_PANDA_AI_MOCK: '1',
    RED_PANDA_AI_RATE_LIMIT: '2',
    RED_PANDA_TRUST_PROXY: '1',
    AMAP_MAP_KEY: 'srv-amap-key',
    AMAP_BROWSER_KEY: 'web-amap-key',
    GOOGLE_MAPS_API_KEY: 'srv-google-key',
    GOOGLE_MAPS_BROWSER_KEY: 'web-google-key',
    PORT: '0',
    HOST: '127.0.0.1',
  });
  const app = createApp(config, {
    mailer: {
      mode: 'test',
      async send(msg) {
        outbox.push(msg);
      },
    },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  try {
    // 1. Service Worker file headers
    const swRes = await fetch(`${base}/app/sw.js`);
    assert.equal(swRes.status, 200);
    assert.equal(swRes.headers.get('service-worker-allowed'), '/app/');
    assert.match(swRes.headers.get('cache-control') || '', /no-store/);

    // 2. Register + verify + login
    const reg = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.10' },
      body: JSON.stringify({ email: 'sec@example.com', password: 'password123' }),
    });
    assert.equal(reg.status, 201);
    const link = /https?:\/\/\S+/.exec(outbox.at(-1).text)[0];
    const tokenParam = /[?&]token=([^&\s]+)/.exec(link)[1];
    const verify = await fetch(`${base}/api/auth/verify?token=${tokenParam}`, { redirect: 'manual' });
    assert.equal(verify.status, 302);

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.10' },
      body: JSON.stringify({ email: 'sec@example.com', password: 'password123' }),
    });
    assert.equal(login.status, 200);
    const { token } = await login.json();

    // 3. /api/map/config returns browser keys, never server-only keys
    const mapCfg = await fetch(`${base}/api/map/config`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(mapCfg.status, 200);
    const mapData = await mapCfg.json();
    assert.equal(mapData.amapKey, 'web-amap-key');
    assert.equal(mapData.googleKey, 'web-google-key');

    // 4. AI per-user rate limit (max = 2)
    for (let i = 0; i < 2; i++) {
      const ok = await fetch(`${base}/api/ai/memory-recap`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ journeyId: 1, locale: 'de', context: { journeyName: 'Wien', photos: 1 } }),
      });
      assert.equal(ok.status, 200);
      const body = await ok.json();
      assert.match(body.recap, /Fotos/);
    }
    const blocked = await fetch(`${base}/api/ai/memory-recap`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ journeyId: 1, locale: 'en', context: { journeyName: 'Wien', photos: 1 } }),
    });
    assert.equal(blocked.status, 429);
    const errBody = await blocked.json();
    assert.equal(errBody.code, 'rate_limited');
  } finally {
    await app.close();
  }
});
