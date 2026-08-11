const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { initializeDatabase } = require('../src/db');
const { validateAndFinalizeUpload } = require('../src/lib/upload-policy');
const { ContentService } = require('../src/services/content-service');
const { PublishService } = require('../src/services/publish-service');

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const MINIMAL_ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function assetPath(directory, upload) {
  return `assets/works/${directory}/${upload.storedName}`;
}

async function stageUpload(config, filename, mimeType, content) {
  const pendingPath = path.join(config.uploadsDir, `pending-${filename}`);
  await fs.writeFile(pendingPath, content);
  return validateAndFinalizeUpload({
    originalname: filename,
    mimetype: mimeType,
    path: pendingPath,
    size: content.length,
  }, config);
}

test('作品媒体完成上传、发布复制、编辑清理与删除清理完整流程', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-media-publish-'));
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
  t.after(async () => {
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const cover = await stageUpload(config, 'cover.png', 'image/png', ONE_PIXEL_PNG);
  const main = await stageUpload(config, 'main.png', 'image/png', ONE_PIXEL_PNG);
  const galleryOne = await stageUpload(config, 'gallery-one.png', 'image/png', ONE_PIXEL_PNG);
  const galleryTwo = await stageUpload(config, 'gallery-two.png', 'image/png', ONE_PIXEL_PNG);
  const download = await stageUpload(config, 'bundle.zip', 'application/zip', MINIMAL_ZIP);
  const paths = {
    cover: assetPath('covers', cover),
    main: assetPath('main', main),
    galleryOne: assetPath('gallery', galleryOne),
    galleryTwo: assetPath('gallery', galleryTwo),
    download: assetPath('downloads', download),
  };

  const created = await contentService.createWork({
    title: '阶段二媒体测试作品',
    workDate: '2026-08-08',
    category: '程序',
    detailIntro: '验证全部作品媒体字段。',
    coverImage: paths.cover,
    isDownloadable: 1,
    downloadFile: paths.download,
    experienceUrl: 'https://example.com/demo',
    mainMediaType: 'image',
    mainMediaPath: paths.main,
    gallery: JSON.stringify([paths.galleryOne, paths.galleryTwo]),
    versionLog: '## v0.1\n\n阶段二媒体发布测试。',
  });
  assert.equal(created.cover_image, paths.cover);
  assert.equal(created.is_downloadable, 1);
  assert.equal(created.version_log, '## v0.1\n\n阶段二媒体发布测试。\n');
  assert.deepEqual(JSON.parse(created.gallery), [paths.galleryOne, paths.galleryTwo]);

  const orphan = path.join(config.siteRoot, 'assets', 'works', 'gallery', 'orphan.png');
  await fs.mkdir(path.dirname(orphan), { recursive: true });
  await fs.writeFile(orphan, ONE_PIXEL_PNG);
  const firstPublication = await publishService.publishAll();
  assert.deepEqual(new Set(firstPublication.mediaFiles), new Set(Object.values(paths)));
  for (const relativePath of Object.values(paths)) {
    assert.deepEqual(await fs.readFile(path.join(config.siteRoot, ...relativePath.split('/'))),
      relativePath.endsWith('.zip') ? MINIMAL_ZIP : ONE_PIXEL_PNG);
  }
  await assert.rejects(fs.access(orphan), /ENOENT/);
  const listHtml = await fs.readFile(path.join(config.siteRoot, 'works.html'), 'utf8');
  const programCategoryHtml = await fs.readFile(path.join(config.siteRoot, 'works-category-program.html'), 'utf8');
  const detailHtml = await fs.readFile(path.join(config.siteRoot, `works-${created.slug}.html`), 'utf8');
  assert.match(listHtml, /portfolio-cover portfolio-cover-photo/);
  assert.match(listHtml, new RegExp(cover.storedName));
  assert.match(listHtml, /<small>程序<\/small>/);
  assert.match(listHtml, /验证全部作品媒体字段。/);
  assert.match(programCategoryHtml, new RegExp(cover.storedName));
  assert.match(programCategoryHtml, /阶段二媒体测试作品/);
  assert.match(detailHtml, /class="showcase"/);
  assert.match(detailHtml, new RegExp(main.storedName));
  assert.match(detailHtml, new RegExp(galleryOne.storedName));
  assert.match(detailHtml, new RegExp(galleryTwo.storedName));
  assert.match(detailHtml, new RegExp(`href="${paths.download}" download`));
  assert.match(detailHtml, /href="https:\/\/example\.com\/demo" target="_blank" rel="noopener noreferrer">体验<\/a>/);
  assert.match(detailHtml, /<h2>v0\.1<\/h2>/);
  assert.doesNotMatch(detailHtml, /登录入口/);

  const replacementMain = await stageUpload(config, 'replacement-main.png', 'image/png', ONE_PIXEL_PNG);
  const replacementMainPath = assetPath('main', replacementMain);
  const updated = await contentService.updateWork(created.id, {
    title: created.title,
    workDate: created.work_date,
    category: '生活',
    detailIntro: '媒体和分类已更新。',
    coverImage: paths.cover,
    isDownloadable: 1,
    downloadFile: paths.download,
    experienceUrl: 'https://example.com/updated',
    mainMediaType: 'image',
    mainMediaPath: replacementMainPath,
    gallery: JSON.stringify([paths.galleryTwo]),
    versionLog: '## v0.2\n\n替换主图并移除一张辅图。',
  });
  await publishService.publishAll();
  assert.equal(updated.category, '生活');
  assert.equal(updated.main_media_path, replacementMainPath);
  await assert.rejects(fs.access(path.join(config.siteRoot, ...paths.main.split('/'))), /ENOENT/);
  await assert.rejects(fs.access(path.join(config.siteRoot, ...paths.galleryOne.split('/'))), /ENOENT/);
  await fs.access(path.join(config.siteRoot, ...replacementMainPath.split('/')));
  await fs.access(path.join(config.siteRoot, ...paths.galleryTwo.split('/')));
  const updatedHtml = await fs.readFile(path.join(config.siteRoot, `works-${created.slug}.html`), 'utf8');
  const updatedProgramCategoryHtml = await fs.readFile(path.join(config.siteRoot, 'works-category-program.html'), 'utf8');
  const updatedLifeCategoryHtml = await fs.readFile(path.join(config.siteRoot, 'works-category-life.html'), 'utf8');
  assert.match(updatedHtml, new RegExp(replacementMain.storedName));
  assert.doesNotMatch(updatedHtml, new RegExp(main.storedName));
  assert.doesNotMatch(updatedHtml, new RegExp(galleryOne.storedName));
  assert.match(updatedHtml, /<h2>v0\.2<\/h2>/);
  assert.doesNotMatch(updatedProgramCategoryHtml, /阶段二媒体测试作品/);
  assert.match(updatedLifeCategoryHtml, /阶段二媒体测试作品/);
  assert.match(updatedLifeCategoryHtml, /媒体和分类已更新。/);

  await contentService.deleteWork(created.id);
  await publishService.publishAll();
  for (const relativePath of [paths.cover, paths.download, paths.galleryTwo, replacementMainPath]) {
    await assert.rejects(fs.access(path.join(config.siteRoot, ...relativePath.split('/'))), /ENOENT/);
  }
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM works').get().count, 0);
  assert.equal((await fs.readdir(config.uploadsDir)).length, 6, '上传源文件保留在后台，发布清理只管理前台副本。');
});
