const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { initializeDatabase } = require('../src/db');
const { ContentService } = require('../src/services/content-service');
const { PublishService } = require('../src/services/publish-service');
const { GENERATED_MARKER } = require('../src/templates/shared');
const { categoryManagementPage } = require('../src/views');

function categoryInput(overrides = {}) {
  return {
    name: '程序实验',
    slug: 'program-lab',
    kicker: 'PROGRAM / LAB',
    intro: '用于验证数据驱动分组。',
    emptyText: '这个分组还没有作品。',
    displayOrder: 10,
    isVisible: 1,
    ...overrides,
  };
}

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-work-categories-'));
  const config = {
    serverRoot: path.resolve(__dirname, '..'),
    dataDir: path.join(root, 'data'),
    databasePath: path.join(root, 'data', 'test.sqlite3'),
    schemaPath: path.resolve(__dirname, '..', 'data', 'schema.sql'),
    contentDir: path.join(root, 'content'),
    uploadsDir: path.join(root, 'uploads'),
    siteRoot: path.join(root, 'site'),
    contentMaxBytes: 64 * 1024,
  };
  const database = initializeDatabase(config);
  return {
    root,
    config,
    database,
    contentService: new ContentService(database, config),
    publishService: new PublishService(database, config),
  };
}

async function closeFixture(fixture) {
  fixture.database.close();
  await fs.rm(fixture.root, { recursive: true, force: true });
}

test('全新数据库默认零分组且发布不生成任何分类页', async (t) => {
  const fixture = await createFixture();
  t.after(() => closeFixture(fixture));

  assert.deepEqual(fixture.contentService.listCategories(), []);
  const result = await fixture.publishService.publishAll();
  assert.equal(result.files.some((filename) => filename.startsWith('works-category-')), false);
  const worksHtml = await fs.readFile(path.join(fixture.config.siteRoot, 'works.html'), 'utf8');
  assert.match(worksHtml, /作品还在整理中/);
});

test('分组slug严格校验且分组名与slug都保持唯一', async (t) => {
  const fixture = await createFixture();
  t.after(() => closeFixture(fixture));

  const created = fixture.contentService.createCategory(categoryInput());
  assert.equal(created.slug, 'program-lab');
  for (const slug of ['中文', 'UPPER', 'tail-']) {
    assert.throws(
      () => fixture.contentService.createCategory(categoryInput({ name: `分组-${slug}`, slug })),
      /URL标识只能使用/,
    );
  }
  assert.throws(
    () => fixture.contentService.createCategory(categoryInput({ name: '程序实验', slug: 'another-slug' })),
    /分组名已存在/,
  );
  assert.throws(
    () => fixture.contentService.createCategory(categoryInput({ name: '另一个分组' })),
    /URL标识已存在/,
  );

  const renamed = fixture.contentService.updateCategory(created.id, categoryInput({
    name: '工具项目',
    slug: 'tools',
  }));
  assert.equal(renamed.name, '工具项目');
  assert.equal(renamed.slug, 'tools');
});

test('作品详情简介允许恰好 100 个 Unicode 字符', async (t) => {
  const fixture = await createFixture();
  t.after(() => closeFixture(fixture));
  const category = fixture.contentService.createCategory(categoryInput());
  const detailIntro = '😀'.repeat(100);
  const work = await fixture.contentService.createWork({
    title: '百字简介作品',
    workDate: '2026-09-19',
    category: category.name,
    detailIntro,
  });
  assert.equal(work.detail_intro, detailIntro);
});

test('更新分组名会保住作品归属并让发布页切换到新slug', async (t) => {
  const fixture = await createFixture();
  t.after(() => closeFixture(fixture));

  const category = fixture.contentService.createCategory(categoryInput());
  const work = await fixture.contentService.createWork({
    title: '分组重命名作品',
    workDate: '2026-09-11',
    category: category.name,
    detailIntro: '验证外键级联更新。',
    body: '作品正文。',
  });
  await fixture.publishService.publishAll();
  await fs.access(path.join(fixture.config.siteRoot, 'works-category-program-lab.html'));

  fixture.contentService.updateCategory(category.id, categoryInput({ name: '新分组名', slug: 'new-group' }));
  assert.equal(fixture.database.prepare('SELECT category FROM works WHERE id = ?').get(work.id).category, '新分组名');
  await fixture.publishService.publishAll();
  await assert.rejects(fs.access(path.join(fixture.config.siteRoot, 'works-category-program-lab.html')), /ENOENT/);
  await fs.access(path.join(fixture.config.siteRoot, 'works-category-new-group.html'));
});

test('删除分组要求精确数量确认并清理作品Markdown、发布页与公开媒体', async (t) => {
  const fixture = await createFixture();
  t.after(() => closeFixture(fixture));

  const category = fixture.contentService.createCategory(categoryInput());
  const works = [];
  for (let index = 1; index <= 3; index += 1) {
    const filename = `category-cover-${index}.png`;
    await fs.mkdir(fixture.config.uploadsDir, { recursive: true });
    await fs.writeFile(path.join(fixture.config.uploadsDir, filename), `media-${index}`);
    works.push(await fixture.contentService.createWork({
      title: `待级联作品${index}`,
      workDate: '2026-09-11',
      category: category.name,
      detailIntro: `级联简介${index}`,
      coverImage: `assets/works/covers/${filename}`,
      body: `级联正文${index}`,
    }));
  }
  await fixture.publishService.publishAll();
  const managementHtml = categoryManagementPage({
    csrfToken: 'csrf-token',
    categories: fixture.contentService.listCategories(),
  });
  assert.match(managementHtml, /删除分组将连带删除 3 条作品/);
  assert.match(managementHtml, /我确认连带删除 3 条作品/);
  await assert.rejects(fixture.contentService.deleteCategory(category.id), /必须确认将连带删除 3 条作品/);
  await assert.rejects(
    fixture.contentService.deleteCategory(category.id, { confirmed: true, expectedWorkCount: 2 }),
    /现有 3 条作品.*数量不一致/,
  );

  await fixture.contentService.deleteCategory(category.id, { confirmed: true, expectedWorkCount: 3 });
  await fixture.publishService.publishAll();
  assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM works').get().count, 0);
  assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM work_categories').get().count, 0);
  for (const work of works) {
    await assert.rejects(
      fs.access(path.join(fixture.config.contentDir, ...work.markdown_path.split('/'))),
      /ENOENT/,
    );
    await assert.rejects(fs.access(path.join(fixture.config.siteRoot, `works-${work.slug}.html`)), /ENOENT/);
    await assert.rejects(
      fs.access(path.join(fixture.config.siteRoot, 'assets', 'works', 'covers', `category-cover-${work.id}.png`)),
      /ENOENT/,
    );
  }
  await assert.rejects(fs.access(path.join(fixture.config.siteRoot, 'works-category-program-lab.html')), /ENOENT/);
});

test('删除分组清理Markdown失败时数据库与已删文件一起回滚', async (t) => {
  const fixture = await createFixture();
  t.after(() => closeFixture(fixture));

  const category = fixture.contentService.createCategory(categoryInput());
  const first = await fixture.contentService.createWork({
    title: '先删除后恢复', workDate: '2026-09-11', category: category.name,
    detailIntro: '第一条。', body: '第一条正文。',
  });
  const second = await fixture.contentService.createWork({
    title: '模拟缺失文件', workDate: '2026-09-11', category: category.name,
    detailIntro: '第二条。', body: '第二条正文。',
  });
  const firstPath = path.join(fixture.config.contentDir, ...first.markdown_path.split('/'));
  const secondPath = path.join(fixture.config.contentDir, ...second.markdown_path.split('/'));
  await fs.unlink(secondPath);

  await assert.rejects(
    fixture.contentService.deleteCategory(category.id, { confirmed: true, expectedWorkCount: 2 }),
    /ENOENT/,
  );
  assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM works').get().count, 2);
  assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM work_categories').get().count, 1);
  assert.equal(await fs.readFile(firstPath, 'utf8'), first.body);
});

test('隐藏分组不生成一级区块或分类页，但仍保留作品详情', async (t) => {
  const fixture = await createFixture();
  t.after(() => closeFixture(fixture));

  const category = fixture.contentService.createCategory(categoryInput({ isVisible: 0 }));
  const work = await fixture.contentService.createWork({
    title: '隐藏分组作品', workDate: '2026-09-11', category: category.name,
    detailIntro: '详情仍可发布。', body: '隐藏分组正文。',
  });
  await fixture.publishService.publishAll();
  const list = await fs.readFile(path.join(fixture.config.siteRoot, 'works.html'), 'utf8');
  assert.doesNotMatch(list, /隐藏分组作品|program-lab/);
  await assert.rejects(fs.access(path.join(fixture.config.siteRoot, 'works-category-program-lab.html')), /ENOENT/);
  const detail = await fs.readFile(path.join(fixture.config.siteRoot, `works-${work.slug}.html`), 'utf8');
  assert.match(detail, /隐藏分组作品/);
  assert.ok(detail.startsWith(GENERATED_MARKER));
});
