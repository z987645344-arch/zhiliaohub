// Initializes the local SQLite metadata store from the committed schema definition.
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createUniqueSlug } = require('./lib/slug');

const WORK_CATEGORY_MIGRATION_NAME = 'works-categories-program-film-life-v1';
const WORK_CATEGORY_MAPPINGS = Object.freeze([
  Object.freeze({ from: '影像创作', to: '影视' }),
  Object.freeze({ from: 'AI音乐', to: '影视' }),
  Object.freeze({ from: 'AI影像', to: '影视' }),
  Object.freeze({ from: '三维建模', to: '影视' }),
  Object.freeze({ from: '网页设计', to: '程序' }),
  Object.freeze({ from: '软件', to: '程序' }),
  Object.freeze({ from: 'AI系统', to: '程序' }),
]);

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

function migrateWorkCategories(database) {
  const applied = database.prepare('SELECT 1 FROM content_migrations WHERE name = ?').get(WORK_CATEGORY_MIGRATION_NAME);
  if (applied) return { applied: false, changedRows: 0 };

  const migrate = database.transaction(() => {
    const update = database.prepare('UPDATE works SET category = ? WHERE category = ?');
    let changedRows = 0;
    for (const mapping of WORK_CATEGORY_MAPPINGS) {
      changedRows += update.run(mapping.to, mapping.from).changes;
    }
    database.prepare('INSERT INTO content_migrations (name, applied_at) VALUES (?, ?)')
      .run(WORK_CATEGORY_MIGRATION_NAME, new Date().toISOString());
    return changedRows;
  });

  return { applied: true, changedRows: migrate() };
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
    cover_image: 'TEXT',
    is_downloadable: 'INTEGER',
    download_file: 'TEXT',
    experience_url: 'TEXT',
    main_media_type: 'TEXT',
    main_media_path: 'TEXT',
    gallery: 'TEXT',
    version_log: 'TEXT',
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
  migrateWorkCategories(database);
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_works_slug ON works(slug) WHERE slug IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_slug ON notes(slug) WHERE slug IS NOT NULL;
  `);
  return database;
}

module.exports = {
  WORK_CATEGORY_MAPPINGS,
  WORK_CATEGORY_MIGRATION_NAME,
  initializeDatabase,
  migrateWorkCategories,
};
