const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { initializeDatabase } = require('../src/db');
const { ContentService } = require('../src/services/content-service');
const { PublishService } = require('../src/services/publish-service');
const { GENERATED_MARKER } = require('../src/templates/shared');
const { renderWorkCategory, renderWorksList } = require('../src/templates/works');

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
  assert.match(listHtml, /href="works-category-film\.html">访问/);
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
  const listHtml = renderWorksList(works);
  assert.doesNotMatch(listHtml, /影视作品1/);
  for (const index of [2, 3, 4, 5]) assert.match(listHtml, new RegExp(`影视作品${index}`));
  assert.match(listHtml, /5 ITEMS \/ LATEST 4/);
  assert.match(listHtml, /data-card-count="4"/);
  assert.match(listHtml, /生活类作品还在路上/);

  const categoryHtml = renderWorkCategory('影视', works);
  for (const index of [1, 2, 3, 4, 5]) assert.match(categoryHtml, new RegExp(`影视作品${index}`));
  assert.match(categoryHtml, /href="works\.html">← 返回作品展示/);
});

test('手写首页与智能工具页使用统一五项导航，工具页不伪装真实功能', async () => {
  const siteRoot = path.resolve(__dirname, '..', '..');
  const indexHtml = await fs.readFile(path.join(siteRoot, 'index.html'), 'utf8');
  const toolsHtml = await fs.readFile(path.join(siteRoot, 'tools.html'), 'utf8');
  assertFiveItemNavigation(indexHtml, 'index.html');
  assertFiveItemNavigation(toolsHtml, 'tools.html');
  assert.match(toolsHtml, /建设和规划中/);
  assert.match(toolsHtml, /不承诺具体上线时间/);
  assert.match(toolsHtml, /href="works-zhitian\.html"/);
  assert.doesNotMatch(toolsHtml, /<(?:form|input|textarea|select)\b/i);
});
