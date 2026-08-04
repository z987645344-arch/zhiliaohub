CREATE TABLE IF NOT EXISTS works (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  work_date TEXT NOT NULL,
  category TEXT NOT NULL,
  summary TEXT NOT NULL,
  markdown_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  note_date TEXT NOT NULL,
  summary TEXT NOT NULL,
  markdown_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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

CREATE INDEX IF NOT EXISTS idx_works_date ON works(work_date DESC);
CREATE INDEX IF NOT EXISTS idx_notes_date ON notes(note_date DESC);
