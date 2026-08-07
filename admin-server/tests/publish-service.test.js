const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { initializeDatabase } = require('../src/db');
const { ContentService } = require('../src/services/content-service');
const { PublishService } = require('../src/services/publish-service');
const { GENERATED_MARKER } = require('../src/templates/shared');

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-publish-'));
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
  const publishService = new PublishService(database, config);
  await fs.mkdir(path.join(config.siteRoot, 'css'), { recursive: true });
  await fs.mkdir(path.join(config.siteRoot, 'js'), { recursive: true });
  const sentinels = new Map([
    ['index.html', '<p>index sentinel</p>'],
    ['feedback.html', '<p>feedback sentinel</p>'],
    ['css/style.css', '/* css sentinel */'],
    ['js/site.js', '// js sentinel'],
  ]);
  for (const [filename, content] of sentinels) await fs.writeFile(path.join(config.siteRoot, filename), content, 'utf8');
  return { root, config, database, contentService, publishService, sentinels };
}

test('全量发布生成安全静态页、解决slug重名并只清理带标记的过期详情页', async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    fixture.database.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  });

  const first = await fixture.contentService.createWork({
    title: '同名作品 <script>',
    workDate: '2026-08-06',
    category: '测试',
    summary: '第一条 & 摘要',
    body: '## Markdown 标题\n\n正文内容\n\n<script>alert(1)</script>\n\n[危险链接](javascript:alert(2))',
  });
  const second = await fixture.contentService.createWork({
    title: '同名作品 <script>',
    workDate: '2026-08-05',
    category: '测试',
    summary: '第二条摘要',
    body: '第二条正文',
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
  assert.match(listHtml, /^<!-- 此文件由知了hub后台自动生成/);
  assert.match(listHtml, /同名作品 &lt;script&gt;/);
  assert.doesNotMatch(listHtml, /<script>[^<]*<\/script>/);
  assert.match(detailHtml, /<h2>Markdown 标题<\/h2>/);
  assert.match(detailHtml, /第一条 &amp; 摘要/);
  assert.doesNotMatch(detailHtml, /<script>/);
  assert.doesNotMatch(detailHtml, /href="javascript:/);
  await assert.rejects(fs.access(path.join(fixture.config.siteRoot, 'works-obsolete.html')), /ENOENT/);
  assert.equal(await fs.readFile(path.join(fixture.config.siteRoot, 'works-manual.html'), 'utf8'), '<p>手工页面保留</p>');

  for (const [filename, expected] of fixture.sentinels) {
    assert.equal(await fs.readFile(path.join(fixture.config.siteRoot, filename), 'utf8'), expected);
  }
  const state = fixture.publishService.getStatus();
  assert.equal(state.works_count, 2);
  assert.equal(state.notes_count, 0);
});
