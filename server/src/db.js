import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL,
  username_lower TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_login_at TEXT,
  last_seen_at  TEXT
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

export function openDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);

  const statements = {
    insertUser: db.prepare(
      'INSERT INTO users (username, username_lower, password_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
    ),
    userByName: db.prepare('SELECT * FROM users WHERE username_lower = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    touchLogin: db.prepare('UPDATE users SET last_login_at = ?, last_seen_at = ? WHERE id = ?'),
    touchSeen: db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?'),

    insertSession: db.prepare(
      'INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ),
    sessionByHash: db.prepare(
      `SELECT s.token_hash, s.user_id, s.expires_at, s.last_seen_at,
              u.username, u.created_at AS user_created_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    ),
    touchSession: db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteExpired: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),

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
      `SELECT u.id, u.username, u.created_at, u.last_login_at, u.last_seen_at,
              (SELECT COUNT(*) FROM journeys j WHERE j.user_id = u.id) AS journey_count
       FROM users u
       ORDER BY u.created_at DESC
       LIMIT 500`,
    ),
  };

  return {
    raw: db,

    createUser({ username, passwordHash, now }) {
      const result = statements.insertUser.run(
        username,
        username.toLowerCase(),
        passwordHash,
        now,
        now,
      );
      return Number(result.lastInsertRowid);
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

    createSession({ tokenHash, userId, now, expiresAt }) {
      statements.insertSession.run(tokenHash, userId, now, now, expiresAt);
    },

    findSession(tokenHash) {
      return statements.sessionByHash.get(tokenHash);
    },

    touchSession(tokenHash, now) {
      statements.touchSession.run(now, tokenHash);
    },

    deleteSession(tokenHash) {
      statements.deleteSession.run(tokenHash);
    },

    deleteExpiredSessions(now = new Date().toISOString()) {
      statements.deleteExpired.run(now);
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
