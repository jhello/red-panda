import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT NOT NULL,
  username_lower TEXT NOT NULL UNIQUE,
  email          TEXT,
  email_lower    TEXT,
  display_name   TEXT,
  password_hash  TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  locale         TEXT NOT NULL DEFAULT '',
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
  expires_at TEXT NOT NULL
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
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journeys_user ON journeys(user_id, updated_at DESC);
`;

/**
 * Bring databases created before email registration up to date.
 * Existing accounts have no email, so they are grandfathered as verified and
 * can still log in with their username.
 */
function migrate(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(users)').all().map((row) => row.name));
  const additions = [
    ['email', 'email TEXT'],
    ['email_lower', 'email_lower TEXT'],
    ['display_name', 'display_name TEXT'],
    ['email_verified', 'email_verified INTEGER NOT NULL DEFAULT 0'],
    ['locale', "locale TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [name, ddl] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${ddl}`);
  }
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email_lower) WHERE email_lower IS NOT NULL',
  );
  db.exec("UPDATE users SET display_name = username WHERE display_name IS NULL OR display_name = ''");
  db.exec('UPDATE users SET email_verified = 1 WHERE email IS NULL');
}

export function openDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  migrate(db);

  const statements = {
    insertUser: db.prepare(
      `INSERT INTO users
        (username, username_lower, email, email_lower, display_name, password_hash, email_verified, locale, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    userByName: db.prepare('SELECT * FROM users WHERE username_lower = ?'),
    userByEmail: db.prepare('SELECT * FROM users WHERE email_lower = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    touchLogin: db.prepare('UPDATE users SET last_login_at = ?, last_seen_at = ? WHERE id = ?'),
    touchSeen: db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?'),
    verifyEmail: db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?'),
    updatePassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    updateLocale: db.prepare('UPDATE users SET locale = ? WHERE id = ?'),
    insertSession: db.prepare(
      'INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ),
    sessionByHash: db.prepare(
      `SELECT s.token_hash, s.user_id, s.expires_at, s.last_seen_at,
              u.username, u.email, u.display_name, u.email_verified, u.locale,
              u.created_at AS user_created_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    ),
    touchSession: db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteSessionsForUser: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    deleteOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?'),
    deleteExpired: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),

    insertVerification: db.prepare(
      'INSERT INTO email_verifications (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
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
      'INSERT INTO journeys (user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ),
    listJourneys: db.prepare(
      'SELECT id, name, description, created_at, updated_at FROM journeys WHERE user_id = ? ORDER BY updated_at DESC, id DESC',
    ),
    getJourney: db.prepare(
      'SELECT id, user_id, name, description, created_at, updated_at FROM journeys WHERE id = ? AND user_id = ?',
    ),
    updateJourney: db.prepare(
      'UPDATE journeys SET name = ?, description = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    ),
    deleteJourney: db.prepare('DELETE FROM journeys WHERE id = ? AND user_id = ?'),

    countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
    countJourneys: db.prepare('SELECT COUNT(*) AS n FROM journeys'),
    countSessions: db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?'),
    listUsers: db.prepare(
      `SELECT u.id, u.username, u.email, u.display_name, u.email_verified, u.locale,
              u.created_at, u.last_login_at, u.last_seen_at,
              (SELECT COUNT(*) FROM journeys j WHERE j.user_id = u.id) AS journey_count
       FROM users u
       ORDER BY u.created_at DESC
       LIMIT 500`,
    ),
  };

  return {
    raw: db,

    createUser({ email, passwordHash, displayName, locale, now }) {
      const lower = String(email).trim().toLowerCase();
      const name = displayName || lower.split('@')[0] || lower;
      const result = statements.insertUser.run(
        lower,
        lower,
        lower,
        lower,
        name,
        passwordHash,
        0,
        locale || '',
        now,
        now,
      );
      return Number(result.lastInsertRowid);
    },

    findUserByEmail(email) {
      return statements.userByEmail.get(String(email).toLowerCase());
    },

    findUserByUsername(username) {
      return statements.userByName.get(String(username).toLowerCase());
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

    setLocale(userId, locale) {
      statements.updateLocale.run(locale, userId);
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

    createEmailVerification({ tokenHash, userId, now, expiresAt }) {
      statements.deleteVerificationsForUser.run(userId);
      statements.insertVerification.run(tokenHash, userId, now, expiresAt);
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

    createJourney({ userId, name, description, now }) {
      const result = statements.insertJourney.run(userId, name, description, now, now);
      return this.getJourney(userId, Number(result.lastInsertRowid));
    },

    listJourneys(userId) {
      return statements.listJourneys.all(userId);
    },

    getJourney(userId, id) {
      return statements.getJourney.get(id, userId);
    },

    updateJourney({ userId, id, name, description, now }) {
      const result = statements.updateJourney.run(name, description, now, id, userId);
      if (result.changes === 0) return null;
      return this.getJourney(userId, id);
    },

    deleteJourney(userId, id) {
      return statements.deleteJourney.run(id, userId).changes > 0;
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
