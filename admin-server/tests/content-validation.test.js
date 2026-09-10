const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ContentService,
  ContentValidationError,
  categoryRecord,
  safeParseGallery,
  validateCategory,
  validateCategorySlug,
  validateGallery,
} = require('../src/services/content-service');

test('作品分类必须引用数据库中的现有分组', () => {
  const database = {
    prepare() {
      return { get: (name) => (name === '自定义分组' ? { found: 1 } : undefined) };
    },
  };
  assert.equal(validateCategory(' 自定义分组 ', database), '自定义分组');
  assert.throws(() => validateCategory('程序', database), /所选作品分组不存在/);
  assert.throws(() => validateCategory('', database), /作品分组不能为空/);
});

test('分组URL标识严格限制为小写字母、数字和单个连字符', () => {
  assert.equal(validateCategorySlug('custom-tools'), 'custom-tools');
  for (const invalid of ['中文', 'Uppercase', 'tail-', '-head', 'two--dashes']) {
    assert.throws(() => validateCategorySlug(invalid), ContentValidationError);
  }
  const record = categoryRecord({
    name: '自定义', slug: 'custom', kicker: 'CUSTOM', intro: '导语', emptyText: '暂无作品',
  });
  assert.equal(record.isVisible, 1);
  assert.equal(record.displayOrder, 0);
});

test('辅图列表校验会规范化合法路径并拒绝损坏结构', () => {
  assert.equal(validateGallery(''), null);
  assert.equal(
    validateGallery('[" uploads/one.webp ","uploads/two.mp4"]'),
    '["uploads/one.webp","uploads/two.mp4"]',
  );
  assert.throws(() => validateGallery('{"path":"one.webp"}'), /必须为数组/);
  assert.throws(() => validateGallery('["one.webp",""]'), /非空路径/);
  assert.throws(() => validateGallery('not-json'), /格式无效/);
});

test('safeParseGallery 对旧数据或损坏JSON安全回退为空数组', () => {
  assert.deepEqual(safeParseGallery('[" one.webp ","two.mp4"]'), ['one.webp', 'two.mp4']);
  assert.deepEqual(safeParseGallery('not-json'), []);
  assert.deepEqual(safeParseGallery('{"path":"one.webp"}'), []);
  assert.deepEqual(safeParseGallery('["one.webp",null]'), []);
});

test('createWork 将详情页简介作为必填字段', async () => {
  const service = new ContentService(null, { contentMaxBytes: 1024 });
  await assert.rejects(
    service.createWork({
      title: '缺少简介的作品',
      workDate: '2026-08-08',
      category: '程序',
      summary: '仍保留的旧摘要字段',
      detailIntro: '   ',
      body: '正文',
    }),
    /详情页简介不能为空/,
  );
});

test('勾选智能工具展示时必须同时提供有效体验链接', async () => {
  const service = new ContentService(null, { contentMaxBytes: 1024 });
  await assert.rejects(
    service.createWork({
      title: '缺少体验入口的工具',
      workDate: '2026-09-10',
      category: '程序',
      detailIntro: '不能生成无效入口。',
      showOnTools: 1,
      body: '正文',
    }),
    /必须填写体验链接/,
  );
});
