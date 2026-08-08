const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
  WORK_CATEGORY_MIGRATION_NAME,
  initializeDatabase,
} = require('../src/db');

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

test('旧 works 表补齐8个可空字段并只执行一次真实分类映射', async () => {
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
    legacy.close();

    let database = initializeDatabase(config);
    const columnInfo = new Map(database.prepare('PRAGMA table_info(works)').all().map((column) => [column.name, column]));
    for (const column of expectedColumns) {
      assert.ok(columnInfo.has(column), `应补齐 ${column} 字段。`);
      assert.equal(columnInfo.get(column).notnull, 0, `${column} 应保持可空。`);
    }
    assert.deepEqual(
      database.prepare('SELECT category, COUNT(*) AS count FROM works GROUP BY category ORDER BY category').all(),
      [{ category: '影视', count: 4 }, { category: '程序', count: 3 }],
    );
    assert.ok(database.prepare('SELECT 1 FROM content_migrations WHERE name = ?').get(WORK_CATEGORY_MIGRATION_NAME));

    database.prepare("UPDATE works SET category = '软件' WHERE slug = 'work-5'").run();
    database.close();
    database = initializeDatabase(config);
    assert.equal(
      database.prepare("SELECT category FROM works WHERE slug = 'work-5'").get().category,
      '软件',
      '迁移标记存在后不得重复改写数据。',
    );
    database.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
