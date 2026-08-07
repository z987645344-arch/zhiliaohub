CREATE TABLE IF NOT EXISTS works (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT,
  work_date TEXT NOT NULL,
  category TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail_intro TEXT,
  special_status TEXT,
  is_placeholder INTEGER NOT NULL DEFAULT 0 CHECK (is_placeholder IN (0, 1)),
  display_order INTEGER,
  markdown_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT,
  note_date TEXT NOT NULL,
  summary TEXT NOT NULL,
  is_placeholder INTEGER NOT NULL DEFAULT 0 CHECK (is_placeholder IN (0, 1)),
  display_order INTEGER,
  markdown_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS publish_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_published_at TEXT NOT NULL,
  works_count INTEGER NOT NULL,
  notes_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS content_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  totp_ciphertext TEXT,
  totp_iv TEXT,
  totp_auth_tag TEXT,
  totp_bound_at TEXT,
  last_used_step INTEGER,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  device_name TEXT NOT NULL,
  public_key_pem TEXT NOT NULL,
  public_key_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS pairing_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS device_challenges (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  challenge TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at TEXT,
  FOREIGN KEY (device_id) REFERENCES devices(id)
);

CREATE INDEX IF NOT EXISTS idx_works_date ON works(work_date DESC);
CREATE INDEX IF NOT EXISTS idx_notes_date ON notes(note_date DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_single_active ON devices(revoked) WHERE revoked = 0;
CREATE INDEX IF NOT EXISTS idx_pairing_codes_expiry ON pairing_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_device_challenges_expiry ON device_challenges(expires_at);
