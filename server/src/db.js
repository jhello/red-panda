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
  password_hash  TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
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
    ['email_verified', 'email_verified INTEGER NOT NULL DEFAULT 0'],
    ['created_at', "created_at TEXT NOT NULL DEFAULT ''"],
    ['last_login_at', 'last_login_at TEXT'],
    ['last_seen_at', 'last_seen_at TEXT'],
  ];
  for (const [name, ddl] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${ddl}`);
  }
  db.exec("UPDATE users SET email_lower = lower(trim(email)) WHERE email IS NOT NULL AND (email_lower IS NULL OR trim(email_lower) = '')");
  // Username-only accounts have no recovery address. Remove them, including
  // their attached records through the configured foreign-key cascades.
  db.exec("DELETE FROM users WHERE email IS NULL OR trim(email) = '' OR email_lower IS NULL OR trim(email_lower) = ''");
  // Username columns and the profile columns (nickname, locale, usual origin)
  // are gone: profiles now live in the client's IndexedDB.
  if (columns.has('username') || columns.has('display_name') || columns.has('locale') || columns.has('usual_origin')) {
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT NOT NULL,
          email_lower TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          email_verified INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          last_login_at TEXT,
          last_seen_at TEXT
        );
        INSERT INTO users_new (id,email,email_lower,password_hash,email_verified,created_at,last_login_at,last_seen_at)
          SELECT id,email,email_lower,password_hash,email_verified,created_at,last_login_at,last_seen_at FROM users;
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

  const verificationColumns = new Set(db.prepare('PRAGMA table_info(email_verifications)').all().map((row) => row.name));
  if (!verificationColumns.has('target_email')) db.exec('ALTER TABLE email_verifications ADD COLUMN target_email TEXT');
  if (!verificationColumns.has('target_email_lower')) db.exec('ALTER TABLE email_verifications ADD COLUMN target_email_lower TEXT');

  // Journeys, memories and their media now live in the client's IndexedDB, so
  // the server tables are dropped for good.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('DROP TABLE IF EXISTS memory_media; DROP TABLE IF EXISTS memories; DROP TABLE IF EXISTS journeys;');
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export function openDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  migrate(db);

  const statements = {
    insertUser: db.prepare(
      `INSERT INTO users
        (email, email_lower, password_hash, email_verified, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    userByEmail: db.prepare('SELECT * FROM users WHERE email_lower = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    touchLogin: db.prepare('UPDATE users SET last_login_at = ?, last_seen_at = ? WHERE id = ?'),
    touchSeen: db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?'),
    verifyEmail: db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?'),
    updatePassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    updateEmail: db.prepare('UPDATE users SET email = ?, email_lower = ?, email_verified = 1 WHERE id = ?'),
    pendingEmailChange: db.prepare('SELECT target_email, expires_at FROM email_verifications WHERE user_id = ? AND target_email IS NOT NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1'),
    pendingPasswordReset: db.prepare('SELECT expires_at FROM password_resets WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1'),
    deletePendingEmailChange: db.prepare('DELETE FROM email_verifications WHERE user_id = ? AND target_email IS NOT NULL'),
    insertSession: db.prepare(
      'INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ),
    sessionByHash: db.prepare(
      `SELECT s.token_hash, s.user_id, s.expires_at, s.last_seen_at,
              u.email, u.email_verified,
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

    countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
    countSessions: db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?'),
    listUsers: db.prepare(
      `SELECT u.id, u.email, u.email_verified,
              u.created_at, u.last_login_at, u.last_seen_at
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
        passwordHash,
        0,
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

    stats() {
      return {
        users: Number(statements.countUsers.get().n),
        activeSessions: Number(statements.countSessions.get(new Date().toISOString()).n),
      };
    },

    listUsers() {
      return statements.listUsers.all().map((row) => ({ ...row }));
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
