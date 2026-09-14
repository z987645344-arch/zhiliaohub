const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const { initializeDatabase } = require('../src/db');
const { MAX_SLUG_BYTES, baseSlug, createUniqueSlug } = require('../src/lib/slug');
const { ContentService } = require('../src/services/content-service');
const { PublishService, resolveSiteFile } = require('../src/services/publish-service');
const { GENERATED_MARKER } = require('../src/templates/shared');
const { renderWorkCategory, renderWorksList } = require('../src/templates/works');
const { LEGACY_CATEGORY_INPUTS, seedLegacyCategories } = require('./helpers/work-categories');

const execFileAsync = promisify(execFile);

const NAVIGATION_ITEMS = [
  ['index.html', '首页'],
  ['works.html', '作品展示'],
  ['notes.html', '学习心得'],
  ['tools.html', '智能工具'],
  ['feedback.html', '反馈中心'],
];

function assertFiveItemNavigation(html, currentHref) {
  const navigation = html.match(/<nav class="site-nav"[^>]*>(.*?)<\/nav>/s)?.[1];
  assert.ok(navigation, '页面应包含共享主导航。');
  let previousIndex = -1;
  for (const [href, label] of NAVIGATION_ITEMS) {
    const itemIndex = navigation.indexOf(`href="${href}"`);
    assert.ok(itemIndex > previousIndex, `${label}应按统一顺序出现在主导航。`);
    previousIndex = itemIndex;
  }
  assert.match(navigation, new RegExp(`<a href="${currentHref.replace('.', '\\.')}" aria-current="page">`));
}

async function createFixture({ seedCategories = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-publish-'));
  if (process.platform !== 'win32') await fs.chmod(root, 0o755);
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
  const contentService = new ContentService(database, config);
  if (seedCategories) seedLegacyCategories(contentService);
  const publishService = new PublishService(database, config);
  await fs.mkdir(path.join(config.siteRoot, 'css'), { recursive: true });
  await fs.mkdir(path.join(config.siteRoot, 'js'), { recursive: true });
  const sentinels = new Map([
    ['index.html', '<p>index sentinel</p>'],
    ['css/style.css', '/* css sentinel */'],
    ['js/site.js', '// js sentinel'],
  ]);
  for (const [filename, content] of sentinels) await fs.writeFile(path.join(config.siteRoot, filename), content, 'utf8');
  return { root, config, database, contentService, publishService, sentinels };
}

async function assertMode(filePath, expectedMode) {
  if (process.platform === 'win32') return;
  assert.equal((await fs.stat(filePath)).mode & 0o777, expectedMode, filePath);
}

async function assertReadableByNginxWorker(filePath, expectedContent) {
  if (process.platform === 'win32' || process.getuid?.() !== 0) return;
  const options = { uid: 101, gid: 101, encoding: 'utf8' };
  const identity = await execFileAsync('id', ['-u'], options);
  const content = await execFileAsync('cat', [filePath], options);
  assert.equal(identity.stdout.trim(), '101');
  assert.equal(content.stdout, expectedContent);
}

test('超长中文标题发布文件受字节上限约束且唯一后缀与链接稳定性不回归', async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    fixture.database.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  });

  assert.equal(baseSlug('Short ASCII title'), 'short-ascii-title');
  assert.equal(createUniqueSlug('Short ASCII title'), 'short-ascii-title');

  const commonPrefix = '长'.repeat(100);
  const works = [];
  for (const ending of ['甲', '乙', '丙']) {
    works.push(await fixture.contentService.createWork({
      title: `${commonPrefix}${ending}`,
      workDate: '2026-09-10',
      category: '程序',
      detailIntro: '验证超长标题不会生成超限文件名。',
      body: '超长标题发布验证。',
    }));
  }
  const note = await fixture.contentService.createNote({
    title: '日'.repeat(100),
    noteDate: '2026-09-10',
    summary: '验证超长日记标题。',
    body: '超长日记标题发布验证。',
  });

  assert.equal(works[1].slug.endsWith('-2'), true);
  assert.equal(works[2].slug.endsWith('-3'), true);
  assert.equal(new Set(works.map((work) => work.slug)).size, works.length);
  for (const record of [...works, note]) {
    assert.ok(Buffer.byteLength(record.slug, 'utf8') <= MAX_SLUG_BYTES);
    assert.match(record.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.doesNotMatch(record.slug, /-$/);
  }

  const stableSlug = works[0].slug;
  const updated = await fixture.contentService.updateWork(works[0].id, {
    title: '更新后的短标题',
    workDate: works[0].work_date,
    category: works[0].category,
    detailIntro: works[0].detail_intro,
    body: '标题更新后链接保持稳定。',
  });
  assert.equal(updated.slug, stableSlug);

  await fixture.publishService.publishAll();
  const filenames = [
    ...works.map((work) => `works-${work.slug}.html`),
    `notes-${note.slug}.html`,
  ];
  for (const filename of filenames) {
    assert.ok(Buffer.byteLength(filename, 'utf8') <= 255);
    await fs.access(path.join(fixture.config.siteRoot, filename));
  }
});

test('全量发布生成安全静态页、解决slug重名并只清理带标记的过期详情页', async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    fixture.database.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  });

  const first = await fixture.contentService.createWork({
    title: '同名作品 <script>',
    workDate: '2026-08-06',
    category: '影视',
    summary: '第一条 & 摘要',
    detailIntro: '第一条 & 摘要',
    body: '## Markdown 标题\n\n正文内容\n\n<script>alert(1)</script>\n\n[危险链接](javascript:alert(2))',
  });
  const second = await fixture.contentService.createWork({
    title: '同名作品 <script>',
    workDate: '2026-08-05',
    category: '影视',
    summary: '第二条摘要',
    detailIntro: '第二条摘要',
    body: '第二条正文',
  });
  await fixture.contentService.createWorkUpdate(first.id, {
    recordedAt: '2026-08-06T12:00',
    body: '## Markdown 标题\n\n正文内容\n\n<script>alert(1)</script>\n\n[危险链接](javascript:alert(2))',
  });
  assert.notEqual(first.slug, second.slug);
  assert.equal(second.slug, `${first.slug}-2`);

  await fs.writeFile(path.join(fixture.config.siteRoot, 'works-obsolete.html'), `${GENERATED_MARKER}\n旧页面`, 'utf8');
  await fs.writeFile(path.join(fixture.config.siteRoot, 'works-manual.html'), '<p>手工页面保留</p>', 'utf8');
  const publication = await fixture.publishService.publishAll();
  assert.equal(publication.worksCount, 2);
  assert.equal(publication.notesCount, 0);

  const listHtml = await fs.readFile(path.join(fixture.config.siteRoot, 'works.html'), 'utf8');
  const detailHtml = await fs.readFile(path.join(fixture.config.siteRoot, `works-${first.slug}.html`), 'utf8');
  const filmCategoryHtml = await fs.readFile(path.join(fixture.config.siteRoot, 'works-category-film.html'), 'utf8');
  const programCategoryHtml = await fs.readFile(path.join(fixture.config.siteRoot, 'works-category-program.html'), 'utf8');
  const lifeCategoryHtml = await fs.readFile(path.join(fixture.config.siteRoot, 'works-category-life.html'), 'utf8');
  assert.match(listHtml, /^<!-- 此文件由知了hub后台自动生成/);
  assert.match(listHtml, /data-work-slider/);
  assert.match(listHtml, /href="works-category-film\.html">查看全部/);
  assert.match(listHtml, /生活类作品还在路上/);
  assert.match(listHtml, /同名作品 &lt;script&gt;/);
  assert.doesNotMatch(listHtml, /<script>[^<]*<\/script>/);
  assert.match(detailHtml, /<h2>Markdown 标题<\/h2>/);
  assert.match(detailHtml, /第一条 &amp; 摘要/);
  assert.doesNotMatch(detailHtml, /<script>/);
  assert.doesNotMatch(detailHtml, /href="javascript:/);
  assert.match(filmCategoryHtml, /全部影视作品/);
  assert.match(filmCategoryHtml, /同名作品 &lt;script&gt;/);
  assert.match(programCategoryHtml, /程序作品正在整理中/);
  assert.match(lifeCategoryHtml, /生活类作品还在路上/);
  const feedbackHtml = await fs.readFile(path.join(fixture.config.siteRoot, 'feedback.html'), 'utf8');
  const notesHtml = await fs.readFile(path.join(fixture.config.siteRoot, 'notes.html'), 'utf8');
  assertFiveItemNavigation(listHtml, 'works.html');
  assertFiveItemNavigation(detailHtml, 'works.html');
  assertFiveItemNavigation(notesHtml, 'notes.html');
  assertFiveItemNavigation(feedbackHtml, 'feedback.html');
  assert.match(feedbackHtml, /^<!-- 此文件由知了hub后台自动生成/);
  assert.match(feedbackHtml, /还没有留言/);
  assert.doesNotMatch(feedbackHtml, /占位评论|该功能暂未开放/);
  await assert.rejects(fs.access(path.join(fixture.config.siteRoot, 'works-obsolete.html')), /ENOENT/);
  assert.equal(await fs.readFile(path.join(fixture.config.siteRoot, 'works-manual.html'), 'utf8'), '<p>手工页面保留</p>');

  for (const [filename, expected] of fixture.sentinels) {
    assert.equal(await fs.readFile(path.join(fixture.config.siteRoot, filename), 'utf8'), expected);
  }
  const state = fixture.publishService.getStatus();
  assert.equal(state.works_count, 2);
  assert.equal(state.notes_count, 0);

  for (const filename of publication.files) {
    const generatedPath = path.join(fixture.config.siteRoot, filename);
    await assertMode(generatedPath, 0o644);
    await assertMode(path.dirname(generatedPath), 0o755);
  }
  await assertReadableByNginxWorker(
    path.join(fixture.config.siteRoot, 'works.html'),
    listHtml,
  );
});

test('作品无需旧正文即可保存，更新时间线按记录时间与id倒序发布', async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    fixture.database.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  });

  const work = await fixture.contentService.createWork({
    title: '长期更新作品',
    workDate: '2026-09-10',
    category: '程序',
    detailIntro: '不填写旧版整段正文也能保存。',
  });
  assert.equal(work.version_log, null);
  assert.match(work.body, /暂无更新记录/);

  await fixture.contentService.createWorkUpdate(work.id, {
    recordedAt: '2026-09-09T08:00',
    body: '较早记录',
  });
  await fixture.contentService.createWorkUpdate(work.id, {
    recordedAt: '2026-09-10T09:00',
    body: '同时间先添加',
  });
  await fixture.contentService.createWorkUpdate(work.id, {
    recordedAt: '2026-09-10T09:00',
    body: '同时间后添加',
  });
  await fixture.publishService.publishAll();

  const detailHtml = await fs.readFile(path.join(fixture.config.siteRoot, `works-${work.slug}.html`), 'utf8');
  const laterAdded = detailHtml.indexOf('同时间后添加');
  const earlierAdded = detailHtml.indexOf('同时间先添加');
  const older = detailHtml.indexOf('较早记录');
  assert.ok(laterAdded >= 0 && laterAdded < earlierAdded && earlierAdded < older);
  assert.match(detailHtml, /2026\.09\.10 09:00 UTC\+8/);

  const snapshot = await fs.readFile(path.join(fixture.config.contentDir, ...work.markdown_path.split('/')), 'utf8');
  assert.ok(snapshot.indexOf('同时间后添加') < snapshot.indexOf('同时间先添加'));
  assert.ok(snapshot.indexOf('同时间先添加') < snapshot.indexOf('较早记录'));

  const newestUpdate = fixture.contentService.listWorkUpdates(work.id)[0];
  await fixture.contentService.deleteWorkUpdate(work.id, newestUpdate.id);
  const snapshotAfterDelete = await fs.readFile(
    path.join(fixture.config.contentDir, ...work.markdown_path.split('/')),
    'utf8',
  );
  assert.doesNotMatch(snapshotAfterDelete, /同时间后添加/);
  assert.match(snapshotAfterDelete, /同时间先添加/);
  await fixture.publishService.publishAll();
  assert.doesNotMatch(
    await fs.readFile(path.join(fixture.config.siteRoot, `works-${work.slug}.html`), 'utf8'),
    /同时间后添加/,
  );

  fixture.database.prepare('UPDATE works SET version_log = ? WHERE id = ?').run('冻结的旧列原文', work.id);
  await fixture.contentService.updateWork(work.id, {
    title: '长期更新作品（改名）',
    workDate: '2026-09-10',
    category: '程序',
    detailIntro: '只更新元数据。',
    versionLog: '不得写回旧列',
    body: '不得覆盖派生快照',
  });
  assert.equal(
    fixture.database.prepare('SELECT version_log FROM works WHERE id = ?').get(work.id).version_log,
    '冻结的旧列原文',
  );
  assert.equal(
    await fs.readFile(path.join(fixture.config.contentDir, ...work.markdown_path.split('/')), 'utf8'),
    snapshotAfterDelete,
  );
});

test('智能工具页只展示勾选作品且在空状态下仍无条件生成', async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    fixture.database.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  });

  const visible = await fixture.contentService.createWork({
    title: '已公开工具',
    workDate: '2026-09-10',
    category: '程序',
    detailIntro: '只在勾选后出现在智能工具页。',
    experienceUrl: 'https://tools.example.com/run',
    showOnTools: '1',
    body: '工具版本记录。',
  });
  await fixture.contentService.createWork({
    title: '普通程序作品',
    workDate: '2026-09-09',
    category: '程序',
    detailIntro: '没有勾选，不应出现在智能工具页。',
    experienceUrl: 'https://tools.example.com/hidden',
    body: '普通作品版本记录。',
  });

  let publication = await fixture.publishService.publishAll();
  assert.ok(publication.files.includes('tools.html'), '全量发布必须无条件包含 tools.html。');
  const toolsPath = path.join(fixture.config.siteRoot, 'tools.html');
  let toolsHtml = await fs.readFile(toolsPath, 'utf8');
  assert.match(toolsHtml, /^<!-- 此文件由知了hub后台自动生成/);
  assertFiveItemNavigation(toolsHtml, 'tools.html');
  assert.match(toolsHtml, /已公开工具/);
  assert.match(toolsHtml, /只在勾选后出现在智能工具页/);
  assert.match(toolsHtml, /href="https:\/\/tools\.example\.com\/run"/);
  assert.doesNotMatch(toolsHtml, /普通程序作品|tools\.example\.com\/hidden/);
  await assertMode(toolsPath, 0o644);
  await assertReadableByNginxWorker(toolsPath, toolsHtml);
  assert.doesNotThrow(() => resolveSiteFile(fixture.config.siteRoot, 'tools.html'));
  assert.throws(() => resolveSiteFile(fixture.config.siteRoot, 'tools-preview.html'), /不在允许范围内/);

  await fixture.contentService.updateWork(visible.id, {
    title: visible.title,
    workDate: visible.work_date,
    category: visible.category,
    detailIntro: visible.detail_intro,
    experienceUrl: visible.experience_url,
    showOnTools: '0',
    body: visible.body,
  });
  publication = await fixture.publishService.publishAll();
  assert.ok(publication.files.includes('tools.html'), '零条勾选记录时仍必须生成 tools.html。');
  toolsHtml = await fs.readFile(toolsPath, 'utf8');
  assert.doesNotMatch(toolsHtml, /已公开工具|普通程序作品/);
  assert.match(toolsHtml, /还没有公开的工具/);
  assert.doesNotMatch(toolsHtml, /建设中|规划/);
});

test('发布失败回滚仍将HTML和媒体恢复为Nginx worker可读权限', async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    fixture.database.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  });

  const sourceName = 'rollback-source.png';
  const sourcePath = path.join(fixture.config.uploadsDir, sourceName);
  await fs.mkdir(fixture.config.uploadsDir, { recursive: true });
  await fs.writeFile(sourcePath, Buffer.from('published media'));
  await fs.chmod(sourcePath, 0o600);
  const mediaPath = `assets/works/covers/${sourceName}`;
  const work = await fixture.contentService.createWork({
    title: '发布回滚权限测试',
    workDate: '2026-09-09',
    category: '程序',
    detailIntro: '验证故障路径的公开文件权限。',
    coverImage: mediaPath,
    body: '初始正文',
  });
  await fixture.publishService.publishAll();

  const htmlPath = path.join(fixture.config.siteRoot, `works-${work.slug}.html`);
  const publishedMediaPath = path.join(fixture.config.siteRoot, ...mediaPath.split('/'));
  const htmlBeforeFailure = await fs.readFile(htmlPath);
  const mediaBeforeFailure = await fs.readFile(publishedMediaPath);
  await fs.chmod(htmlPath, 0o600);
  await fs.chmod(publishedMediaPath, 0o600);

  const missingName = 'missing-after-build.png';
  await fixture.contentService.updateWork(work.id, {
    title: work.title,
    workDate: work.work_date,
    category: work.category,
    detailIntro: work.detail_intro,
    coverImage: mediaPath,
    mainMediaType: 'image',
    mainMediaPath: `assets/works/main/${missingName}`,
    body: '触发媒体复制失败的新正文',
  });

  await assert.rejects(fixture.publishService.publishAll(), /写入静态页面或媒体失败，已恢复发布前文件/);
  assert.deepEqual(await fs.readFile(htmlPath), htmlBeforeFailure);
  assert.deepEqual(await fs.readFile(publishedMediaPath), mediaBeforeFailure);
  await assertMode(htmlPath, 0o644);
  await assertMode(publishedMediaPath, 0o644);
  await assertReadableByNginxWorker(htmlPath, htmlBeforeFailure.toString('utf8'));
  await assertReadableByNginxWorker(publishedMediaPath, mediaBeforeFailure.toString('utf8'));
});

test('一级页每组按更新时间只显示最新4条，二级页保留该分类全部作品', () => {
  const works = [
    ...Array.from({ length: 5 }, (_, index) => ({
      id: index + 1,
      slug: `film-${index + 1}`,
      title: `影视作品${index + 1}`,
      category: '影视',
      detail_intro: `影视简介${index + 1}`,
      created_at: `2026-08-0${index + 1}T00:00:00.000Z`,
      updated_at: `2026-08-0${index + 1}T00:00:00.000Z`,
    })),
    {
      id: 6,
      slug: 'program-1',
      title: '程序作品1',
      category: '程序',
      detail_intro: '程序简介',
      created_at: '2026-08-06T00:00:00.000Z',
      updated_at: '2026-08-06T00:00:00.000Z',
    },
  ];
  const categories = LEGACY_CATEGORY_INPUTS.map((item) => ({ ...item, empty_text: item.emptyText }));
  const listHtml = renderWorksList(categories, works);
  assert.doesNotMatch(listHtml, /影视作品1/);
  for (const index of [2, 3, 4, 5]) assert.match(listHtml, new RegExp(`影视作品${index}`));
  assert.match(listHtml, /5 ITEMS \/ LATEST 4/);
  assert.match(listHtml, /data-card-count="4"/);
  assert.match(listHtml, /生活类作品还在路上/);

  const categoryHtml = renderWorkCategory(categories[1], works);
  for (const index of [1, 2, 3, 4, 5]) assert.match(categoryHtml, new RegExp(`影视作品${index}`));
  assert.match(categoryHtml, /href="works\.html">← 返回作品展示/);
});

test('手写首页使用统一五项导航', async () => {
  const siteRoot = path.resolve(__dirname, '..', '..');
  const indexHtml = await fs.readFile(path.join(siteRoot, 'index.html'), 'utf8');
  assertFiveItemNavigation(indexHtml, 'index.html');
});
