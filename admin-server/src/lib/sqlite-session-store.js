// Persists express-session state in the existing SQLite database with expiry enforcement.
const session = require('express-session');

function callbackResult(callback, operation) {
  try {
    callback(null, operation());
  } catch (error) {
    callback(error);
  }
}

class SQLiteSessionStore extends session.Store {
  constructor({ database, defaultTtlMs, cleanupIntervalMs = 15 * 60 * 1000 }) {
    super();
    this.database = database;
    this.defaultTtlMs = defaultTtlMs;
    this.statements = {
      get: database.prepare('SELECT data, expires_at FROM sessions WHERE session_id = ?'),
      set: database.prepare(`
        INSERT INTO sessions (session_id, data, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          data = excluded.data,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `),
      touch: database.prepare('UPDATE sessions SET expires_at = ?, updated_at = ? WHERE session_id = ?'),
      destroy: database.prepare('DELETE FROM sessions WHERE session_id = ?'),
      clear: database.prepare('DELETE FROM sessions'),
      prune: database.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
      length: database.prepare('SELECT COUNT(*) AS count FROM sessions WHERE expires_at > ?'),
      all: database.prepare('SELECT data FROM sessions WHERE expires_at > ? ORDER BY created_at'),
    };
    this.cleanupTimer = setInterval(() => this.pruneExpired(), cleanupIntervalMs);
    this.cleanupTimer.unref();
    this.pruneExpired();
  }

  expiryFor(sessionData) {
    const cookieExpiry = sessionData?.cookie?.expires
      ? new Date(sessionData.cookie.expires).getTime()
      : Number.NaN;
    return Number.isFinite(cookieExpiry) ? cookieExpiry : Date.now() + this.defaultTtlMs;
  }

  get(sessionId, callback) {
    callbackResult(callback, () => {
      const row = this.statements.get.get(sessionId);
      if (!row) return null;
      if (row.expires_at <= Date.now()) {
        this.statements.destroy.run(sessionId);
        return null;
      }
      return JSON.parse(row.data);
    });
  }

  set(sessionId, sessionData, callback = () => {}) {
    callbackResult(callback, () => {
      const now = Date.now();
      this.statements.set.run(
        sessionId,
        JSON.stringify(sessionData),
        this.expiryFor(sessionData),
        new Date(now).toISOString(),
        new Date(now).toISOString(),
      );
    });
  }

  touch(sessionId, sessionData, callback = () => {}) {
    callbackResult(callback, () => {
      this.statements.touch.run(
        this.expiryFor(sessionData),
        new Date().toISOString(),
        sessionId,
      );
    });
  }

  destroy(sessionId, callback = () => {}) {
    callbackResult(callback, () => this.statements.destroy.run(sessionId));
  }

  clear(callback = () => {}) {
    callbackResult(callback, () => this.statements.clear.run());
  }

  length(callback) {
    callbackResult(callback, () => this.statements.length.get(Date.now()).count);
  }

  all(callback) {
    callbackResult(callback, () => this.statements.all.all(Date.now()).map((row) => JSON.parse(row.data)));
  }

  pruneExpired() {
    try {
      this.statements.prune.run(Date.now());
    } catch (error) {
      this.emit('disconnect', error);
    }
  }

  close() {
    clearInterval(this.cleanupTimer);
  }
}

module.exports = { SQLiteSessionStore };
