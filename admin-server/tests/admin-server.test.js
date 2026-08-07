// Covers authentication, security boundaries, content consistency, atomic writes and uploads.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const bcrypt = require('bcrypt');
const speakeasy = require('speakeasy');

const { createApp } = require('../src/app');
const { atomicWriteFile } = require('../src/lib/atomic-file');
const { encryptTotpSecret, decryptTotpSecret } = require('../src/lib/totp-secret');

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

async function createRuntime(overrides = {}) {
  const runtimeRoot = overrides.runtimeRoot
    || await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-admin-'));
  const password = overrides.password || 'local-test-password';
  const sessionSecret = overrides.sessionSecret || crypto.randomBytes(48).toString('base64url');
  const adminPasswordHash = overrides.adminPasswordHash || await bcrypt.hash(password, 4);
  const totpEncryptionKey = overrides.totpEncryptionKey || crypto.randomBytes(32);
  const context = createApp({
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 3001,
    sessionSecret,
    adminPasswordHash,
    totpEncryptionKey,
    dataDir: path.join(runtimeRoot, 'data'),
    databasePath: path.join(runtimeRoot, 'data', 'test.sqlite3'),
    contentDir: path.join(runtimeRoot, 'content'),
    uploadsDir: path.join(runtimeRoot, 'uploads'),
    siteRoot: path.join(runtimeRoot, 'site'),
    uploadMaxBytes: 1024,
    contentMaxBytes: 64 * 1024,
    authRateLimitWindowMs: 60 * 1000,
    authRateLimitMax: overrides.authRateLimitMax ?? 20,
    sessionMaxAgeMs: overrides.sessionMaxAgeMs,
    sessionCleanupIntervalMs: overrides.sessionCleanupIntervalMs,
    pairingCodeTtlMs: overrides.pairingCodeTtlMs,
    deviceChallengeTtlMs: overrides.deviceChallengeTtlMs,
    deviceAuthRateLimitWindowMs: overrides.deviceAuthRateLimitWindowMs,
    deviceAuthRateLimitMax: overrides.deviceAuthRateLimitMax,
  });

  const server = await new Promise((resolve) => {
    const instance = context.app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const address = server.address();

  return {
    ...context,
    password,
    runtimeRoot,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close({ removeFiles = true } = {}) {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      context.sessionStore.close();
      context.database.close();
      if (removeFiles) await fs.rm(runtimeRoot, { recursive: true, force: true });
    },
  };
}

function createClient(baseUrl) {
  let cookie = '';

  return {
    getCookie: () => cookie,
    setCookie: (value) => { cookie = value; },
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
  assert.ok(match, '页面应包含 CSRF 令牌。');
  return match[1];
}

function extractTotpSecret(html) {
  const match = html.match(/<code data-totp-secret>([A-Z2-7]+)<\/code>/);
  assert.ok(match, 'TOTP 绑定页应显示手动输入密钥。');
  return match[1];
}

async function passwordLogin(client, runtime, password = runtime.password) {
  let response = await client.request('/admin/login');
  const csrf = extractCsrf(await response.text());
  response = await client.request('/admin/login', {
    method: 'POST',
    body: form({ _csrf: csrf, password }),
  });
  return response;
}

async function bindAndAuthenticate(client, runtime) {
  let response = await passwordLogin(client, runtime);
  assert.equal(response.status, 302, '正确密码应通过密码步骤。');
  assert.equal(response.headers.get('location'), '/admin/totp/setup');

  response = await client.request('/admin/totp/setup');
  const setupHtml = await response.text();
  const csrf = extractCsrf(setupHtml);
  const secret = extractTotpSecret(setupHtml);
  response = await client.request('/admin/totp/setup', {
    method: 'POST',
    body: form({ _csrf: csrf, token: speakeasy.totp({ secret, encoding: 'base32' }) }),
  });
  assert.equal(response.status, 302, '正确的首次 TOTP 应完成绑定。');

  response = await client.request('/admin');
  assert.equal(response.status, 200, '绑定完成后应进入管理面板。');
  return { secret, csrf: extractCsrf(await response.text()) };
}

async function logout(client, csrf) {
  const response = await client.request('/admin/logout', {
    method: 'POST',
    body: form({ _csrf: csrf }),
  });
  assert.equal(response.status, 302, '退出登录应重定向到登录页。');
}

function workInput(suffix = '') {
  return {
    title: `本地验证作品${suffix}`,
    workDate: '2026-08-04',
    category: '测试分类',
    summary: `作品摘要${suffix}`,
    body: `# 本地验证作品${suffix}\n\n作品正文${suffix}`,
  };
}

function noteInput(suffix = '') {
  return {
    title: `本地验证日记${suffix}`,
    noteDate: '2026-08-04',
    summary: `日记摘要${suffix}`,
    body: `# 本地验证日记${suffix}\n\n日记正文${suffix}`,
  };
}

test('未登录访问管理页面会重定向，访问管理 API 会返回 401', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());
  const client = createClient(runtime.baseUrl);

  const pageResponse = await client.request('/admin');
  assert.equal(pageResponse.status, 302);
  assert.equal(pageResponse.headers.get('location'), '/admin/login');

  const apiResponse = await client.request('/api/admin/works');
  assert.equal(apiResponse.status, 401);
  assert.match((await apiResponse.json()).error, /需要管理员登录/);
});

test('密码错误会被明确拒绝，正确密码会进入首次 TOTP 绑定', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());
  const client = createClient(runtime.baseUrl);

  let response = await passwordLogin(client, runtime, 'wrong-password');
  assert.equal(response.status, 401);
  assert.match(await response.text(), /密码不正确/);

  response = await passwordLogin(client, runtime);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/admin/totp/setup');
});

test('首次 TOTP 绑定会显示二维码，拒绝错误动态码并接受正确动态码', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());
  const client = createClient(runtime.baseUrl);

  await passwordLogin(client, runtime);
  let response = await client.request('/admin/totp/setup');
  const html = await response.text();
  assert.match(html, /data:image\/png;base64,/, '绑定页应内嵌二维码。');
  const csrf = extractCsrf(html);
  const secret = extractTotpSecret(html);

  response = await client.request('/admin/totp/setup', {
    method: 'POST',
    body: form({ _csrf: csrf, token: 'abcdef' }),
  });
  assert.equal(response.status, 401);
  assert.match(await response.text(), /动态验证码不正确或已经过期/);

  response = await client.request('/admin/totp/setup', {
    method: 'POST',
    body: form({ _csrf: csrf, token: speakeasy.totp({ secret, encoding: 'base32' }) }),
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/admin');
});

test('已绑定 TOTP 会拒绝错误码和验证码重放，并接受新的有效码', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());
  const client = createClient(runtime.baseUrl);
  const bound = await bindAndAuthenticate(client, runtime);
  await logout(client, bound.csrf);

  let response = await passwordLogin(client, runtime);
  assert.equal(response.headers.get('location'), '/admin/totp/verify');
  response = await client.request('/admin/totp/verify');
  let csrf = extractCsrf(await response.text());
  response = await client.request('/admin/totp/verify', {
    method: 'POST',
    body: form({ _csrf: csrf, token: '123abc' }),
  });
  assert.equal(response.status, 401, '格式错误的动态码应被拒绝。');

  const freshToken = speakeasy.totp({
    secret: bound.secret,
    encoding: 'base32',
    time: Math.floor(Date.now() / 1000) + 30,
  });
  response = await client.request('/admin/totp/verify', {
    method: 'POST',
    body: form({ _csrf: csrf, token: freshToken }),
  });
  assert.equal(response.status, 302, '新的有效动态码应通过。');

  response = await client.request('/admin');
  await logout(client, extractCsrf(await response.text()));
  await passwordLogin(client, runtime);
  response = await client.request('/admin/totp/verify');
  csrf = extractCsrf(await response.text());
  response = await client.request('/admin/totp/verify', {
    method: 'POST',
    body: form({ _csrf: csrf, token: freshToken }),
  });
  assert.equal(response.status, 401, '已经使用的动态码不得重放。');
  assert.match(await response.text(), /已使用/);
});

test('被篡改的 session cookie 不会保留管理员身份', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());
  const client = createClient(runtime.baseUrl);
  await bindAndAuthenticate(client, runtime);

  const cookie = client.getCookie();
  assert.match(cookie, /^zhiliaohub\.admin\.sid=/);
  const last = cookie.at(-1);
  client.setCookie(`${cookie.slice(0, -1)}${last === 'a' ? 'b' : 'a'}`);

  const apiResponse = await client.request('/api/admin/works');
  assert.equal(apiResponse.status, 401);
  const pageResponse = await client.request('/admin');
  assert.equal(pageResponse.status, 302);
  assert.equal(pageResponse.headers.get('location'), '/admin/login');
});

test('未过期的 SQLite session 在服务重启后仍保持管理员登录状态', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-session-restart-'));
  const shared = {
    runtimeRoot,
    sessionSecret: crypto.randomBytes(48).toString('base64url'),
    adminPasswordHash: await bcrypt.hash('local-test-password', 4),
    totpEncryptionKey: crypto.randomBytes(32),
  };
  let firstRuntime;
  let secondRuntime;
  try {
    firstRuntime = await createRuntime(shared);
    const firstClient = createClient(firstRuntime.baseUrl);
    await bindAndAuthenticate(firstClient, firstRuntime);
    const persistedCookie = firstClient.getCookie();
    assert.equal(firstRuntime.database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1);
    await firstRuntime.close({ removeFiles: false });
    firstRuntime = null;

    secondRuntime = await createRuntime(shared);
    const secondClient = createClient(secondRuntime.baseUrl);
    secondClient.setCookie(persistedCookie);
    const response = await secondClient.request('/api/admin/works');
    assert.equal(response.status, 200, '服务重启后未过期的登录会话应继续有效。');
  } finally {
    if (firstRuntime) await firstRuntime.close({ removeFiles: false });
    if (secondRuntime) await secondRuntime.close({ removeFiles: false });
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('SQLite session 到期后会失效并从存储中清理', async (t) => {
  const runtime = await createRuntime({
    sessionMaxAgeMs: 300,
    sessionCleanupIntervalMs: 60 * 1000,
  });
  t.after(() => runtime.close());
  const client = createClient(runtime.baseUrl);
  await bindAndAuthenticate(client, runtime);
  assert.equal(runtime.database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1);

  await new Promise((resolve) => setTimeout(resolve, 450));
  const response = await client.request('/api/admin/works');
  assert.equal(response.status, 401, '超过有效期的 session 不得继续访问管理 API。');
  const remainingSessions = runtime.database.prepare('SELECT data FROM sessions').all();
  assert.ok(
    remainingSessions.every((row) => !JSON.parse(row.data).adminAuthenticated),
    '过期的管理员身份不得残留在持久化存储中。',
  );
});

test('已登录写接口会拒绝缺失或错误的 CSRF 令牌', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());
  const client = createClient(runtime.baseUrl);
  await bindAndAuthenticate(client, runtime);

  let response = await client.request('/api/admin/works', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(workInput()),
  });
  assert.equal(response.status, 403, '缺失 CSRF 令牌应返回 403。');

  response = await client.request('/api/admin/works', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': 'tampered-token' },
    body: JSON.stringify(workInput()),
  });
  assert.equal(response.status, 403, '错误 CSRF 令牌应返回 403。');
  assert.equal(runtime.database.prepare('SELECT COUNT(*) AS count FROM works').get().count, 0);
});

test('作品和日记的新增、编辑、删除会同步SQLite、Markdown与静态前台', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());
  const client = createClient(runtime.baseUrl);
  const { csrf } = await bindAndAuthenticate(client, runtime);

  let response = await client.request('/api/admin/works', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify(workInput('A')),
  });
  assert.equal(response.status, 201);
  const work = await response.json();
  assert.equal(runtime.database.prepare('SELECT title FROM works WHERE id = ?').get(work.id).title, '本地验证作品A');
  const workPath = path.join(runtime.config.contentDir, ...work.markdown_path.split('/'));
  const workHtmlPath = path.join(runtime.config.siteRoot, `works-${work.slug}.html`);
  assert.match(await fs.readFile(workPath, 'utf8'), /作品正文A/);
  assert.match(await fs.readFile(path.join(runtime.config.siteRoot, 'works.html'), 'utf8'), /本地验证作品A/);
  assert.match(await fs.readFile(workHtmlPath, 'utf8'), /^<!-- 此文件由知了hub后台自动生成/);

  response = await client.request(`/api/admin/works/${work.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify(workInput('B')),
  });
  assert.equal(response.status, 200);
  assert.equal(runtime.database.prepare('SELECT title FROM works WHERE id = ?').get(work.id).title, '本地验证作品B');
  assert.match(await fs.readFile(workPath, 'utf8'), /作品正文B/);
  assert.match(await fs.readFile(workHtmlPath, 'utf8'), /本地验证作品B/);

  response = await client.request('/api/admin/notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify(noteInput('A')),
  });
  assert.equal(response.status, 201);
  const note = await response.json();
  assert.equal(runtime.database.prepare('SELECT title FROM notes WHERE id = ?').get(note.id).title, '本地验证日记A');
  const notePath = path.join(runtime.config.contentDir, ...note.markdown_path.split('/'));
  const noteHtmlPath = path.join(runtime.config.siteRoot, `notes-${note.slug}.html`);
  assert.match(await fs.readFile(notePath, 'utf8'), /日记正文A/);
  assert.match(await fs.readFile(path.join(runtime.config.siteRoot, 'notes.html'), 'utf8'), /本地验证日记A/);
  assert.match(await fs.readFile(noteHtmlPath, 'utf8'), /<h1 id="note-title">本地验证日记A<\/h1>/);

  response = await client.request(`/api/admin/notes/${note.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify(noteInput('B')),
  });
  assert.equal(response.status, 200);
  assert.equal(runtime.database.prepare('SELECT title FROM notes WHERE id = ?').get(note.id).title, '本地验证日记B');
  assert.match(await fs.readFile(notePath, 'utf8'), /日记正文B/);
  assert.match(await fs.readFile(noteHtmlPath, 'utf8'), /本地验证日记B/);

  response = await client.request(`/api/admin/works/${work.id}`, {
    method: 'DELETE',
    headers: { 'x-csrf-token': csrf },
  });
  assert.equal(response.status, 200);
  assert.doesNotMatch(await fs.readFile(path.join(runtime.config.siteRoot, 'works.html'), 'utf8'), /本地验证作品B/);
  await assert.rejects(fs.access(workHtmlPath), /ENOENT/);
  await assert.rejects(fs.access(workPath), /ENOENT/);

  response = await client.request(`/api/admin/notes/${note.id}`, {
    method: 'DELETE',
    headers: { 'x-csrf-token': csrf },
  });
  assert.equal(response.status, 200);
  assert.doesNotMatch(await fs.readFile(path.join(runtime.config.siteRoot, 'notes.html'), 'utf8'), /本地验证日记B/);
  await assert.rejects(fs.access(noteHtmlPath), /ENOENT/);
  await assert.rejects(fs.access(notePath), /ENOENT/);
});

test('同一作品或日记的并发更新会保持数据库与 Markdown 属于同一次写入', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());

  await t.test('作品并发更新', async () => {
    const created = await runtime.contentService.createWork(workInput('初始'));
    await Promise.all([
      runtime.contentService.updateWork(created.id, workInput('并发甲')),
      runtime.contentService.updateWork(created.id, workInput('并发乙')),
    ]);
    const final = await runtime.contentService.getWork(created.id);
    const suffix = final.title.endsWith('并发甲') ? '并发甲' : '并发乙';
    assert.equal(final.summary, `作品摘要${suffix}`);
    assert.match(final.body, new RegExp(`作品正文${suffix}`));
  });

  await t.test('日记并发更新', async () => {
    const created = await runtime.contentService.createNote(noteInput('初始'));
    await Promise.all([
      runtime.contentService.updateNote(created.id, noteInput('并发甲')),
      runtime.contentService.updateNote(created.id, noteInput('并发乙')),
    ]);
    const final = await runtime.contentService.getNote(created.id);
    const suffix = final.title.endsWith('并发甲') ? '并发甲' : '并发乙';
    assert.equal(final.summary, `日记摘要${suffix}`);
    assert.match(final.body, new RegExp(`日记正文${suffix}`));
  });
});

test('原子写入在替换前中断时会保留旧文件并清理临时文件', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-atomic-'));
  const target = path.join(runtimeRoot, 'content.md');
  try {
    await fs.writeFile(target, '完整旧内容\n', 'utf8');
    await assert.rejects(
      atomicWriteFile(target, '不应替换目标的内容\n', {
        beforeRename: async () => { throw new Error('simulated interruption'); },
      }),
      /simulated interruption/,
    );
    assert.equal(await fs.readFile(target, 'utf8'), '完整旧内容\n');
    assert.deepEqual((await fs.readdir(runtimeRoot)).filter((name) => name.includes('.tmp-')), []);
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('TOTP 密钥可正确加解密，密文或认证标签被篡改时会拒绝解密', () => {
  const key = crypto.randomBytes(32);
  const secret = 'JBSWY3DPEHPK3PXP';
  const encrypted = encryptTotpSecret(secret, key);
  const record = {
    totp_ciphertext: encrypted.ciphertext,
    totp_iv: encrypted.iv,
    totp_auth_tag: encrypted.authTag,
  };

  assert.equal(decryptTotpSecret(record, key), secret);
  assert.doesNotMatch(encrypted.ciphertext, new RegExp(secret));

  const tamperedCiphertext = Buffer.from(encrypted.ciphertext, 'base64');
  tamperedCiphertext[0] ^= 0xff;
  assert.throws(() => decryptTotpSecret({
    ...record,
    totp_ciphertext: tamperedCiphertext.toString('base64'),
  }, key));

  const tamperedTag = Buffer.from(encrypted.authTag, 'base64');
  tamperedTag[0] ^= 0xff;
  assert.throws(() => decryptTotpSecret({
    ...record,
    totp_auth_tag: tamperedTag.toString('base64'),
  }, key));
});

test('上传策略接受真实 PNG，并分别拒绝非白名单、内容伪装和超限文件', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());
  const client = createClient(runtime.baseUrl);
  const { csrf } = await bindAndAuthenticate(client, runtime);

  async function upload(buffer, type, name) {
    const body = new FormData();
    body.append('file', new Blob([buffer], { type }), name);
    return client.request('/api/admin/uploads', {
      method: 'POST',
      headers: { 'x-csrf-token': csrf },
      body,
    });
  }

  await t.test('真实 PNG 上传成功', async () => {
    const response = await upload(ONE_PIXEL_PNG, 'image/png', 'cover.png');
    assert.equal(response.status, 201);
    assert.equal((await response.json()).mimeType, 'image/png');
  });

  await t.test('非白名单扩展名被拒绝', async () => {
    const response = await upload(Buffer.from('MZ-not-allowed'), 'application/octet-stream', 'payload.exe');
    assert.equal(response.status, 415);
  });

  await t.test('扩展名和 MIME 合法但签名伪造的文件被拒绝', async () => {
    const response = await upload(Buffer.from('not-a-real-png'), 'image/png', 'spoof.png');
    assert.equal(response.status, 415);
  });

  await t.test('超过大小上限的文件被拒绝', async () => {
    const oversized = Buffer.concat([ONE_PIXEL_PNG.subarray(0, 8), Buffer.alloc(2048)]);
    const response = await upload(oversized, 'image/png', 'too-large.png');
    assert.equal(response.status, 413);
  });

  const stored = (await fs.readdir(runtime.config.uploadsDir)).filter((name) => !name.startsWith('pending-'));
  assert.equal(stored.length, 1, '只有通过全部校验的上传文件可以保留。');
});

test('认证限流按 IP 生效，且不会把唯一管理员账号锁定', async (t) => {
  const runtime = await createRuntime({ authRateLimitMax: 2 });
  t.after(() => runtime.close());
  const client = createClient(runtime.baseUrl);

  let response = await client.request('/admin/login');
  const csrf = extractCsrf(await response.text());
  for (let attempt = 0; attempt < 2; attempt += 1) {
    response = await client.request('/admin/login', {
      method: 'POST',
      body: form({ _csrf: csrf, password: 'wrong-password' }),
    });
    assert.equal(response.status, 401, `第 ${attempt + 1} 次错误密码应正常返回 401。`);
  }

  response = await client.request('/admin/login', {
    method: 'POST',
    body: form({ _csrf: csrf, password: 'wrong-password' }),
  });
  assert.equal(response.status, 429);
  assert.match(await response.text(), /账号本身没有被锁定/);
});
