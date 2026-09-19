const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { workFormScript } = require('../src/lib/html');
const { workFormPage } = require('../src/views');
const { createApp } = require('../src/app');

test('独立作品表单用现有分组下拉选择且日记旧字段不再混入作品表单', () => {
  const html = workFormPage({
    csrfToken: 'csrf-test-token',
    categories: [
      { name: '自定义分组', is_visible: 1 },
      { name: '隐藏分组', is_visible: 0 },
    ],
    record: { category: '隐藏分组' },
  });
  for (const name of [
    'title', 'workDate', 'category', 'detailIntro', 'detailBody', 'coverImage', 'mainMediaType',
    'mainMediaPath', 'gallery', 'isDownloadable', 'downloadFile', 'experienceUrl', 'showOnTools',
  ]) {
    assert.match(html, new RegExp(`name="${name}"`));
  }
  assert.match(html, /<option value="自定义分组">自定义分组<\/option>/);
  assert.match(html, /<option value="隐藏分组" selected>隐藏分组（前台隐藏）<\/option>/);
  assert.match(html, /data-cover-canvas/);
  assert.match(html, /name="detailIntro" required maxlength="100"/);
  assert.match(html, /data-detail-intro-count[^>]*>0 \/ 100/);
  assert.match(html, /id="work-details"/);
  assert.match(html, /name="detailBody"/);
  assert.match(html, /05 更新记录/);
  assert.match(html, /multiple accept=/);
  assert.match(html, /在智能工具页显示这条作品/);
  assert.match(html, /<script src="\/admin\/work-form\.js" defer><\/script>/);
  assert.doesNotMatch(html, /name="summary"/);
  assert.doesNotMatch(html, /name="body"/);
  assert.doesNotMatch(html, /name="versionLog"/);
  assert.match(html, /先保存作品，再回来逐条添加带时间的更新记录/);
});

test('编辑作品表单列出更新记录并为删除动作提供确认钩子', () => {
  const html = workFormPage({
    csrfToken: 'csrf-test-token',
    categories: [{ name: '程序', is_visible: 1 }],
    record: {
      id: 7,
      title: '时间线作品',
      work_date: '2026-09-10',
      category: '程序',
      detail_intro: '时间线简介',
      updates: [{ id: 11, recorded_at: '2026-09-10T04:30:00.000Z', body: '# 新进展\n\n正文' }],
    },
  });
  assert.match(html, /2026\.09\.10 12:30 UTC\+8/);
  assert.match(html, /新进展 正文/);
  assert.match(html, /action="\/admin\/works\/7\/updates"/);
  assert.match(html, /name="recordedAt" type="datetime-local"/);
  assert.match(html, /action="\/admin\/works\/7\/updates\/11\/delete" data-work-update-action data-delete-work-update/);
  assert.match(workFormScript(), /确定删除这条更新记录吗/);
});

test('没有分组时作品表单明确提示先创建分组并禁止保存', () => {
  const html = workFormPage({ csrfToken: 'csrf-test-token', categories: [] });
  assert.match(html, /请先创建分组/);
  assert.match(html, /href="\/admin\/categories"/);
  assert.match(html, /<select id="category" name="category" required disabled>/);
  assert.match(html, /data-save-work disabled/);
});

test('作品表单脚本使用原生Canvas、XMLHttpRequest和受CSRF保护的现有上传接口', () => {
  const script = workFormScript();
  assert.doesNotThrow(() => new Function(script), '返回给浏览器的脚本必须可以独立解析。');
  assert.match(script, /getContext\('2d'\)/);
  assert.match(script, /hitResizeHandle/);
  assert.match(script, /box\.height = box\.width \* 9 \/ 16/);
  assert.match(script, /toBlob\(resolve, 'image\/webp'/);
  assert.match(script, /new XMLHttpRequest\(\)/);
  assert.match(script, /request\.open\('POST', uploadApi\)/);
  assert.match(script, /request\.setRequestHeader\('X-CSRF-Token', csrfToken\)/);
  assert.match(script, /request\.upload\.onprogress/);
  assert.match(script, /new FormData\(\)/);
  assert.match(script, /mainFormDirty \|\| hasUnsavedUpload \|\| pendingUploads > 0/);
  assert.match(script, /window\.addEventListener\('beforeunload'/);
  assert.match(script, /form\.addEventListener\('invalid'/);
  assert.match(script, /Array\.from\(detailIntro\.value\)\.length/);
  assert.match(script, /请先点上方“保存并发布”/);
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
