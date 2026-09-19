const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {
  adminNavigationScript,
  formatDateTime,
  labManagementScript,
  layout,
  workFormScript,
} = require('../src/lib/html');
const { formatCommentTime } = require('../src/templates/feedback');
const { renderNoteDetail, renderNotesList } = require('../src/templates/notes');
const { GENERATED_MARKER } = require('../src/templates/shared');
const { renderWorkDetail, renderWorksList } = require('../src/templates/works');
const { labManagementPage, workFormPage } = require('../src/views');

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

test('作品与小作坊上传脚本显示真实进度并区分JSON与非JSON错误', () => {
  for (const script of [workFormScript(), labManagementScript()]) {
    assert.doesNotThrow(() => new Function(script));
    assert.match(script, /new XMLHttpRequest\(\)/);
    assert.match(script, /upload\.onprogress/);
    assert.match(script, /已上传 .* \/ .* MB · .*%/);
    assert.match(script, /JSON\.parse\(/);
    assert.match(script, /上传失败（HTTP .*）/);
  }
  const labHtml = labManagementPage({ csrfToken: 'csrf-test-token' });
  assert.match(labHtml, /进入网页文件夹，选中全部内容压缩；不要压缩文件夹本身。/);
  assert.match(labHtml, /data-lab-upload-form[^>]*data-upload-api="\/api\/admin\/lab\/upload"/);
  assert.match(labHtml, /data-lab-upload-button>[\s\S]*data-lab-upload-status role="status"/);
});

test('小作坊上传把400/408/413/415的具体失败原因显示在按钮旁', () => {
  function simulate(statusCode, responseText) {
    const messages = [];
    const status = {
      textContent: '',
      classList: { toggle: (_name, active) => { status.isError = active; } },
    };
    const button = { disabled: false };
    const fileInput = { files: [{ name: 'large-lab.zip' }] };
    let submitHandler;
    const form = {
      dataset: { csrfToken: 'csrf-test-token', uploadApi: '/api/admin/lab/upload' },
      querySelector(selector) {
        if (selector === '[data-lab-upload-status]') return status;
        if (selector === '[data-lab-upload-button]') return button;
        if (selector === '#labFile') return fileInput;
        return null;
      },
      addEventListener(name, handler) {
        if (name === 'submit') submitHandler = handler;
      },
    };
    class FakeRequest {
      constructor() {
        this.handlers = {};
        this.headers = {};
        this.status = statusCode;
        this.responseText = responseText;
        this.upload = {};
      }

      open() {}

      setRequestHeader(name, value) { this.headers[name] = value; }

      addEventListener(name, handler) { this.handlers[name] = handler; }

      send() {
        this.upload.onprogress({
          lengthComputable: true,
          loaded: Math.round(32.5 * 1024 * 1024),
          total: Math.round(68.9 * 1024 * 1024),
        });
        messages.push(status.textContent);
        this.handlers.load();
        messages.push(status.textContent);
        this.handlers.loadend();
      }
    }
    vm.runInNewContext(labManagementScript(), {
      document: {
        querySelectorAll: () => [],
        querySelector: () => form,
      },
      encodeURIComponent,
      FormData: class FakeFormData {},
      XMLHttpRequest: FakeRequest,
      window: { location: { assign() {} }, setTimeout() {} },
    });
    submitHandler({ preventDefault() {} });
    return { button, messages, status };
  }

  const cases = [
    [400, JSON.stringify({ error: '标题长度应为 1 至 120 个字符。' }), '标题长度应为 1 至 120 个字符。'],
    [408, '<html>request timeout</html>', '上传失败（HTTP 408）。'],
    [413, JSON.stringify({ error: '文件超过上传大小上限。' }), '文件超过上传大小上限。'],
    [415, JSON.stringify({ error: 'ZIP包含不允许的文件类型：shell.php。' }), 'ZIP包含不允许的文件类型：shell.php。'],
  ];
  for (const [statusCode, body, expected] of cases) {
    const result = simulate(statusCode, body);
    assert.equal(result.messages[0], '已上传 32.5 / 68.9 MB · 47%');
    assert.equal(result.messages.at(-1), expected);
    assert.equal(result.status.isError, true);
    assert.equal(result.button.disabled, false);
  }
});

test('小作坊表单提供16比9封面裁剪并保留流式ZIP下载入口', () => {
  const html = labManagementPage({
    csrfToken: 'csrf-test-token',
    projects: [{
      id: 7,
      title: '封面项目',
      description: '测试封面与下载入口。',
      original_filename: '项目.zip',
      updated_at: '2026-09-15T00:00:00.000Z',
      isVisible: true,
      accessUrl: 'https://example.com/lab/cover-project/',
    }],
  });
  assert.match(html, /id="labCoverFile"/);
  assert.match(html, /data-lab-cover-canvas/);
  assert.match(html, /name="coverImage" data-lab-cover-value/);
  assert.match(html, /href="\/admin\/lab\/7\/download">下载 ZIP<\/a>/);
  const script = labManagementScript();
  assert.match(script, /output\.width = 1280; output\.height = 720/);
  assert.match(script, /assets\/works\/covers\//);
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

test('小作坊只有一个项目时仍与作品分组共用横向轨道和卡片规格', () => {
  const html = renderWorksList([], [], [{
    id: 1,
    slug: 'single-lab',
    title: '单个小作坊',
    description: '验证单项目仍使用统一轨道。',
    accessUrl: '/lab/single-lab/',
    cover_image: null,
  }]);
  const stylesheet = fs.readFileSync(path.resolve(__dirname, '..', '..', 'css', 'style.css'), 'utf8');
  assert.match(html, /class="work-category-head"[\s\S]*?LAB \/ EXPERIMENTS[\s\S]*?<h2 id="lab-section-title">小作坊<\/h2>/);
  assert.match(html, /class="work-slider-track" data-work-track[^>]*aria-label="小作坊项目，可横向滑动"/);
  assert.doesNotMatch(html, /lab-portfolio-grid|lab-portfolio-card/);
  assert.match(stylesheet, /\.works-section,\s*\.lab-section,\s*\.notes-section,/);
});

test('日记前台忽略历史占位标记且详情不再输出死操作', () => {
  const note = {
    slug: 'plain-note',
    title: '正常阅读的日记',
    summary: '历史字段不再改变前台语义。',
    note_date: '2026-09-20',
    is_placeholder: 1,
  };
  const listHtml = renderNotesList([note]);
  const detailHtml = renderNoteDetail(note, '<h2>普通节标题</h2><p>正文。</p>', 0);
  for (const html of [listHtml, detailHtml]) {
    assert.doesNotMatch(html, /placeholder-pill|PLACEHOLDER DIARY|data-unavailable-action|占位内容|正文筹备中/);
  }
  assert.match(detailHtml, /class="version-log work-manual-body note-body"/);
});

test('作品详情与更新记录使用showcase总宽且只约束卡片内部正文行长', () => {
  const html = renderWorkDetail({
    id: 2,
    slug: 'manual-width',
    title: '详情宽度',
    category: '程序',
    detail_intro: '详情区块宽度验证。',
    htmlDetailBody: '<p>正文内容</p>',
  });
  const stylesheet = fs.readFileSync(path.resolve(__dirname, '..', '..', 'css', 'style.css'), 'utf8');
  const workManualRule = stylesheet.match(/\.work-manual\s*\{([^}]*)\}/);
  assert.match(html, /class="detail-content work-manual"/);
  assert.ok(workManualRule, '应保留详情区块的节距规则。');
  assert.doesNotMatch(workManualRule[1], /max-width|margin-inline/);
  assert.match(stylesheet, /\.work-manual-body > \*\s*\{[^}]*max-width:\s*72ch/);
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

test('作品详情简介保留在右栏且不再悬空到媒体下方', () => {
  const html = renderWorkDetail({
    id: 9,
    slug: 'showcase-order',
    title: '详情顺序验证',
    category: '程序',
    detail_intro: '这段简介应保留在右栏。',
  });
  const mediaAt = html.indexOf('class="showcase-left"');
  const infoAt = html.indexOf('class="showcase-right"');
  const introAt = html.indexOf('class="showcase-intro"');
  const updatesAt = html.indexOf('class="detail-content"');
  const infoEndAt = html.indexOf('</div></section>', introAt);
  assert.ok(mediaAt >= 0 && infoAt > mediaAt && introAt > infoAt && infoEndAt > introAt && updatesAt > infoEndAt);
  assert.doesNotMatch(html, /showcase-intro-wide/);
});

test('作品媒体轨道以主媒体为首项且只有主媒体时不渲染轨道', () => {
  const withGallery = renderWorkDetail({
    id: 10,
    slug: 'gallery-stage',
    title: '媒体舞台',
    category: '程序',
    detail_intro: '媒体切换验证。',
    main_media_type: 'video',
    main_media_path: 'assets/works/media/main.webm',
    gallery: JSON.stringify(['assets/works/gallery/one.webp', 'assets/works/gallery/two.mp4']),
  });
  const firstThumb = withGallery.match(/<button class="showcase-thumb[^>]*data-src="([^"]+)"[^>]*aria-current="true"/);
  assert.equal(firstThumb?.[1], 'assets/works/media/main.webm');
  assert.equal((withGallery.match(/<button class="showcase-thumb(?:\s|\")/g) || []).length, 3);
  assert.match(withGallery, /data-showcase-scroll-prev/);
  assert.match(withGallery, /data-showcase-scroll-next/);

  const primaryOnly = renderWorkDetail({
    id: 11,
    slug: 'primary-only',
    title: '只有主图',
    category: '程序',
    detail_intro: '不需要缩略条。',
    main_media_type: 'image',
    main_media_path: 'assets/works/media/main.webp',
  });
  assert.doesNotMatch(primaryOnly, /data-showcase-gallery|data-showcase-thumbs|showcase-gallery-arrow/);
});

test('作品媒体舞台脚本切换前暂停视频并维护按钮、键盘与拖拽交互', () => {
  const script = fs.readFileSync(path.resolve(__dirname, '..', '..', 'js', 'site.js'), 'utf8');
  assert.match(script, /stage\.querySelector\("video"\)\?\.pause\(\)/);
  assert.match(script, /setAttribute\("aria-current", String\(active\)\)/);
  assert.match(script, /\["ArrowLeft", "ArrowRight"\]/);
  assert.match(script, /data-showcase-scroll-prev/);
  assert.match(script, /previous\.disabled = atStart/);
  assert.match(script, /strip\.setPointerCapture/);
});

test('作品媒体缩略图普通鼠标点击不捕获指针并能切换舞台', () => {
  const script = fs.readFileSync(path.resolve(__dirname, '..', '..', 'js', 'site.js'), 'utf8');
  const classList = () => {
    const values = new Set();
    return {
      add: (...names) => names.forEach((name) => values.add(name)),
      remove: (...names) => names.forEach((name) => values.delete(name)),
      toggle: (name, force) => (force ? values.add(name) : values.delete(name)),
      contains: (name) => values.has(name),
    };
  };
  const eventTarget = (extra = {}) => ({
    ...extra,
    listeners: new Map(),
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    },
  });
  const dispatch = (target, type, event = {}) => {
    for (const listener of target.listeners.get(type) || []) listener(event);
  };
  const makeThumb = (source, label) => eventTarget({
    dataset: { src: source, type: 'image' },
    classList: classList(),
    attributes: new Map([['aria-current', 'false'], ['aria-label', label]]),
    getAttribute(name) { return this.attributes.get(name) || null; },
    setAttribute(name, value) { this.attributes.set(name, value); },
    scrollIntoView() {},
    focus() {},
  });
  const first = makeThumb('assets/works/main.webp', '查看主图');
  const second = makeThumb('assets/works/next.webp', '查看辅图');
  first.setAttribute('aria-current', 'true');
  const stage = {
    child: null,
    querySelector: () => null,
    replaceChildren(child) { this.child = child; },
  };
  let captureCount = 0;
  const strip = eventTarget({
    classList: classList(),
    scrollLeft: 0,
    scrollWidth: 320,
    clientWidth: 160,
    querySelectorAll: () => [first, second],
    closest(selector) {
      if (selector === '[data-showcase-gallery]') return { querySelector: () => null };
      if (selector === '.showcase-left') return { querySelector: () => stage };
      return null;
    },
    setPointerCapture() { captureCount += 1; },
    hasPointerCapture: () => false,
    releasePointerCapture() {},
    scrollBy() {},
  });
  const document = {
    documentElement: { classList: classList() },
    querySelector: () => null,
    querySelectorAll(selector) {
      return selector === '[data-showcase-thumbs]' ? [strip] : [];
    },
    addEventListener() {},
    createElement: (tagName) => ({
      tagName,
      className: '',
      src: '',
      setAttribute(name, value) { this[name] = value; },
    }),
  };
  const window = {
    addEventListener() {},
    matchMedia: () => ({ addEventListener() {} }),
    requestAnimationFrame: (callback) => callback(),
    setTimeout: (callback) => callback(),
  };
  vm.runInNewContext(script, { document, window, FormData, URLSearchParams, fetch: async () => ({}) });

  const pointerEvent = { pointerType: 'mouse', button: 0, pointerId: 7, clientX: 24, preventDefault() {} };
  dispatch(strip, 'pointerdown', pointerEvent);
  dispatch(strip, 'pointerup', pointerEvent);
  dispatch(second, 'click', { preventDefault() {}, stopPropagation() {} });

  assert.equal(captureCount, 0);
  assert.equal(stage.child.src, 'assets/works/next.webp');
  assert.equal(first.getAttribute('aria-current'), 'false');
  assert.equal(second.getAttribute('aria-current'), 'true');
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
