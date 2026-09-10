// Initializes the local SQLite metadata store from the committed schema definition.
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createUniqueSlug } = require('./lib/slug');

const WORK_CATEGORY_MIGRATION_NAME = 'works-categories-program-film-life-v1';
const WORK_TOOLS_VISIBILITY_MIGRATION_NAME = 'works-show-on-tools-v1';
const WORK_CATEGORY_RECORDS_MIGRATION_NAME = 'works-data-driven-categories-v1';
const WORK_CATEGORY_MAPPINGS = Object.freeze([
  Object.freeze({ from: '影像创作', to: '影视' }),
  Object.freeze({ from: 'AI音乐', to: '影视' }),
  Object.freeze({ from: 'AI影像', to: '影视' }),
  Object.freeze({ from: '三维建模', to: '影视' }),
  Object.freeze({ from: '网页设计', to: '程序' }),
  Object.freeze({ from: '软件', to: '程序' }),
  Object.freeze({ from: 'AI系统', to: '程序' }),
]);
const LEGACY_WORK_CATEGORIES = Object.freeze([
  Object.freeze({
    name: '程序', slug: 'program', kicker: 'PROGRAM / SOFTWARE',
    intro: '软件、网页与系统项目，从可用原型到持续维护的产品记录。',
    emptyText: '程序作品正在整理中，新的项目会从这里出现。',
  }),
  Object.freeze({
    name: '影视', slug: 'film', kicker: 'FILM / MEDIA',
    intro: '影像、声音与三维创作，记录每一次表达和实验。',
    emptyText: '影视作品正在整理中，新的内容会从这里出现。',
  }),
  Object.freeze({
    name: '生活', slug: 'life', kicker: 'LIFE / DAILY',
    intro: '来自日常生活的制作、观察和小型实践。',
    emptyText: '生活类作品还在路上，欢迎稍后再来看看。',
  }),
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

function migrateWorkToolsVisibility(database) {
  const applied = database.prepare('SELECT 1 FROM content_migrations WHERE name = ?')
    .get(WORK_TOOLS_VISIBILITY_MIGRATION_NAME);
  if (applied) return { applied: false, columnAdded: false };

  const migrate = database.transaction(() => {
    const columns = new Set(database.prepare('PRAGMA table_info(works)').all().map((row) => row.name));
    const columnAdded = !columns.has('show_on_tools');
    if (columnAdded) {
      database.exec(`
        ALTER TABLE works ADD COLUMN show_on_tools
        INTEGER NOT NULL DEFAULT 0 CHECK (show_on_tools IN (0, 1))
      `);
    }
    database.prepare('INSERT INTO content_migrations (name, applied_at) VALUES (?, ?)')
      .run(WORK_TOOLS_VISIBILITY_MIGRATION_NAME, new Date().toISOString());
    return columnAdded;
  });

  return { applied: true, columnAdded: migrate() };
}

function worksCategoryForeignKeyExists(database) {
  return database.prepare('PRAGMA foreign_key_list(works)').all().some((row) => (
    row.table === 'work_categories'
      && row.from === 'category'
      && row.to === 'name'
      && row.on_update === 'CASCADE'
      && row.on_delete === 'RESTRICT'
  ));
}

function rebuildWorksWithCategoryReference(database) {
  database.exec(`
    CREATE TABLE works_with_category_reference (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT,
      work_date TEXT NOT NULL,
      category TEXT NOT NULL,
      summary TEXT NOT NULL,
      detail_intro TEXT,
      special_status TEXT,
      is_placeholder INTEGER NOT NULL DEFAULT 0 CHECK (is_placeholder IN (0, 1)),
      show_on_tools INTEGER NOT NULL DEFAULT 0 CHECK (show_on_tools IN (0, 1)),
      display_order INTEGER,
      cover_image TEXT,
      is_downloadable INTEGER,
      download_file TEXT,
      experience_url TEXT,
      main_media_type TEXT,
      main_media_path TEXT,
      gallery TEXT,
      version_log TEXT,
      markdown_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (category) REFERENCES work_categories(name) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    INSERT INTO works_with_category_reference (
      id, title, slug, work_date, category, summary, detail_intro, special_status,
      is_placeholder, show_on_tools, display_order, cover_image, is_downloadable,
      download_file, experience_url, main_media_type, main_media_path, gallery,
      version_log, markdown_path, created_at, updated_at
    )
    SELECT
      id, title, slug, work_date, category, summary, detail_intro, special_status,
      is_placeholder, show_on_tools, display_order, cover_image, is_downloadable,
      download_file, experience_url, main_media_type, main_media_path, gallery,
      version_log, markdown_path, created_at, updated_at
    FROM works;
    DROP TABLE works;
    ALTER TABLE works_with_category_reference RENAME TO works;
  `);
}

function migrateWorkCategoryRecords(database) {
  const applied = database.prepare('SELECT 1 FROM content_migrations WHERE name = ?')
    .get(WORK_CATEGORY_RECORDS_MIGRATION_NAME);
  if (applied) return { applied: false, categoriesAdded: 0, tableRebuilt: false };

  const migrate = database.transaction(() => {
    const tableRebuilt = !worksCategoryForeignKeyExists(database);
    const legacyValues = database.prepare('SELECT DISTINCT category FROM works ORDER BY category')
      .all().map((row) => String(row.category));
    const now = new Date().toISOString();
    let categoriesAdded = 0;
    const insert = database.prepare(`
      INSERT OR IGNORE INTO work_categories (
        name, slug, kicker, intro, empty_text, display_order, is_visible, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);

    if (legacyValues.length > 0) {
      for (const [index, category] of LEGACY_WORK_CATEGORIES.entries()) {
        categoriesAdded += insert.run(
          category.name,
          category.slug,
          category.kicker,
          category.intro,
          category.emptyText,
          (index + 1) * 10,
          now,
          now,
        ).changes;
      }
    }

    const knownByNameOrSlug = new Map();
    for (const category of LEGACY_WORK_CATEGORIES) {
      knownByNameOrSlug.set(category.name, category.name);
      knownByNameOrSlug.set(category.slug, category.name);
    }
    const usedSlugs = new Set(database.prepare('SELECT slug FROM work_categories').all().map((row) => row.slug));
    const normalizeWorkCategory = database.prepare('UPDATE works SET category = ? WHERE category = ?');
    let fallbackIndex = 1;
    for (const legacyValue of legacyValues) {
      const knownName = knownByNameOrSlug.get(legacyValue);
      if (knownName) {
        if (knownName !== legacyValue) normalizeWorkCategory.run(knownName, legacyValue);
        continue;
      }
      let fallbackSlug;
      do {
        fallbackSlug = `legacy-category-${fallbackIndex}`;
        fallbackIndex += 1;
      } while (usedSlugs.has(fallbackSlug));
      usedSlugs.add(fallbackSlug);
      categoriesAdded += insert.run(
        legacyValue,
        fallbackSlug,
        'LEGACY / CATEGORY',
        `${legacyValue}分类的历史作品。`,
        `${legacyValue}分类目前没有作品。`,
        1000 + fallbackIndex,
        now,
        now,
      ).changes;
    }

    if (tableRebuilt) rebuildWorksWithCategoryReference(database);
    const violations = database.prepare('PRAGMA foreign_key_check(works)').all();
    if (violations.length > 0) throw new Error('作品分组迁移后外键检查失败。');
    database.prepare('INSERT INTO content_migrations (name, applied_at) VALUES (?, ?)')
      .run(WORK_CATEGORY_RECORDS_MIGRATION_NAME, now);
    return { categoriesAdded, tableRebuilt };
  });

  return { applied: true, ...migrate() };
}

function initializeDatabase(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(path.join(config.contentDir, 'works'), { recursive: true });
  fs.mkdirSync(path.join(config.contentDir, 'notes'), { recursive: true });
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  fs.mkdirSync(config.labStorageDir || path.join(config.dataDir, 'lab-storage'), { recursive: true });

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
  addMissingColumns(database, 'feedback_comments', {
    is_admin_reply: 'INTEGER NOT NULL DEFAULT 0 CHECK (is_admin_reply IN (0, 1))',
  });
  const migrateSlugs = database.transaction(() => {
    backfillSlugs(database, 'works');
    backfillSlugs(database, 'notes');
  });
  migrateSlugs();
  migrateWorkCategories(database);
  migrateWorkToolsVisibility(database);
  migrateWorkCategoryRecords(database);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_works_date ON works(work_date DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_works_slug ON works(slug) WHERE slug IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_slug ON notes(slug) WHERE slug IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_work_categories_visible_order ON work_categories(is_visible, display_order, id);
  `);
  return database;
}

module.exports = {
  LEGACY_WORK_CATEGORIES,
  WORK_CATEGORY_MAPPINGS,
  WORK_CATEGORY_MIGRATION_NAME,
  WORK_CATEGORY_RECORDS_MIGRATION_NAME,
  WORK_TOOLS_VISIBILITY_MIGRATION_NAME,
  initializeDatabase,
  migrateWorkCategories,
  migrateWorkCategoryRecords,
  migrateWorkToolsVisibility,
};
