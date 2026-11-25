import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'red-panda-google-places-'));
const config = loadConfig({
  ...process.env,
  RED_PANDA_DATA_DIR: tempDir,
  RED_PANDA_DB: path.join(tempDir, 'test.db'),
  RED_PANDA_ADMIN_TOKEN: 'test-admin-token',
  RED_PANDA_EMAIL_RATE_LIMIT: '100',
  GOOGLE_MAPS_API_KEY: 'test-google-key',
  PORT: '0',
  HOST: '127.0.0.1',
});

const outbox = [];
const app = createApp(config, {
  mailer: {
    mode: 'test',
    async send(message) {
      outbox.push(message);
    },
  },
});
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
const realFetch = globalThis.fetch;

function json(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function linkFrom(message) {
  const match = /https?:\/\/\S+/.exec(message.text);
  assert.ok(match, '验证邮件里没有链接');
  return match[0];
}

function tokenFrom(link) {
  const match = /[?&]token=([^&\s]+)/.exec(link);
  assert.ok(match, `验证链接里没有令牌: ${link}`);
  return decodeURIComponent(match[1]);
}

async function request(pathname, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await realFetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
  return { status: response.status, data };
}

const place = {
  id: 'place-1',
  displayName: { text: '附近茶馆' },
  formattedAddress: '北京市东城区1号',
  location: { latitude: 39.909, longitude: 116.3975 },
  addressComponents: [
    { longName: '北京市', shortName: '北京', types: ['administrative_area_level_1'] },
    { longName: '东城区', shortName: '东城', types: ['administrative_area_level_2'] },
  ],
  types: ['cafe'],
};

after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Google 地点接口使用正确的位置字段', async () => {
  await request('/api/auth/register', {
    method: 'POST',
    body: { email: 'googleplaces@example.com', password: 'password123' },
  });
  const verifyToken = tokenFrom(linkFrom(outbox.find((m) => m.to === 'googleplaces@example.com')));
  await request(`/api/auth/verify?token=${encodeURIComponent(verifyToken)}`);
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'googleplaces@example.com', password: 'password123' },
  });
  const token = login.data.token;

  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input.url || input.href || String(input));
    if (url.startsWith(base)) return realFetch(input, init);
    calls.push({ url, ...init, body: init.body ? JSON.parse(init.body) : null });
    if (url.includes('/places:searchNearby') || url.includes('/places:searchText')) return json({ places: [place] });
    if (url.includes('/maps/api/geocode/json')) {
      return json({
        results: [{
          formatted_address: '北京市东城区1号',
          address_components: place.addressComponents,
        }],
      });
    }
    throw new Error(`未预期的外部请求: ${url}`);
  };

  const nearby = await request('/api/me/usual-origin/nearby', {
    method: 'POST', token,
    body: { lat: 39.908823, lng: 116.39747, provider: 'google' },
  });
  assert.equal(nearby.status, 200);
  assert.equal(nearby.data.pois[0].name, '附近茶馆');
  const nearbyCall = calls.find((c) => c.url.includes('/places:searchNearby'));
  assert.ok(nearbyCall, 'nearby 应调用 Google Places searchNearby');
  assert.deepEqual(nearbyCall.body.locationRestriction, {
    circle: { center: { latitude: 39.908823, longitude: 116.39747 }, radius: 1000 },
  });
  assert.equal(nearbyCall.body.locationBias, undefined, 'searchNearby 不接受 locationBias');
  assert.equal(nearbyCall.headers['X-Goog-Api-Key'], 'test-google-key');

  const reverse = await request('/api/me/usual-origin/reverse', {
    method: 'POST', token,
    body: { lat: 39.908823, lng: 116.39747, provider: 'google' },
  });
  assert.equal(reverse.status, 200);
  assert.equal(reverse.data.address, '北京市东城区1号');
  const geocodeCall = calls.find((c) => c.url.includes('/maps/api/geocode/json'));
  assert.equal(new URL(geocodeCall.url).searchParams.get('key'), 'test-google-key', 'Geocoding API 需要用 key 查询参数');
  const reverseCall = calls.filter((c) => c.url.includes('/places:searchNearby')).at(-1);
  assert.ok(reverseCall.body.locationRestriction, 'reverse 的附近地点也应使用 locationRestriction');
  assert.equal(reverseCall.body.locationBias, undefined);

  const search = await request('/api/me/usual-origin/search', {
    method: 'POST', token,
    body: { keyword: '茶馆', lat: 39.908823, lng: 116.39747, provider: 'google' },
  });
  assert.equal(search.status, 200);
  const searchCall = calls.find((c) => c.url.includes('/places:searchText'));
  assert.ok(searchCall, 'search 应调用 Google Places searchText');
  assert.ok(searchCall.body.locationBias, 'searchText 应使用 locationBias');
  assert.equal(searchCall.body.locationRestriction, undefined);
});
