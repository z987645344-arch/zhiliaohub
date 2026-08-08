const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ALLOWED_CATEGORIES,
  ContentService,
  ContentValidationError,
  safeParseGallery,
  validateCategory,
  validateGallery,
} = require('../src/services/content-service');

test('作品分类只接受程序、影视、生活', () => {
  assert.deepEqual(ALLOWED_CATEGORIES, ['程序', '影视', '生活']);
  assert.equal(validateCategory(' 影视 '), '影视');
  assert.throws(() => validateCategory('软件'), ContentValidationError);
  assert.throws(() => validateCategory(''), /分类必须为/);
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
