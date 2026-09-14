const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
  WORK_CATEGORY_MIGRATION_NAME,
  WORK_CATEGORY_RECORDS_MIGRATION_NAME,
  WORK_TOOLS_VISIBILITY_MIGRATION_NAME,
  WORK_UPDATES_MIGRATION_NAME,
  initializeDatabase,
} = require('../src/db');
const { MAX_SLUG_BYTES } = require('../src/lib/slug');

const expectedColumns = [
  'cover_image',
  'is_downloadable',
  'download_file',
  'experience_url',
  'main_media_type',
  'main_media_path',
  'gallery',
  'version_log',
];

test('旧 works 表保留真实记录、补齐字段并幂等执行内容迁移', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-work-schema-'));
  const dataDir = path.join(root, 'data');
  const databasePath = path.join(dataDir, 'legacy.sqlite3');
  const config = {
    serverRoot: path.resolve(__dirname, '..'),
    dataDir,
    databasePath,
    schemaPath: path.resolve(__dirname, '..', 'data', 'schema.sql'),
    contentDir: path.join(root, 'content'),
    uploadsDir: path.join(root, 'uploads'),
  };

  let database;
  try {
    await fs.mkdir(dataDir, { recursive: true });
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE works (
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
    `);
    const insert = legacy.prepare(`
      INSERT INTO works (title, slug, work_date, category, summary, detail_intro, markdown_path, created_at, updated_at)
      VALUES (?, ?, '2026-08-08', ?, '摘要', '简介', ?, '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')
    `);
    const categories = ['影像创作', 'AI音乐', 'AI影像', '三维建模', '网页设计', '软件', 'AI系统'];
    categories.forEach((category, index) => insert.run(`作品${index}`, `work-${index}`, category, `works/${index}.md`));
    const longPrefix = '旧'.repeat(100);
    insert.run(`${longPrefix}甲`, null, '程序', 'works/long-1.md');
    insert.run(`${longPrefix}乙`, null, '程序', 'works/long-2.md');
    insert.run('既有slug分类作品', 'work-slug-film', 'film', 'works/slug-film.md');
    legacy.close();

    database = initializeDatabase(config);
    const columnInfo = new Map(database.prepare('PRAGMA table_info(works)').all().map((column) => [column.name, column]));
    for (const column of expectedColumns) {
      assert.ok(columnInfo.has(column), `应补齐 ${column} 字段。`);
      assert.equal(columnInfo.get(column).notnull, 0, `${column} 应保持可空。`);
    }
    assert.equal(columnInfo.get('show_on_tools').notnull, 1, '智能工具展示开关必须为非空布尔列。');
    assert.equal(columnInfo.get('show_on_tools').dflt_value, '0');
    assert.throws(
      () => database.prepare("UPDATE works SET show_on_tools = 2 WHERE slug = 'work-0'").run(),
      /CHECK constraint failed/,
    );
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM works WHERE show_on_tools = 0').get().count,
      categories.length + 3,
      '迁移前已有作品必须完整保留并默认不展示在智能工具页。',
    );
    assert.deepEqual(
      database.prepare('SELECT category, COUNT(*) AS count FROM works GROUP BY category ORDER BY category').all(),
      [{ category: '影视', count: 5 }, { category: '程序', count: 5 }],
    );
    assert.deepEqual(
      database.prepare('SELECT name, slug FROM work_categories ORDER BY display_order, id').all(),
      [
        { name: '程序', slug: 'program' },
        { name: '影视', slug: 'film' },
        { name: '生活', slug: 'life' },
      ],
      '有既有作品的旧库必须补齐原三分组并保住作品归属。',
    );
    assert.ok(database.prepare('PRAGMA foreign_key_list(works)').all().some((row) => (
      row.table === 'work_categories'
        && row.from === 'category'
        && row.to === 'name'
        && row.on_update === 'CASCADE'
        && row.on_delete === 'RESTRICT'
    )), '迁移后的作品必须引用作品分组。');
    const backfilled = database.prepare("SELECT slug FROM works WHERE markdown_path LIKE 'works/long-%' ORDER BY id").all();
    assert.equal(backfilled.length, 2);
    assert.notEqual(backfilled[0].slug, backfilled[1].slug);
    assert.equal(backfilled[1].slug.endsWith('-2'), true);
    for (const row of backfilled) {
      assert.ok(Buffer.byteLength(row.slug, 'utf8') <= MAX_SLUG_BYTES);
      assert.match(row.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
    assert.ok(database.prepare('SELECT 1 FROM content_migrations WHERE name = ?').get(WORK_CATEGORY_MIGRATION_NAME));
    assert.ok(database.prepare('SELECT 1 FROM content_migrations WHERE name = ?').get(WORK_TOOLS_VISIBILITY_MIGRATION_NAME));
    assert.ok(database.prepare('SELECT 1 FROM content_migrations WHERE name = ?').get(WORK_CATEGORY_RECORDS_MIGRATION_NAME));

    database.prepare("UPDATE works SET category = '生活' WHERE slug = 'work-5'").run();
    database.prepare("UPDATE works SET show_on_tools = 1 WHERE slug = 'work-0'").run();
    database.close();
    database = initializeDatabase(config);
    assert.equal(
      database.prepare("SELECT category FROM works WHERE slug = 'work-5'").get().category,
      '生活',
      '迁移标记存在后不得重复改写数据。',
    );
    assert.equal(database.prepare("SELECT show_on_tools FROM works WHERE slug = 'work-0'").get().show_on_tools, 1);
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM content_migrations WHERE name = ?')
        .get(WORK_TOOLS_VISIBILITY_MIGRATION_NAME).count,
      1,
      '重复启动不得重复记录或执行智能工具展示开关迁移。',
    );
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM content_migrations WHERE name = ?')
        .get(WORK_CATEGORY_RECORDS_MIGRATION_NAME).count,
      1,
      '重复启动不得重复记录或执行数据驱动分组迁移。',
    );
    database.close();
    database = null;
  } finally {
    database?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('旧版version_log迁移为时间线且不改作品时间、重复启动不重复插入', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-work-updates-migration-'));
  const dataDir = path.join(root, 'data');
  const databasePath = path.join(dataDir, 'legacy.sqlite3');
  const config = {
    serverRoot: path.resolve(__dirname, '..'),
    dataDir,
    databasePath,
    schemaPath: path.resolve(__dirname, '..', 'data', 'schema.sql'),
    contentDir: path.join(root, 'content'),
    uploadsDir: path.join(root, 'uploads'),
  };
  let database;
  try {
    await fs.mkdir(dataDir, { recursive: true });
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE works (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        slug TEXT,
        work_date TEXT NOT NULL,
        category TEXT NOT NULL,
        summary TEXT NOT NULL,
        version_log TEXT,
        markdown_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const insert = legacy.prepare(`
      INSERT INTO works (
        title, slug, work_date, category, summary, version_log,
        markdown_path, created_at, updated_at
      ) VALUES (?, ?, '2026-09-10', '程序', '旧摘要', ?, ?, ?, ?)
    `);
    insert.run('旧作品甲', 'legacy-a', '# 甲\n\n原文不改。', 'works/a.md', '2026-09-01T01:00:00.000Z', '2026-09-10T02:00:00.000Z');
    insert.run('旧作品乙', 'legacy-b', '  乙原文保留空白\n', 'works/b.md', '2026-09-02T01:00:00.000Z', '2026-09-10T03:00:00.000Z');
    insert.run('旧作品空', 'legacy-empty', '   ', 'works/empty.md', '2026-09-03T01:00:00.000Z', '2026-09-10T04:00:00.000Z');
    const before = legacy.prepare('SELECT id, updated_at FROM works ORDER BY id').all();
    legacy.close();

    database = initializeDatabase(config);
    assert.deepEqual(database.prepare(`
      SELECT works.slug, work_updates.recorded_at, work_updates.body
      FROM work_updates JOIN works ON works.id = work_updates.work_id
      ORDER BY works.slug
    `).all(), [
      { slug: 'legacy-a', recorded_at: '2026-09-10T02:00:00.000Z', body: '# 甲\n\n原文不改。' },
      { slug: 'legacy-b', recorded_at: '2026-09-10T03:00:00.000Z', body: '  乙原文保留空白\n' },
    ]);
    assert.deepEqual(database.prepare('SELECT id, updated_at FROM works ORDER BY id').all(), before);
    assert.ok(database.prepare('SELECT 1 FROM content_migrations WHERE name = ?').get(WORK_UPDATES_MIGRATION_NAME));
    database.close();

    database = initializeDatabase(config);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM work_updates').get().count, 2);
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM content_migrations WHERE name = ?').get(WORK_UPDATES_MIGRATION_NAME).count,
      1,
    );
    assert.deepEqual(database.prepare('SELECT id, updated_at FROM works ORDER BY id').all(), before);
    database.close();
    database = null;
  } finally {
    database?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
