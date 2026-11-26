import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '..', '..', 'web');

const i18n = require(path.join(WEB_DIR, 'js', 'i18n.js'));
const storage = require(path.join(WEB_DIR, 'js', 'storage.js'));
const media = require(path.join(WEB_DIR, 'js', 'media.js'));
const backup = require(path.join(WEB_DIR, 'js', 'backup.js'));

function leafKeys(obj, prefix = '') {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...leafKeys(v, full));
    } else {
      keys.push(full);
    }
  }
  return keys.sort();
}

test('前端三语词典 zh / en / de 所有文案键完全对齐', () => {
  const zhKeys = leafKeys(i18n.I18N.zh);
  const enKeys = leafKeys(i18n.I18N.en);
  const deKeys = leafKeys(i18n.I18N.de);

  assert.deepEqual(enKeys, zhKeys, 'en 词典与 zh 词典键不一致');
  assert.deepEqual(deKeys, zhKeys, 'de 词典与 zh 词典键不一致');

  assert.equal(i18n.normalizeLocaleTag('zh-Hans-CN'), 'zh');
  assert.equal(i18n.normalizeLocaleTag('de-AT'), 'de');
  assert.equal(i18n.normalizeLocaleTag('en-GB'), 'en');
  assert.equal(i18n.normalizeLocaleTag('ja-JP'), '');

  assert.equal(
    i18n.formatTranslation('en', 'backup.storageUsage', { used: '12.0 MB', quota: '100.0 MB', percent: 12 }),
    '12.0 MB used of ~100.0 MB (12%)',
  );
});

test('前端本地存储模块按账号隔离数据库名并归一化行程计划', () => {
  assert.equal(storage.localDbNameForUser({ id: 7 }), 'red-panda-local-v1-u7');
  assert.equal(storage.localDbNameForUser({ email: 'Alice+1@Example.com' }), 'red-panda-local-v1-ealice_1_example.com');
  assert.equal(storage.localDbNameForUser(null), 'red-panda-local-v1-guest');

  const plan = storage.normalizeLocalPlan({
    items: [
      { destination: '  京都  ', departTime: '2026-11-10T08:00', returnTime: '2026-11-12T18:00' },
      { destination: '', departTime: '2026-11-01T08:00', returnTime: '2026-11-02T18:00' },
      { destination: '奈良', departTime: '2026-11-12T09:00', returnTime: '2026-11-15T20:00' },
    ],
  });
  assert.equal(plan.items.length, 2);
  assert.equal(plan.departTime, '2026-11-10T08:00');
  assert.equal(plan.returnTime, '2026-11-15T20:00');

  const journey = storage.buildLocalJourney({ name: '关西之行', plan }, {}, { id: 99, now: '2026-11-01T00:00:00.000Z' });
  assert.equal(journey.id, 99);
  assert.equal(journey.depart_time, '2026-11-10T08:00');
  assert.equal(journey.return_time, '2026-11-15T20:00');
});

test('前端照片压缩决策与等比缩放计算正确', () => {
  assert.equal(media.shouldCompressImage({ type: 'image/jpeg', size: 500_000 }), true);
  assert.equal(media.shouldCompressImage({ type: 'image/png', size: 300_000 }), true);
  assert.equal(media.shouldCompressImage({ type: 'image/jpeg', size: 50_000 }), false);
  assert.equal(media.shouldCompressImage({ type: 'image/gif', size: 2_000_000 }), false);
  assert.equal(media.shouldCompressImage({ type: 'video/mp4', size: 10_000_000 }), false);

  assert.deepEqual(media.computeScaledDimensions(4000, 3000, 1920), { width: 1920, height: 1440, scaled: true });
  assert.deepEqual(media.computeScaledDimensions(1200, 800, 1920), { width: 1200, height: 800, scaled: false });
});

test('前端备份工具支持分块 Base64 无损往返、信封校验、记录比对与存储空间估算', async () => {
  // 1. Chunked Base64 round-trip across non-multiple sizes
  const sample = new Uint8Array(1000);
  for (let i = 0; i < sample.length; i++) sample[i] = (i * 37) & 0xff;
  const chunks = backup.arrayBufferToBase64Chunks(sample, 100);
  assert.ok(chunks.length > 1);
  const restored = Buffer.concat(chunks.map((chunk) => Buffer.from(backup.base64ToUint8Array(chunk))));
  assert.deepEqual(new Uint8Array(restored), sample);

  // 2. Envelope validation
  assert.equal((await backup.parseBackupEnvelope({ format: 'other' })).errorCode, 'notBackup');
  assert.equal((await backup.parseBackupEnvelope({ format: 'red-panda-backup', schemaVersion: 99 })).errorCode, 'unsupportedVersion');
  const valid = await backup.parseBackupEnvelope({
    format: 'red-panda-backup',
    schemaVersion: 1,
    journeys: [{ id: 1, name: 'A' }],
    memories: [],
  });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.data.settings, []);

  const dirty = await backup.parseBackupEnvelope({
    format: 'red-panda-backup',
    schemaVersion: 1,
    journeys: [
      { id: '1" onmouseover="alert(1)', name: 'A' },
      { id: '2" onmouseover="alert(2)', name: 'B' },
    ],
    memories: [{ id: 'm" onfocus="x', journeyId: '1" onmouseover="alert(1)' }],
  });
  assert.equal(dirty.ok, true);
  assert.match(String(dirty.data.journeys[0].id), /^[0-9]+$/);
  assert.notEqual(dirty.data.journeys[0].id, dirty.data.journeys[1].id);
  assert.equal(dirty.data.memories[0].journeyId, dirty.data.journeys[0].id);
  assert.equal(
    (await backup.parseBackupEnvelope({ format: 'red-panda-backup', schemaVersion: 1, journeys: [], memories: [], settings: {} })).errorCode,
    'incomplete',
  );

  // 3. Record diffing
  const stats = await backup.compareBackupRecords(
    [
      { id: 1, name: 'Same' },
      { id: 2, name: 'Updated' },
      { id: 3, name: 'Added' },
    ],
    [
      { id: 1, name: 'Same' },
      { id: 2, name: 'Old' },
    ],
  );
  assert.equal(stats.old, 2);
  assert.equal(stats.identical, 1);
  assert.equal(stats.updated, 1);
  assert.equal(stats.added, 1);
  assert.equal(stats.records.length, 2);

  // 4. Device storage estimate
  const est = await backup.estimateDeviceStorage({
    storage: { estimate: async () => ({ usage: 850, quota: 1000 }) },
  });
  assert.equal(est.percent, 85);
  assert.equal(est.high, true);
});

test('Service Worker 预缓存列表中的每个静态文件都真实存在', () => {
  const swSource = fs.readFileSync(path.join(WEB_DIR, 'sw.js'), 'utf8');
  const match = /PRECACHE_URLS\s*=\s*\[([\s\S]*?)\]/.exec(swSource);
  assert.ok(match, 'sw.js 缺少 PRECACHE_URLS');
  const urls = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(urls.length >= 10);

  for (const rel of urls) {
    if (rel === './') continue;
    const full = path.join(WEB_DIR, rel.replace(/^\.\//, ''));
    assert.equal(fs.existsSync(full), true, `Service Worker 预缓存文件不存在: ${rel}`);
  }
});

test('创建旅程背景图按文档基址解析，拆分 CSS 后仍指向 paintings/ 而非 css/paintings/', () => {
  const appSource = fs.readFileSync(path.join(WEB_DIR, 'app.js'), 'utf8');
  assert.match(appSource, /function planBackgroundUrl\([^)]*\)\s*\{[\s\S]*?new URL\(path, document\.baseURI\)/);
  assert.match(appSource, /const background = planBackgroundUrl\(plan\.backgroundIndex\)/);

  const cssSource = fs.readFileSync(path.join(WEB_DIR, 'css', 'journey-memories.css'), 'utf8');
  assert.match(cssSource, /\.plan-screen\.has-bg::before\s*\{[\s\S]*?var\(--plan-bg\)/);

  for (const name of ['athens.jpg', 'louvre.jpg', 'neuschwanstein.jpg']) {
    assert.equal(fs.existsSync(path.join(WEB_DIR, 'paintings', name)), true);
  }
});

test('地图配置请求失败时透传错误，不再误报为未配置 Key', () => {
  const appSource = fs.readFileSync(path.join(WEB_DIR, 'app.js'), 'utf8');
  const match = /const mapConfig = \(\) => \{([\s\S]*?)\n    \};/.exec(appSource);
  assert.ok(match, '找不到 mapConfig');
  assert.doesNotMatch(match[1], /\.catch\(\(\) => \(\{\}\)\)/);
  assert.match(match[1], /mapConfigPromise = null/);
  assert.match(match[1], /throw err/);
  assert.match(appSource, /function pickerErrorMessage\(err, fallbackKey\)[\s\S]*?t\('settings\.retrySuffix'\)/);
  assert.doesNotMatch(appSource, /msg\.includes\('重试'\)/);
});

test('备份失败码全部本地化，导入改为页面确认卡片并按后缀筛选', () => {
  const backupSource = fs.readFileSync(path.join(WEB_DIR, 'js', 'backup.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(WEB_DIR, 'app.js'), 'utf8');
  const javaSource = fs.readFileSync(
    path.resolve(HERE, '..', '..', 'android', 'app', 'src', 'main', 'java', 'com', 'redpanda', 'app', 'MainActivity.java'),
    'utf8',
  );

  for (const key of [
    'exportFailedDetail', 'importFailedDetail', 'exportBusy', 'saveFailed', 'streamStartFailed',
    'chunkWriteFailed', 'bufferMissing', 'openFailed', 'invalidExtension', 'invalidFile', 'readFailed',
  ]) {
    for (const locale of ['zh', 'en', 'de']) {
      assert.equal(typeof i18n.resolveKey(i18n.I18N[locale], `backup.${key}`), 'string', `${locale} 缺少 backup.${key}`);
    }
  }

  // No raw English / Chinese system text leaks into a localized status message.
  assert.doesNotMatch(backupSource, /Save failed|Unable to start device backup stream|Failed to write backup chunk/);
  assert.doesNotMatch(javaSource, /Save cancelled|Unable to open selected file|Backup buffer missing|备份正在进行中/);
  assert.match(javaSource, /reportBackupSave\(false, "cancelled"\)/);
  assert.match(appSource, /function backupErrorText\(error, fallbackKey\)/);
  assert.doesNotMatch(appSource, /\$\{t\('backup\.exportFailed'\)\}: \$\{error\.message\}/);
  assert.doesNotMatch(appSource, /\$\{t\('backup\.importFailed'\)\}: \$\{error\.message\}/);

  // Import no longer uses a native confirm dialog; details are shown in-page.
  assert.doesNotMatch(appSource, /confirm\(t\('backup\.importConfirm'\)\)/);
  assert.match(appSource, /data-action="import-review-confirm"/);
  assert.match(appSource, /function prepareImport\(file\)/);
  assert.match(appSource, /async function commitImport\(plan\)/);

  // Statuses and the pending review card are rendered from factories, so switching
  // locale cannot leave a stale "Import cancelled" in the new language's UI.
  assert.match(appSource, /function statusText\(key, vars = \{\}\)/);
  assert.match(appSource, /function renderBackupStatus\(\)/);
  assert.match(appSource, /function setLocale\(locale\)[\s\S]*?renderBackupStatus\(\)/);
  assert.match(appSource, /function importResults\(plan\)/);
  assert.doesNotMatch(appSource, /backupStatus\(t\('backup\./);
  assert.doesNotMatch(appSource, /databaseStatus\.message/);

  // Only backup suffixes may be selected; unrelated files stay hidden in the native picker.
  assert.match(appSource, /accept="\.rpd,\.json"/);
  assert.doesNotMatch(appSource, /accept="[^"]*application\/octet-stream/);
  assert.match(javaSource, /EXTRA_MIME_TYPES, new String\[\]\{"application\/json", "application\/octet-stream"\}/);
});
