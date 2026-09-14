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
const { renderWorkDetail, renderWorksList } = require('../src/templates/works');
const { workFormPage } = require('../src/views');

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

test('作品表单四个上传入口各自在操作位置旁提供状态反馈', () => {
  const html = workFormPage({
    csrfToken: 'csrf-test-token',
    categories: [{ name: '程序', is_visible: 1 }],
  });
  for (const [inputId, statusName] of [
    ['coverFile', 'cover'],
    ['mainMediaFile', 'main'],
    ['galleryFiles', 'gallery'],
    ['downloadUpload', 'download'],
  ]) {
    assert.match(
      html,
      new RegExp(`id="${inputId}"[\\s\\S]*?data-upload-local-status="${statusName}" role="status"`),
      `${inputId} 后应有自己的就近状态位。`,
    );
  }
  assert.equal((html.match(/data-upload-local-status=/g) || []).length, 4);
});

test('作品更新记录的添加表单排在历史列表之前', () => {
  const html = workFormPage({
    csrfToken: 'csrf-test-token',
    categories: [{ name: '程序', is_visible: 1 }],
    record: {
      id: 7,
      category: '程序',
      updates: [{ id: 11, recorded_at: '2026-09-10T04:30:00.000Z', body: '一条记录' }],
    },
  });
  const addFormAt = html.indexOf('action="/admin/works/7/updates" data-work-update-action');
  const listAt = html.indexOf('class="work-update-list"');
  assert.ok(addFormAt >= 0, '应渲染添加记录表单。');
  assert.ok(listAt > addFormAt, '添加记录表单应排在历史记录列表之前。');
});

test('作品列表不再输出左右箭头且单卡不携带撑满标记', () => {
  const html = renderWorksList(
    [{ name: '程序', slug: 'program', kicker: 'PROGRAM', intro: '程序作品', empty_text: '暂无作品' }],
    [{ id: 1, slug: 'only-work', title: '唯一作品', category: '程序', detail_intro: '简介' }],
  );
  assert.match(html, /class="work-slider-track" data-work-track/);
  assert.doesNotMatch(html, /work-slider-arrow|data-scroll-prev|data-scroll-next|data-card-count/);
});

test('前后台更新记录超过5条时只折叠其余条目', () => {
  const updates = Array.from({ length: 6 }, (_, index) => ({
    id: index + 1,
    recorded_at: `2026-09-${String(14 - index).padStart(2, '0')}T04:30:00.000Z`,
    body: `记录 ${index + 1}`,
    htmlBody: `<p>记录 ${index + 1}</p>`,
  }));
  const work = {
    id: 7,
    slug: 'timeline-work',
    title: '时间线作品',
    category: '程序',
    detail_intro: '简介',
  };
  const categories = [{ name: '程序', is_visible: 1 }];
  const frontSix = renderWorkDetail(work, updates);
  const adminSix = workFormPage({ csrfToken: 'csrf-test-token', categories, record: { ...work, updates } });
  const frontFive = renderWorkDetail(work, updates.slice(0, 5));
  const adminFive = workFormPage({ csrfToken: 'csrf-test-token', categories, record: { ...work, updates: updates.slice(0, 5) } });

  for (const html of [frontSix, adminSix]) {
    assert.equal((html.match(/<details\b/g) || []).length, 1);
    assert.match(html, /<summary>展开更新详情（还有 1 条）<\/summary>/);
  }
  for (const html of [frontFive, adminFive]) {
    assert.equal((html.match(/<details\b/g) || []).length, 0);
  }
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
