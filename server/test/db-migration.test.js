import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'red-panda-db-migration-'));
after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('旧数据库迁移到邮箱唯一账户，删除无邮箱账户及其附属数据', () => {
  const dbPath = path.join(tempDir, 'legacy.db');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      username_lower TEXT NOT NULL UNIQUE,
      email TEXT,
      email_lower TEXT,
      display_name TEXT,
      password_hash TEXT NOT NULL,
      email_verified INTEGER NOT NULL DEFAULT 0,
      locale TEXT NOT NULL DEFAULT '',
      usual_origin TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      last_login_at TEXT,
      last_seen_at TEXT
    );
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE journeys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      plan TEXT NOT NULL DEFAULT '',
      depart_time TEXT NOT NULL DEFAULT '',
      return_time TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO users (id,username,username_lower,email,email_lower,display_name,password_hash,email_verified,locale,usual_origin,created_at)
      VALUES (1,'traveler','traveler','user@example.com','user@example.com','Local nickname','hash',1,'de','[]','2024-01-01');
    INSERT INTO users (id,username,username_lower,password_hash,created_at)
      VALUES (2,'old-user','old-user','hash','2024-01-01');
    INSERT INTO journeys (user_id,name,created_at,updated_at) VALUES (1,'email-user trip','2024-01-01','2024-01-01');
    INSERT INTO journeys (user_id,name,created_at,updated_at) VALUES (2,'username-only trip','2024-01-01','2024-01-01');
  `);
  legacy.close();

  const migrated = openDatabase(dbPath);
  const columns = migrated.raw.prepare('PRAGMA table_info(users)').all().map((row) => row.name);
  assert.ok(!columns.includes('username'));
  assert.ok(!columns.includes('username_lower'));
  assert.equal(migrated.stats().users, 1);
  assert.equal(migrated.findUserByEmail('user@example.com').id, 1);
  assert.deepEqual(migrated.listJourneys(1).map((row) => row.name), ['email-user trip']);
  assert.equal(migrated.raw.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  assert.deepEqual(migrated.raw.prepare('PRAGMA foreign_key_check').all(), []);
  migrated.raw.close();
});
