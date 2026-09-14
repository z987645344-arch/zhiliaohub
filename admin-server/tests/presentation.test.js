const assert = require('node:assert/strict');
const test = require('node:test');
const {
  adminNavigationScript,
  formatDateTime,
  layout,
  workFormScript,
} = require('../src/lib/html');
const { formatCommentTime } = require('../src/templates/feedback');
const { renderNotesList } = require('../src/templates/notes');
const { GENERATED_MARKER } = require('../src/templates/shared');

test('展示时间固定为UTC+8，正确处理跨日、带偏移与SQLite时间', () => {
  assert.equal(formatDateTime('2026-09-11T18:20:00Z'), '2026.09.12 02:20 UTC+8');
  assert.equal(formatDateTime('2026-09-12T02:20:00+08:00'), '2026.09.12 02:20 UTC+8');
  assert.equal(formatDateTime('2026-09-11 18:20:00'), '2026.09.12 02:20 UTC+8');
  assert.equal(formatCommentTime('2026-09-11T18:20:00Z'), '2026.09.12 02:20 UTC+8');
  assert.equal(formatDateTime(''), '');
  assert.equal(formatDateTime('invalid'), 'invalid');
});

test('心得空列表仍保留发布标记、主标题与可用的下一步入口', () => {
  const html = renderNotesList([]);
  assert.ok(html.startsWith(GENERATED_MARKER));
  assert.match(html, /笔记还在积累中/);
  assert.match(html, /目前还没有公开的文章/);
  assert.match(html, /href="works.html">浏览作品/);
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.doesNotMatch(html, /<article class="diary-card">/);
});

test('作品文件上传成功后明确提示仍需保存作品', () => {
  const script = workFormScript();
  assert.match(script, /已上传 .*保存作品后才会生效/);
});

test('后台移动导航吸顶折叠且退出登录表单仍保留在菜单内', () => {
  const html = layout({ title: '测试', content: '<section id="target">内容</section>', authenticated: true, csrfToken: 'csrf-test' });
  assert.match(html, /body > header \{ position: sticky; top: 0; z-index: 20;/);
  assert.match(html, /backdrop-filter: blur\(18px\)/);
  assert.match(html, /class="nav-toggle" aria-expanded="false" aria-controls="admin-navigation"/);
  assert.match(html, /<nav id="admin-navigation" class="admin-nav"[^>]*>[\s\S]*<form method="post" action="\/admin\/logout">[\s\S]*name="_csrf" value="csrf-test"[\s\S]*<\/form><\/nav>/);
  assert.match(html, /<script src="\/admin\/navigation\.js" defer><\/script>/);
  assert.match(html, /\.form-section, :target, input:invalid, textarea:invalid, select:invalid \{ scroll-margin-top: 112px; \}/);
});

test('后台导航脚本维护折叠状态且可独立解析', () => {
  const script = adminNavigationScript();
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /setAttribute\('aria-expanded', String\(willOpen\)\)/);
  assert.match(script, /classList\.toggle\('is-open', willOpen\)/);
  assert.match(script, /event\.key === 'Escape'/);
});
