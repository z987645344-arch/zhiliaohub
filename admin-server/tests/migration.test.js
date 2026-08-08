const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const test = require('node:test');
const Database = require('better-sqlite3');

const { applyMigration, assertServerStopped, MIGRATION_NAME } = require('../scripts/migrate-existing-content');

test('迁移前端口探测会拒绝仍在运行的后台', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await assert.rejects(assertServerStopped({ host: '127.0.0.1', port }), /仍有服务监听/);
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await assert.doesNotReject(assertServerStopped({ host: '127.0.0.1', port }));
});

test('一次性迁移在隔离目录导入11条内容、生成静态页面并拒绝重复执行', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-migration-'));
  const config = {
    serverRoot: path.resolve(__dirname, '..'),
    dataDir: path.join(root, 'data'),
    databasePath: path.join(root, 'data', 'test.sqlite3'),
    schemaPath: path.resolve(__dirname, '..', 'data', 'schema.sql'),
    contentDir: path.join(root, 'content'),
    uploadsDir: path.join(root, 'uploads'),
    siteRoot: path.join(root, 'site'),
  };
  try {
    await fs.mkdir(config.siteRoot, { recursive: true });
    await fs.writeFile(path.join(config.siteRoot, 'index.html'), 'index sentinel', 'utf8');
    await applyMigration(config);

    const database = new Database(config.databasePath, { readonly: true });
    try {
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM works').get().count, 8);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM notes').get().count, 3);
      const zhitian = database.prepare("SELECT special_status FROM works WHERE slug = 'zhitian'").get();
      assert.equal(zhitian.special_status, 'official_url_pending');
      assert.ok(database.prepare('SELECT 1 FROM content_migrations WHERE name = ?').get(MIGRATION_NAME));
    } finally {
      database.close();
    }

    const generated = (await fs.readdir(config.siteRoot)).filter((name) => /^(?:works|notes)(?:-[a-z0-9-]+)?\.html$/.test(name));
    assert.equal(generated.length, 13);
    assert.equal(await fs.readFile(path.join(config.siteRoot, 'index.html'), 'utf8'), 'index sentinel');
    const zhitianHtml = await fs.readFile(path.join(config.siteRoot, 'works-zhitian.html'), 'utf8');
    assert.match(zhitianHtml, /状态 \/ 展示入口待开放/);
    assert.match(zhitianHtml, /showcase-placeholder portfolio-cover cover-orbit/);
    assert.match(zhitianHtml, /暂无版本日志/);
    assert.doesNotMatch(zhitianHtml, /登录入口|下载作品|>下载<|>体验</);
    const aiMusicHtml = await fs.readFile(path.join(config.siteRoot, 'works-ai-music.html'), 'utf8');
    assert.match(aiMusicHtml, /content="记录从旋律构思到生成编曲的声音实验。当前详情页已建立，试听内容与制作记录仍在整理。"/);
    assert.match(aiMusicHtml, /showcase-placeholder portfolio-cover cover-wave/);
    assert.match(aiMusicHtml, /class="version-log"/);
    assert.match(await fs.readFile(path.join(config.siteRoot, 'notes-rain-window.html'), 'utf8'), /content="占位日记《雨落在窗外的时候》的详情模板。"/);
    assert.match(await fs.readFile(path.join(config.contentDir, 'notes', 'rain-window.md'), 'utf8'), /日记正文筹备中/);
    await assert.rejects(applyMigration(config), /迁移已执行过/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
