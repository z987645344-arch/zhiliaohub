const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { workFormScript } = require('../src/lib/html');
const { workFormPage } = require('../src/views');
const { createApp } = require('../src/app');

test('独立作品表单包含阶段二全部字段且日记旧字段不再混入作品表单', () => {
  const html = workFormPage({ csrfToken: 'csrf-test-token' });
  for (const name of [
    'title', 'workDate', 'category', 'detailIntro', 'coverImage', 'mainMediaType',
    'mainMediaPath', 'gallery', 'isDownloadable', 'downloadFile', 'experienceUrl', 'versionLog',
  ]) {
    assert.match(html, new RegExp(`name="${name}"`));
  }
  assert.match(html, /<option value="程序" selected>程序<\/option>/);
  assert.match(html, /data-cover-canvas/);
  assert.match(html, /multiple accept=/);
  assert.match(html, /<script src="\/admin\/work-form\.js" defer><\/script>/);
  assert.doesNotMatch(html, /name="summary"/);
  assert.doesNotMatch(html, /name="body"/);
});

test('作品表单脚本使用原生Canvas、Fetch和受CSRF保护的现有上传接口', () => {
  const script = workFormScript();
  assert.doesNotThrow(() => new Function(script), '返回给浏览器的脚本必须可以独立解析。');
  assert.match(script, /getContext\('2d'\)/);
  assert.match(script, /hitResizeHandle/);
  assert.match(script, /box\.height = box\.width \* 9 \/ 16/);
  assert.match(script, /toBlob\(resolve, 'image\/webp'/);
  assert.match(script, /fetch\(uploadApi/);
  assert.match(script, /'X-CSRF-Token': csrfToken/);
  assert.match(script, /new FormData\(\)/);
  assert.doesNotMatch(script, /new\s+Cropper|jQuery|React/);
});

test('后台CSP只允许同源表单脚本并继续拒绝内联和第三方脚本', async (t) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-work-form-csp-'));
  const { app, database, sessionStore } = createApp({
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 3001,
    sessionSecret: crypto.randomBytes(48).toString('base64url'),
    adminPasswordHash: '$2b$12$01234567890123456789012345678901234567890123456789012',
    totpEncryptionKey: crypto.randomBytes(32),
    dataDir: path.join(runtimeRoot, 'data'),
    databasePath: path.join(runtimeRoot, 'data', 'test.sqlite3'),
    contentDir: path.join(runtimeRoot, 'content'),
    uploadsDir: path.join(runtimeRoot, 'uploads'),
    siteRoot: path.join(runtimeRoot, 'site'),
  });
  t.after(async () => {
    sessionStore.close();
    database.close();
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/admin/login`);
  const policy = response.headers.get('content-security-policy') || '';
  assert.match(policy, /img-src 'self' data: blob:/);
  assert.match(policy, /script-src 'self'/);
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/);
  assert.doesNotMatch(policy, /script-src[^;]*https:/);
});
