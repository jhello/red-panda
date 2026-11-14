import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, '..', '..', 'web', 'connection.js'), 'utf8');

// Load the browser script into a sandbox with a fake global.
function loadModule() {
  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    globalThis: undefined,
    AbortSignal: globalThis.AbortSignal,
    setTimeout,
    clearTimeout,
    fetch: undefined,
  };
  sandbox.globalThis = sandbox;
  // eslint-disable-next-line no-new-func
  const run = new Function('module', 'exports', 'globalThis', SOURCE);
  run(module, module.exports, sandbox);
  return module.exports;
}

const { createConnectionManager, MIN_DELAY_MS, MAX_DELAY_MS, STALE_MS } = loadModule();

function jsonResponse(body, ok = true) {
  return {
    ok,
    json: async () => body,
  };
}

test('探测服务器：健康检查通过才算在线', async () => {
  const calls = [];
  const manager = createConnectionManager({
    getServer: () => 'http://server.test',
    fetch: async (url) => {
      calls.push(url);
      return jsonResponse({ ok: true });
    },
  });
  assert.equal(await manager.probe(), true);
  assert.deepEqual(calls, ['http://server.test/api/health']);
});

test('探测服务器：500 响应算离线', async () => {
  const manager = createConnectionManager({
    getServer: () => 'http://server.test',
    fetch: async () => jsonResponse({ error: 'boom' }, false),
  });
  assert.equal(await manager.probe(), false);
});

test('探测服务器：网络异常算离线，不会抛错', async () => {
  const manager = createConnectionManager({
    getServer: () => 'http://server.test',
    fetch: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(await manager.probe(), false);
});

test('探测服务器：没有配置地址时直接算离线', async () => {
  let called = false;
  const manager = createConnectionManager({
    getServer: () => '',
    fetch: async () => {
      called = true;
      return jsonResponse({ ok: true });
    },
  });
  assert.equal(await manager.probe(), false);
  assert.equal(called, false);
});

test('状态变化只在离线与在线之间来回时通知', async () => {
  const events = [];
  const manager = createConnectionManager({
    getServer: () => 'http://server.test',
    fetch: async () => jsonResponse({ ok: true }),
    onStatus: (alive, previous) => events.push([previous, alive]),
  });
  manager.setStatus(false);
  manager.setStatus(false);
  manager.setStatus(true);
  manager.setStatus(true);
  assert.deepEqual(events, [
    [null, false],
    [false, true],
  ]);
  assert.equal(manager.online, true);
});

test('离线时在线功能立即失败，不等待网络超时', async () => {
  let probes = 0;
  const manager = createConnectionManager({
    getServer: () => 'http://server.test',
    fetch: async () => {
      probes += 1;
      return jsonResponse({ ok: true });
    },
  });
  manager.setStatus(false);
  assert.equal(await manager.ensure(), false);
  // 已知离线时不再发探测请求，直接失败返回。
  assert.equal(probes, 0);
});

test('状态未知时先探测一次再决定', async () => {
  let probes = 0;
  const manager = createConnectionManager({
    getServer: () => 'http://server.test',
    fetch: async () => {
      probes += 1;
      return jsonResponse({ ok: true });
    },
  });
  assert.equal(await manager.ensure(), true);
  assert.equal(probes, 1);
  assert.equal(manager.online, true);
});

test('已在线时在线功能直接放行', async () => {
  let probes = 0;
  const manager = createConnectionManager({
    getServer: () => 'http://server.test',
    fetch: async () => {
      probes += 1;
      return jsonResponse({ ok: true });
    },
  });
  manager.setStatus(true);
  assert.equal(await manager.ensure(), true);
  assert.equal(probes, 0);
});

test('很久没确认过状态时会重新探测，避免服务器中途挂掉还在干等', async () => {
  let probes = 0;
  let clock = 1_000_000;
  const manager = createConnectionManager({
    getServer: () => 'http://server.test',
    fetch: async () => {
      probes += 1;
      return jsonResponse({ ok: true });
    },
    now: () => clock,
  });
  manager.setStatus(true);
  // 刚确认过：直接放行。
  assert.equal(await manager.ensure(), true);
  assert.equal(probes, 0);
  // 时间过去、状态过期：重新探测一次。
  clock += STALE_MS + 1;
  assert.equal(await manager.ensure(), true);
  assert.equal(probes, 1);
});

test('重新连接成功后会回调，把在线功能带回来', async () => {
  let alive = false;
  let reconnected = 0;
  const manager = createConnectionManager({
    getServer: () => 'http://server.test',
    fetch: async () => jsonResponse({ ok: alive }),
    onReconnect: async () => {
      reconnected += 1;
    },
  });
  manager.setStatus(false);
  alive = true;
  assert.equal(await manager.retry(), true);
  assert.equal(reconnected, 1);
  assert.equal(manager.online, true);
});

test('重新连接失败时保持离线', async () => {
  const manager = createConnectionManager({
    getServer: () => 'http://server.test',
    fetch: async () => jsonResponse({ ok: false }, false),
  });
  manager.setStatus(false);
  assert.equal(await manager.retry(), false);
  assert.equal(manager.online, false);
});

test('退避延迟在上限内翻倍', async () => {
  const manager = createConnectionManager({
    getServer: () => 'http://server.test',
    fetch: async () => jsonResponse({ ok: false }, false),
  });
  manager.setStatus(false);
  assert.equal(manager.delay, MIN_DELAY_MS);
  // 触发一次失败的重连，退避应当翻倍但不超过上限。
  manager.schedule();
  assert.equal(manager.delay, MIN_DELAY_MS);
  assert.ok(MAX_DELAY_MS > MIN_DELAY_MS);
});
