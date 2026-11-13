import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT NOT NULL,
  email_lower    TEXT NOT NULL UNIQUE,
  display_name   TEXT,
  password_hash  TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  locale         TEXT NOT NULL DEFAULT '',
  usual_origin   TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  last_login_at  TEXT,
  last_seen_at   TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS email_verifications (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  target_email TEXT,
  target_email_lower TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON email_verifications(user_id);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);

CREATE TABLE IF NOT EXISTS journeys (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  plan        TEXT NOT NULL DEFAULT '',
  depart_time TEXT NOT NULL DEFAULT '',
  return_time TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journeys_user ON journeys(user_id, updated_at DESC);

-- 回忆：某段已经走过的行程，配上照片、视频和文字。
CREATE TABLE IF NOT EXISTS memories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  journey_id INTEGER REFERENCES journeys(id) ON DELETE CASCADE,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_journey ON memories(journey_id);

-- 回忆里的照片 / 视频：文件存在 data/uploads 下，库里只记元数据。
CREATE TABLE IF NOT EXISTS memory_media (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id  INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_key TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL DEFAULT 'image',
  mime       TEXT NOT NULL DEFAULT '',
  size       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_media_memory ON memory_media(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_media_user ON memory_media(user_id);
`;

/**
 * Bring older databases to email-only authentication and remove username-only
 * accounts that cannot receive verification or recovery mail.
 */
function migrate(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(users)').all().map((row) => row.name));
  const additions = [
    ['email', 'email TEXT'],
    ['email_lower', 'email_lower TEXT'],
    ['display_name', 'display_name TEXT'],
    ['email_verified', 'email_verified INTEGER NOT NULL DEFAULT 0'],
    ['locale', "locale TEXT NOT NULL DEFAULT ''"],
    ['usual_origin', "usual_origin TEXT NOT NULL DEFAULT '{}'"],
  ];
  for (const [name, ddl] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${ddl}`);
  }
  db.exec("UPDATE users SET email_lower = lower(trim(email)) WHERE email IS NOT NULL AND (email_lower IS NULL OR trim(email_lower) = '')");
  // Username-only accounts have no recovery address. Remove them, including
  // their attached records through the configured foreign-key cascades.
  db.exec("DELETE FROM users WHERE email IS NULL OR trim(email) = '' OR email_lower IS NULL OR trim(email_lower) = ''");
  if (columns.has('username')) {
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT NOT NULL,
          email_lower TEXT NOT NULL UNIQUE,
          display_name TEXT,
          password_hash TEXT NOT NULL,
          email_verified INTEGER NOT NULL DEFAULT 0,
          locale TEXT NOT NULL DEFAULT '',
          usual_origin TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          last_login_at TEXT,
          last_seen_at TEXT
        );
        INSERT INTO users_new (id,email,email_lower,display_name,password_hash,email_verified,locale,usual_origin,created_at,last_login_at,last_seen_at)
          SELECT id,email,email_lower,display_name,password_hash,email_verified,locale,usual_origin,created_at,last_login_at,last_seen_at FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
      COMMIT;`);
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      throw error;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email_lower) WHERE email_lower IS NOT NULL',
  );

  // 结构化行程（目的地 / 出发时间 / 返回时间）是后加的，老库补齐列。
  const journeyColumns = new Set(
    db.prepare('PRAGMA table_info(journeys)').all().map((row) => row.name),
  );
  const journeyAdditions = [
    ['plan', "plan TEXT NOT NULL DEFAULT ''"],
    ['depart_time', "depart_time TEXT NOT NULL DEFAULT ''"],
    ['return_time', "return_time TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [name, ddl] of journeyAdditions) {
    if (!journeyColumns.has(name)) db.exec(`ALTER TABLE journeys ADD COLUMN ${ddl}`);
  }
  const verificationColumns = new Set(db.prepare('PRAGMA table_info(email_verifications)').all().map((row) => row.name));
  if (!verificationColumns.has('target_email')) db.exec('ALTER TABLE email_verifications ADD COLUMN target_email TEXT');
  if (!verificationColumns.has('target_email_lower')) db.exec('ALTER TABLE email_verifications ADD COLUMN target_email_lower TEXT');

  db.exec('CREATE INDEX IF NOT EXISTS idx_journeys_time ON journeys(user_id, depart_time ASC)');
}

export function openDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  migrate(db);

  const statements = {
    insertUser: db.prepare(
      `INSERT INTO users
        (email, email_lower, display_name, password_hash, email_verified, locale, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    userByEmail: db.prepare('SELECT * FROM users WHERE email_lower = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    touchLogin: db.prepare('UPDATE users SET last_login_at = ?, last_seen_at = ? WHERE id = ?'),
    touchSeen: db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?'),
    verifyEmail: db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?'),
    updatePassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    updateEmail: db.prepare('UPDATE users SET email = ?, email_lower = ?, email_verified = 1 WHERE id = ?'),
    clearClientProfile: db.prepare("UPDATE users SET display_name = NULL, locale = '', usual_origin = '{}' WHERE id = ?"),
    pendingEmailChange: db.prepare('SELECT target_email, expires_at FROM email_verifications WHERE user_id = ? AND target_email IS NOT NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1'),
    pendingPasswordReset: db.prepare('SELECT expires_at FROM password_resets WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1'),
    deletePendingEmailChange: db.prepare('DELETE FROM email_verifications WHERE user_id = ? AND target_email IS NOT NULL'),
    insertSession: db.prepare(
      'INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ),
    sessionByHash: db.prepare(
      `SELECT s.token_hash, s.user_id, s.expires_at, s.last_seen_at,
              u.email, u.display_name, u.email_verified, u.locale,
              u.created_at AS user_created_at, u.usual_origin
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    ),
    touchSession: db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteSessionsForUser: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    deleteOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?'),
    deleteExpired: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),

    insertVerification: db.prepare(
      'INSERT INTO email_verifications (token_hash, user_id, created_at, expires_at, target_email, target_email_lower) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    verificationByHash: db.prepare('SELECT * FROM email_verifications WHERE token_hash = ?'),
    deleteVerification: db.prepare('DELETE FROM email_verifications WHERE token_hash = ?'),
    deleteVerificationsForUser: db.prepare('DELETE FROM email_verifications WHERE user_id = ?'),
    deleteExpiredVerifications: db.prepare('DELETE FROM email_verifications WHERE expires_at <= ?'),

    insertReset: db.prepare(
      'INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ),
    resetByHash: db.prepare('SELECT * FROM password_resets WHERE token_hash = ?'),
    deleteReset: db.prepare('DELETE FROM password_resets WHERE token_hash = ?'),
    deleteResetsForUser: db.prepare('DELETE FROM password_resets WHERE user_id = ?'),
    deleteExpiredResets: db.prepare('DELETE FROM password_resets WHERE expires_at <= ?'),

    insertJourney: db.prepare(
      'INSERT INTO journeys (user_id, name, description, plan, depart_time, return_time, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    listJourneys: db.prepare(
      `SELECT id, name, description, plan, depart_time, return_time, created_at, updated_at
         FROM journeys WHERE user_id = ?
        ORDER BY COALESCE(NULLIF(depart_time, ''), created_at) ASC, id ASC`,
    ),
    getJourney: db.prepare(
      'SELECT id, user_id, name, description, plan, depart_time, return_time, created_at, updated_at FROM journeys WHERE id = ? AND user_id = ?',
    ),
    updateJourney: db.prepare(
      'UPDATE journeys SET name = ?, description = ?, plan = ?, depart_time = ?, return_time = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    ),
    deleteJourney: db.prepare('DELETE FROM journeys WHERE id = ? AND user_id = ?'),

    insertMemory: db.prepare(
      'INSERT INTO memories (user_id, journey_id, note, created_at) VALUES (?, ?, ?, ?)',
    ),
    listMemories: db.prepare(
      `SELECT id, user_id, journey_id, note, created_at
         FROM memories WHERE user_id = ?
        ORDER BY created_at DESC, id DESC`,
    ),
    listMemoriesOfJourney: db.prepare(
      `SELECT id, user_id, journey_id, note, created_at
         FROM memories WHERE user_id = ? AND journey_id = ?
        ORDER BY created_at DESC, id DESC`,
    ),
    getMemory: db.prepare(
      'SELECT id, user_id, journey_id, note, created_at FROM memories WHERE id = ? AND user_id = ?',
    ),
    deleteMemory: db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?'),

    insertMedia: db.prepare(
      `INSERT INTO memory_media (memory_id, user_id, access_key, kind, mime, size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    listMedia: db.prepare(
      `SELECT id, memory_id, user_id, access_key, kind, mime, size, created_at
         FROM memory_media WHERE user_id = ? ORDER BY id ASC`,
    ),
    listMediaOfMemory: db.prepare(
      `SELECT id, memory_id, user_id, access_key, kind, mime, size, created_at
         FROM memory_media WHERE memory_id = ? ORDER BY id ASC`,
    ),
    getMedia: db.prepare(
      `SELECT id, memory_id, user_id, access_key, kind, mime, size, created_at
         FROM memory_media WHERE access_key = ?`,
    ),
    deleteMedia: db.prepare('DELETE FROM memory_media WHERE id = ? AND user_id = ?'),
    countMemoriesByJourney: db.prepare(
      'SELECT journey_id, COUNT(*) AS n FROM memories WHERE user_id = ? GROUP BY journey_id',
    ),

    countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
    countJourneys: db.prepare('SELECT COUNT(*) AS n FROM journeys'),
    countSessions: db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?'),
    listUsers: db.prepare(
      `SELECT u.id, u.email, u.display_name, u.email_verified, u.locale,
              u.created_at, u.last_login_at, u.last_seen_at,
              (SELECT COUNT(*) FROM journeys j WHERE j.user_id = u.id) AS journey_count
       FROM users u
       ORDER BY u.created_at DESC
       LIMIT 500`,
    ),
  };

  return {
    raw: db,

    createUser({ email, passwordHash, now }) {
      const lower = String(email).trim().toLowerCase();
      const result = statements.insertUser.run(
        lower,
        lower,
        null,
        passwordHash,
        0,
        '',
        now,
        now,
      );
      return Number(result.lastInsertRowid);
    },

    findUserByEmail(email) {
      return statements.userByEmail.get(String(email).toLowerCase());
    },

    findUserById(id) {
      return statements.userById.get(id);
    },

    touchLogin(userId, now) {
      statements.touchLogin.run(now, now, userId);
    },

    touchSeen(userId, now) {
      statements.touchSeen.run(now, userId);
    },

    markEmailVerified(userId) {
      statements.verifyEmail.run(userId);
    },

    setPassword(userId, passwordHash) {
      statements.updatePassword.run(passwordHash, userId);
    },

    setEmail(userId, email) {
      const lower = email.toLowerCase();
      statements.updateEmail.run(email, lower, userId);
    },

    clearClientProfile(userId) {
      statements.clearClientProfile.run(userId);
    },

    pendingEmailChange(userId, now) {
      return statements.pendingEmailChange.get(userId, now) || null;
    },

    pendingPasswordReset(userId, now) {
      return statements.pendingPasswordReset.get(userId, now) || null;
    },

    deletePendingEmailChange(userId) {
      statements.deletePendingEmailChange.run(userId);
    },

    createSession({ tokenHash, userId, now, expiresAt }) {
      statements.insertSession.run(tokenHash, userId, now, now, expiresAt);
    },

    findSession(tokenHash) {
      return statements.sessionByHash.get(tokenHash);
    },

    touchSession(tokenHash, now, expiresAt) {
      statements.touchSession.run(now, expiresAt, tokenHash);
    },

    deleteSession(tokenHash) {
      statements.deleteSession.run(tokenHash);
    },

    deleteSessionsForUser(userId) {
      statements.deleteSessionsForUser.run(userId);
    },

    deleteOtherSessions(userId, keepTokenHash) {
      statements.deleteOtherSessions.run(userId, keepTokenHash);
    },

    deleteExpiredSessions(now = new Date().toISOString()) {
      statements.deleteExpired.run(now);
    },

    createEmailVerification({ tokenHash, userId, now, expiresAt, targetEmail = null }) {
      statements.deleteVerificationsForUser.run(userId);
      statements.insertVerification.run(tokenHash, userId, now, expiresAt, targetEmail, targetEmail?.toLowerCase() || null);
    },

    consumeEmailVerification(tokenHash, now) {
      const row = statements.verificationByHash.get(tokenHash);
      if (!row) return null;
      statements.deleteVerification.run(tokenHash);
      if (Date.parse(row.expires_at) <= Date.parse(now)) return null;
      return row;
    },

    createPasswordReset({ tokenHash, userId, now, expiresAt }) {
      statements.deleteResetsForUser.run(userId);
      statements.insertReset.run(tokenHash, userId, now, expiresAt);
    },

    deleteResetsForUser(userId) {
      statements.deleteResetsForUser.run(userId);
    },

    consumePasswordReset(tokenHash, now) {
      const row = statements.resetByHash.get(tokenHash);
      if (!row) return null;
      statements.deleteReset.run(tokenHash);
      if (Date.parse(row.expires_at) <= Date.parse(now)) return null;
      return row;
    },

    deleteExpiredTokens(now = new Date().toISOString()) {
      statements.deleteExpiredVerifications.run(now);
      statements.deleteExpiredResets.run(now);
    },

    createJourney({ userId, name, description, plan = '', departTime = '', returnTime = '', now }) {
      const result = statements.insertJourney.run(
        userId,
        name,
        description,
        plan,
        departTime,
        returnTime,
        now,
        now,
      );
      return this.getJourney(userId, Number(result.lastInsertRowid));
    },

    listJourneys(userId) {
      return statements.listJourneys.all(userId);
    },

    getJourney(userId, id) {
      return statements.getJourney.get(id, userId);
    },

    updateJourney({ userId, id, name, description, plan = '', departTime = '', returnTime = '', now }) {
      const result = statements.updateJourney.run(
        name,
        description,
        plan,
        departTime,
        returnTime,
        now,
        id,
        userId,
      );
      if (result.changes === 0) return null;
      return this.getJourney(userId, id);
    },

    deleteJourney(userId, id) {
      return statements.deleteJourney.run(id, userId).changes > 0;
    },

    createMemory({ userId, journeyId = null, note = '', now }) {
      const result = statements.insertMemory.run(userId, journeyId, note, now);
      return this.getMemory(userId, Number(result.lastInsertRowid));
    },

    listMemories(userId, journeyId = null) {
      const rows =
        journeyId === null || journeyId === undefined
          ? statements.listMemories.all(userId)
          : statements.listMemoriesOfJourney.all(userId, journeyId);
      return this.attachMedia(rows);
    },

    getMemory(userId, id) {
      const row = statements.getMemory.get(id, userId);
      if (!row) return null;
      return this.attachMedia([row])[0];
    },

    /** Delete a memory and report the media files that should be removed. */
    deleteMemory(userId, id) {
      const media = statements.listMediaOfMemory.all(id);
      const deleted = statements.deleteMemory.run(id, userId).changes > 0;
      if (!deleted) return null;
      return { media };
    },

    createMedia({ memoryId, userId, accessKey, kind = 'image', mime = '', size = 0, now }) {
      const result = statements.insertMedia.run(
        memoryId,
        userId,
        accessKey,
        kind,
        mime,
        size,
        now,
      );
      return statements.getMedia.get(accessKey) ?? {
        id: Number(result.lastInsertRowid),
        memory_id: memoryId,
        user_id: userId,
        access_key: accessKey,
        kind,
        mime,
        size,
        created_at: now,
      };
    },

    getMediaByKey(accessKey) {
      return statements.getMedia.get(accessKey);
    },

    listMediaOfMemory(userId, memoryId) {
      return statements.listMediaOfMemory.all(memoryId);
    },

    deleteMedia(userId, id) {
      return statements.deleteMedia.run(id, userId).changes > 0;
    },

    countMemoriesByJourney(userId) {
      const counts = {};
      for (const row of statements.countMemoriesByJourney.all(userId)) {
        counts[row.journey_id] = Number(row.n);
      }
      return counts;
    },

    /** Attach the media rows of every memory to that memory. */
    attachMedia(rows) {
      if (!rows.length) return [];
      const media = statements.listMedia.all(rows[0].user_id);
      const grouped = new Map();
      for (const item of media) {
        if (!grouped.has(item.memory_id)) grouped.set(item.memory_id, []);
        grouped.get(item.memory_id).push(item);
      }
      return rows.map((row) => ({ ...row, media: grouped.get(row.id) ?? [] }));
    },

    stats() {
      return {
        users: Number(statements.countUsers.get().n),
        journeys: Number(statements.countJourneys.get().n),
        activeSessions: Number(statements.countSessions.get(new Date().toISOString()).n),
      };
    },

    listUsers() {
      return statements.listUsers.all().map((row) => ({
        ...row,
        journey_count: Number(row.journey_count),
      }));
    },

    close() {
      db.close();
    },
  };
}

export function fileSize(file) {
  // SQLite in WAL mode keeps recent writes in a sidecar file until a
  // checkpoint, so report the main database plus its WAL journal.
  let total = 0;
  for (const candidate of [file, `${file}-wal`]) {
    try {
      total += fs.statSync(candidate).size;
    } catch {
      // Missing sidecar files are expected when the database is idle.
    }
  }
  return total;
}
