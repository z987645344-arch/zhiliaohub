const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const speakeasy = require('speakeasy');

const { createApp } = require('../src/app');

async function createRuntime(overrides = {}) {
  const runtimeRoot = overrides.runtimeRoot
    || await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-feedback-'));
  const context = createApp({
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 3001,
    sessionSecret: crypto.randomBytes(48).toString('base64url'),
    adminPasswordHash: await bcrypt.hash('feedback-test-password', 4),
    totpEncryptionKey: crypto.randomBytes(32),
    dataDir: path.join(runtimeRoot, 'data'),
    databasePath: path.join(runtimeRoot, 'data', 'test.sqlite3'),
    contentDir: path.join(runtimeRoot, 'content'),
    uploadsDir: path.join(runtimeRoot, 'uploads'),
    siteRoot: path.join(runtimeRoot, 'site'),
    feedbackRateLimitWindowMs: overrides.feedbackRateLimitWindowMs ?? 60_000,
    feedbackRateLimitMax: overrides.feedbackRateLimitMax ?? 100,
  });
  const server = await new Promise((resolve) => {
    const instance = context.app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  return {
    ...context,
    runtimeRoot,
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      context.sessionStore.close();
      context.database.close();
      await fs.rm(runtimeRoot, { recursive: true, force: true });
    },
  };
}

function createClient(baseUrl) {
  let cookie = '';
  return {
    async request(url, options = {}) {
      const headers = new Headers(options.headers || {});
      if (cookie) headers.set('cookie', cookie);
      const response = await fetch(`${baseUrl}${url}`, { ...options, headers, redirect: 'manual' });
      const setCookies = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean);
      for (const value of setCookies) {
        if (value.startsWith('zhiliaohub.admin.sid=')) cookie = value.split(';', 1)[0];
      }
      return response;
    },
  };
}

function form(values) {
  return new URLSearchParams(values);
}

function extractCsrf(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, '页面应包含CSRF令牌。');
  return match[1];
}

function extractTotpSecret(html) {
  const match = html.match(/<code data-totp-secret>([A-Z2-7]+)<\/code>/);
  assert.ok(match, 'TOTP绑定页应显示手动输入密钥。');
  return match[1];
}

async function authenticate(client, runtime) {
  let response = await client.request('/admin/login');
  let csrf = extractCsrf(await response.text());
  response = await client.request('/admin/login', {
    method: 'POST',
    body: form({ _csrf: csrf, password: 'feedback-test-password' }),
  });
  assert.equal(response.status, 302);
  response = await client.request('/admin/totp/setup');
  const setupHtml = await response.text();
  csrf = extractCsrf(setupHtml);
  const secret = extractTotpSecret(setupHtml);
  response = await client.request('/admin/totp/setup', {
    method: 'POST',
    body: form({ _csrf: csrf, token: speakeasy.totp({ secret, encoding: 'base32' }) }),
  });
  assert.equal(response.status, 302);
  response = await client.request('/admin/feedback?filter=all');
  assert.equal(response.status, 200);
  return extractCsrf(await response.text());
}

async function submit(runtime, values) {
  return fetch(`${runtime.baseUrl}/api/feedback/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(values),
  });
}

function seedComment(database, {
  parentId = null,
  status = 'approved',
  body = '用于测试的留言',
  authorEmail = null,
  isAdminReply = 0,
} = {}) {
  const now = new Date().toISOString();
  const result = database.prepare(`
    INSERT INTO feedback_comments (
      parent_id, author_name, author_email, body, status, created_at, approved_at, ip_address,
      is_admin_reply
    ) VALUES (?, '测试访客', ?, ?, ?, ?, ?, '127.0.0.1', ?)
  `).run(parentId, authorEmail, body, status, now, status === 'approved' ? now : null, isAdminReply);
  return Number(result.lastInsertRowid);
}

test('公开接口将顶层留言和对已批准顶层留言的回复写入pending审核队列', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());

  let response = await submit(runtime, {
    author_name: ' 雨巷访客 ',
    author_email: 'visitor@example.com',
    body: ' 很喜欢这个作品集。 ',
    website: '',
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    accepted: true,
    status: 'pending',
    message: '留言已提交审核。',
  });
  assert.equal(response.headers.get('set-cookie'), null, '公开反馈不应创建管理员session');

  const parent = runtime.database.prepare('SELECT * FROM feedback_comments ORDER BY id DESC LIMIT 1').get();
  assert.equal(parent.parent_id, null);
  assert.equal(parent.author_name, '雨巷访客');
  assert.equal(parent.author_email, 'visitor@example.com');
  assert.equal(parent.body, '很喜欢这个作品集。');
  assert.equal(parent.status, 'pending');
  assert.equal(parent.approved_at, null);
  assert.ok(parent.ip_address);

  const approvedAt = new Date().toISOString();
  runtime.database.prepare(`
    UPDATE feedback_comments SET status = 'approved', approved_at = ? WHERE id = ?
  `).run(approvedAt, parent.id);
  response = await submit(runtime, {
    parent_id: parent.id,
    author_name: '回复者',
    body: '这是一条等待审核的回复。',
  });
  assert.equal(response.status, 202);
  const reply = runtime.database.prepare('SELECT * FROM feedback_comments ORDER BY id DESC LIMIT 1').get();
  assert.equal(reply.parent_id, parent.id);
  assert.equal(reply.status, 'pending');
  assert.equal(reply.approved_at, null);
});

test('蜜罐字段有内容时返回普通成功响应但不写入数据库', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());

  const response = await submit(runtime, {
    author_name: '爬虫',
    body: '看起来像正常留言。',
    website: 'https://spam.example',
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    accepted: true,
    status: 'pending',
    message: '留言已提交审核。',
  });
  assert.equal(runtime.database.prepare('SELECT COUNT(*) count FROM feedback_comments').get().count, 0);
});

test('公开反馈接口按IP限制短时间提交次数', async (t) => {
  const runtime = await createRuntime({ feedbackRateLimitMax: 2 });
  t.after(() => runtime.close());

  const statuses = [];
  for (let index = 0; index < 3; index += 1) {
    const response = await submit(runtime, {
      author_name: `访客${index}`,
      body: `第${index + 1}条限流测试留言。`,
    });
    statuses.push(response.status);
  }
  assert.deepEqual(statuses, [202, 202, 429]);
  assert.equal(runtime.database.prepare('SELECT COUNT(*) count FROM feedback_comments').get().count, 2);
});

test('回复只允许指向已批准的顶层留言', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());

  const pendingId = seedComment(runtime.database, { status: 'pending' });
  const rejectedId = seedComment(runtime.database, { status: 'rejected' });
  const approvedId = seedComment(runtime.database, { status: 'approved' });
  const replyId = seedComment(runtime.database, { parentId: approvedId, status: 'approved' });
  const cases = [
    { parent_id: 999999, expected: /不存在/ },
    { parent_id: pendingId, expected: /已通过审核/ },
    { parent_id: rejectedId, expected: /已通过审核/ },
    { parent_id: replyId, expected: /不允许回复已有回复/ },
  ];

  for (const item of cases) {
    const response = await submit(runtime, {
      parent_id: item.parent_id,
      author_name: '测试访客',
      body: '这条回复不应写入数据库。',
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, item.expected);
  }
  assert.equal(runtime.database.prepare('SELECT COUNT(*) count FROM feedback_comments').get().count, 4);
});

test('公开反馈接口拒绝空值、超长内容和错误邮箱', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());

  const cases = [
    { author_name: '', body: '有效留言内容', expected: /称呼/ },
    { author_name: '名'.repeat(81), body: '有效留言内容', expected: /80/ },
    { author_name: '访客', body: '', expected: /至少/ },
    { author_name: '访客', body: '短', expected: /至少/ },
    { author_name: '访客', body: '文'.repeat(2001), expected: /2000/ },
    { author_name: '访客', author_email: 'invalid-email', body: '有效留言内容', expected: /邮箱格式/ },
  ];

  for (const item of cases) {
    const response = await submit(runtime, item);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, item.expected);
  }
  assert.equal(runtime.database.prepare('SELECT COUNT(*) count FROM feedback_comments').get().count, 0);
});

test('已有数据库启动时自动补齐管理员回复标记字段', async (t) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-feedback-schema-'));
  const dataDir = path.join(runtimeRoot, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  const databasePath = path.join(dataDir, 'test.sqlite3');
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE feedback_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER,
      author_name TEXT NOT NULL,
      author_email TEXT,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      approved_at TEXT,
      ip_address TEXT NOT NULL
    );
  `);
  legacy.close();

  const runtime = await createRuntime({ runtimeRoot });
  t.after(() => runtime.close());
  const column = runtime.database.prepare('PRAGMA table_info(feedback_comments)').all()
    .find((entry) => entry.name === 'is_admin_reply');
  assert.ok(column);
  assert.equal(column.notnull, 1);
  assert.equal(column.dflt_value, '0');
});

test('反馈后台按主题审核、隐藏和回复，且不触发静态发布', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());
  await fs.mkdir(runtime.config.siteRoot, { recursive: true });
  const feedbackPath = path.join(runtime.config.siteRoot, 'feedback.html');
  const originalFeedback = '<!doctype html><title>前台反馈页保持不变</title>';
  await fs.writeFile(feedbackPath, originalFeedback, 'utf8');

  const approvedRoot = seedComment(runtime.database, { status: 'approved', body: '已通过主题上下文' });
  const pendingReply = seedComment(runtime.database, {
    parentId: approvedRoot,
    status: 'pending',
    body: '等待审核的二层回复',
  });
  const pendingRoot = seedComment(runtime.database, { status: 'pending', body: '等待通过的顶层留言' });
  const rejectRoot = seedComment(runtime.database, { status: 'pending', body: '准备拒绝的顶层留言' });
  const approvedOnly = seedComment(runtime.database, { status: 'approved', body: '没有待审内容的主题' });

  const anonymous = await fetch(`${runtime.baseUrl}/admin/feedback`, { redirect: 'manual' });
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.get('location'), '/admin/login');

  const client = createClient(runtime.baseUrl);
  let csrf = await authenticate(client, runtime);
  let response = await client.request('/admin/feedback?filter=pending');
  const pendingHtml = await response.text();
  assert.match(pendingHtml, /等待审核的二层回复/);
  assert.match(pendingHtml, /已通过主题上下文/);
  assert.match(pendingHtml, /等待通过的顶层留言/);
  assert.doesNotMatch(pendingHtml, /没有待审内容的主题/);
  assert.match(pendingHtml, /待审核/);
  assert.match(pendingHtml, /查看提交信息/);

  response = await client.request(`/admin/feedback/${pendingRoot}/approve`, {
    method: 'POST',
    body: form({ _csrf: csrf, filter: 'all' }),
  });
  assert.equal(response.status, 302);
  let record = runtime.database.prepare('SELECT * FROM feedback_comments WHERE id = ?').get(pendingRoot);
  assert.equal(record.status, 'approved');
  assert.ok(record.approved_at);

  response = await client.request(`/admin/feedback/${rejectRoot}/reject`, {
    method: 'POST',
    body: form({ _csrf: csrf, filter: 'all' }),
  });
  assert.equal(response.status, 302);
  record = runtime.database.prepare('SELECT * FROM feedback_comments WHERE id = ?').get(rejectRoot);
  assert.equal(record.status, 'rejected');
  assert.equal(record.approved_at, null);

  response = await client.request(`/admin/feedback/${approvedRoot}/reply`, {
    method: 'POST',
    body: form({ _csrf: csrf, filter: 'all', body: '这是管理员直接发布的回复。' }),
  });
  assert.equal(response.status, 302);
  const adminReply = runtime.database.prepare(`
    SELECT * FROM feedback_comments WHERE parent_id = ? AND is_admin_reply = 1
  `).get(approvedRoot);
  assert.equal(adminReply.author_name, '站长');
  assert.equal(adminReply.status, 'approved');
  assert.ok(adminReply.approved_at);

  response = await client.request(`/admin/feedback/${approvedOnly}/reject`, {
    method: 'POST',
    body: form({ _csrf: csrf, filter: 'all' }),
  });
  assert.equal(response.status, 302);
  record = runtime.database.prepare('SELECT * FROM feedback_comments WHERE id = ?').get(approvedOnly);
  assert.equal(record.status, 'rejected');

  response = await client.request(`/admin/feedback/${pendingReply}/reply`, {
    method: 'POST',
    body: form({ _csrf: csrf, filter: 'all', body: '不应创建的三层回复。' }),
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /不允许回复已有回复/);

  response = await client.request(`/admin/feedback/${pendingReply}/approve`, {
    method: 'POST',
    body: form({ filter: 'all' }),
  });
  assert.equal(response.status, 403);
  record = runtime.database.prepare('SELECT * FROM feedback_comments WHERE id = ?').get(pendingReply);
  assert.equal(record.status, 'pending');

  response = await client.request('/admin/feedback?filter=all');
  const allHtml = await response.text();
  csrf = extractCsrf(allHtml);
  assert.match(allHtml, /管理员回复/);
  assert.match(allHtml, /站长/);
  assert.doesNotMatch(
    allHtml.match(new RegExp(`<article[^>]+data-comment-id="${pendingReply}"[\\s\\S]*?<\\/article>`))?.[0] || '',
    /站长回复<\/label>/,
  );
  assert.equal(csrf.length > 20, true);
  assert.equal(await fs.readFile(feedbackPath, 'utf8'), originalFeedback);
  assert.equal(runtime.database.prepare('SELECT COUNT(*) count FROM publish_state').get().count, 0);
});

test('反馈静态发布在SQL层只读取approved且永不输出邮箱、待审或隐藏内容', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());

  const pendingBody = '安全测试：待审核顶层绝不能提前出现';
  const pendingEmail = 'pending-never-public@example.com';
  const pendingId = seedComment(runtime.database, {
    status: 'pending',
    body: pendingBody,
    authorEmail: pendingEmail,
  });
  const rejectedBody = '安全测试：已拒绝内容源码中也不能出现';
  const rejectedEmail = 'rejected-never-public@example.com';
  seedComment(runtime.database, {
    status: 'rejected',
    body: rejectedBody,
    authorEmail: rejectedEmail,
  });

  await runtime.publishService.publishAll();
  const feedbackPath = path.join(runtime.config.siteRoot, 'feedback.html');
  let html = await fs.readFile(feedbackPath, 'utf8');
  assert.match(html, /还没有留言/);
  assert.doesNotMatch(html, new RegExp(pendingBody));
  assert.doesNotMatch(html, new RegExp(rejectedBody));

  runtime.feedbackService.approveComment(pendingId);
  await runtime.publishService.publishAll();
  html = await fs.readFile(feedbackPath, 'utf8');
  assert.match(html, new RegExp(pendingBody));
  assert.doesNotMatch(html, new RegExp(pendingEmail));

  const pendingReplyBody = '安全测试：回复审核前不可见';
  const pendingReplyEmail = 'reply-never-public@example.com';
  const pendingReplyId = seedComment(runtime.database, {
    parentId: pendingId,
    status: 'pending',
    body: pendingReplyBody,
    authorEmail: pendingReplyEmail,
  });
  await runtime.publishService.publishAll();
  html = await fs.readFile(feedbackPath, 'utf8');
  assert.doesNotMatch(html, new RegExp(pendingReplyBody));

  runtime.feedbackService.approveComment(pendingReplyId);
  runtime.feedbackService.createAdminReply(pendingId, '安全测试：站长公开回复', '127.0.0.1');
  await runtime.publishService.publishAll();
  html = await fs.readFile(feedbackPath, 'utf8');
  assert.match(html, new RegExp(pendingReplyBody));
  assert.match(html, /安全测试：站长公开回复/);
  assert.match(html, /站长回复/);
  assert.equal((html.match(/data-reply-toggle/g) || []).length, 1, '只有顶层留言应提供回复入口');
  assert.equal((html.match(/class="comment-item comment-reply"/g) || []).length, 2);

  for (const forbidden of [pendingEmail, rejectedEmail, pendingReplyEmail, rejectedBody, 'author_email']) {
    assert.doesNotMatch(html, new RegExp(forbidden));
  }
  assert.doesNotMatch(html, /ip_address|127\.0\.0\.1/);

  const publishSource = await fs.readFile(path.resolve(__dirname, '..', 'src', 'services', 'publish-service.js'), 'utf8');
  assert.match(publishSource, /SELECT id, parent_id, author_name, body, created_at, is_admin_reply\s+FROM feedback_comments\s+WHERE status = 'approved'/);
});

test('前台脚本真实提交审核队列、区分错误并限制回复入口', async () => {
  const script = await fs.readFile(path.resolve(__dirname, '..', '..', 'js', 'site.js'), 'utf8');
  assert.match(script, /fetch\(feedbackForm\.action/);
  assert.match(script, /留言已提交，正在等待审核。/);
  assert.match(script, /无法连接留言服务，请检查网络后重试。/);
  assert.match(script, /response\.status === 429/);
  assert.match(script, /payload\.set\("author_email"/);
  assert.match(script, /querySelectorAll\("\[data-reply-toggle\]"\)/);
});
