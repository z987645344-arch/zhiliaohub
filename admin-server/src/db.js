// Initializes the local SQLite metadata store from the committed schema definition.
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createUniqueSlug } = require('./lib/slug');

function addMissingColumns(database, tableName, definitions) {
  const columns = new Set(database.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name));
  for (const [column, definition] of Object.entries(definitions)) {
    if (!columns.has(column)) database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${column} ${definition}`);
  }
}

function backfillSlugs(database, tableName) {
  const rows = database.prepare(`SELECT id, title, slug FROM ${tableName} ORDER BY id`).all();
  const used = new Set(rows.map((row) => row.slug).filter(Boolean));
  const update = database.prepare(`UPDATE ${tableName} SET slug = ? WHERE id = ?`);
  for (const row of rows) {
    if (row.slug) continue;
    const slug = createUniqueSlug(row.title, used);
    used.add(slug);
    update.run(slug, row.id);
  }
}

function initializeDatabase(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(path.join(config.contentDir, 'works'), { recursive: true });
  fs.mkdirSync(path.join(config.contentDir, 'notes'), { recursive: true });
  fs.mkdirSync(config.uploadsDir, { recursive: true });

  const database = new Database(config.databasePath);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');

  const schemaPath = config.schemaPath || path.join(config.serverRoot, 'data', 'schema.sql');
  database.exec(fs.readFileSync(schemaPath, 'utf8'));
  addMissingColumns(database, 'works', {
    slug: 'TEXT',
    detail_intro: 'TEXT',
    special_status: 'TEXT',
    is_placeholder: 'INTEGER NOT NULL DEFAULT 0 CHECK (is_placeholder IN (0, 1))',
    display_order: 'INTEGER',
  });
  addMissingColumns(database, 'notes', {
    slug: 'TEXT',
    is_placeholder: 'INTEGER NOT NULL DEFAULT 0 CHECK (is_placeholder IN (0, 1))',
    display_order: 'INTEGER',
  });
  const migrateSlugs = database.transaction(() => {
    backfillSlugs(database, 'works');
    backfillSlugs(database, 'notes');
  });
  migrateSlugs();
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_works_slug ON works(slug) WHERE slug IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_slug ON notes(slug) WHERE slug IS NOT NULL;
  `);
  return database;
}

module.exports = { initializeDatabase };
