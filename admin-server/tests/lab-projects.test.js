const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
const bcrypt = require('bcrypt');
const speakeasy = require('speakeasy');

const { createApp } = require('../src/app');
const { LabValidationError } = require('../src/services/lab-service');

const CRC_TABLE = Array.from({ length: 256 }, (_unused, number) => {
  let value = number;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name, 'utf8');
    const body = Buffer.isBuffer(item.body) ? item.body : Buffer.from(item.body || '', 'utf8');
    const method = item.deflate ? 8 : 0;
    const compressed = item.deflate ? zlib.deflateRawSync(body, { level: 9 }) : body;
    const checksum = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function validLabZip() {
  return zip([
    { name: 'index.html', body: '<!doctype html><link rel="stylesheet" href="style.css"><h1>本地小作坊验证</h1><img src="pixel.png" alt="像素"><script src="app.js"></script>' },
    { name: 'assets/', body: '' },
    { name: 'assets/readme.txt', body: '显式目录条目后的资源仍应被完整检查和解压。' },
    { name: 'style.css', body: 'body{font-family:sans-serif;background:#d9dde0}' },
    { name: 'app.js', body: 'document.documentElement.dataset.labReady="true";' },
    { name: 'pixel.png', body: Buffer.from('89504e470d0a1a0a', 'hex') },
  ]);
}

async function createRuntime(overrides = {}) {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-lab-'));
  const password = 'lab-test-password';
  const context = createApp({
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 3001,
    sessionSecret: crypto.randomBytes(48).toString('base64url'),
    adminPasswordHash: await bcrypt.hash(password, 4),
    totpEncryptionKey: crypto.randomBytes(32),
    dataDir: path.join(runtimeRoot, 'data'),
    databasePath: path.join(runtimeRoot, 'data', 'test.sqlite3'),
    contentDir: path.join(runtimeRoot, 'content'),
    uploadsDir: path.join(runtimeRoot, 'uploads'),
    labStorageDir: path.join(runtimeRoot, 'lab-storage'),
    labBaseUrl: 'http://localhost:3001/lab',
    siteRoot: path.join(runtimeRoot, 'site'),
    uploadMaxBytes: 1024 * 1024,
    labMaxFiles: overrides.labMaxFiles ?? 20,
    labMaxUncompressedBytes: overrides.labMaxUncompressedBytes ?? 16 * 1024,
  });
  const server = await new Promise((resolve) => {
    const instance = context.app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  return {
    ...context,
    password,
    runtimeRoot,
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async writeUpload(name, contents) {
      const target = path.join(context.config.uploadsDir, name);
      await fs.writeFile(target, contents);
      return { path: target, originalname: name, mimetype: 'application/zip', size: contents.length };
    },
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
    getCookie: () => cookie,
    async request(url, options = {}) {
      const headers = new Headers(options.headers || {});
      if (cookie) headers.set('cookie', cookie);
      const response = await fetch(`${baseUrl}${url}`, { ...options, headers, redirect: 'manual' });
      const values = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean);
      for (const value of values) {
        if (value.startsWith('zhiliaohub.admin.sid=')) cookie = value.split(';', 1)[0];
      }
      return response;
    },
  };
}

function extract(html, pattern, message) {
  const match = html.match(pattern);
  assert.ok(match, message);
  return match[1];
}

async function authenticate(client, runtime) {
  let response = await client.request('/admin/login');
  let html = await response.text();
  let csrf = extract(html, /name="_csrf" value="([^"]+)"/, '登录页应包含CSRF令牌');
  response = await client.request('/admin/login', {
    method: 'POST',
    body: new URLSearchParams({ _csrf: csrf, password: runtime.password }),
  });
  assert.equal(response.status, 302);
  response = await client.request('/admin/totp/setup');
  html = await response.text();
  csrf = extract(html, /name="_csrf" value="([^"]+)"/, 'TOTP页应包含CSRF令牌');
  const secret = extract(html, /<code data-totp-secret>([A-Z2-7]+)<\/code>/, 'TOTP页应显示绑定密钥');
  response = await client.request('/admin/totp/setup', {
    method: 'POST',
    body: new URLSearchParams({ _csrf: csrf, token: speakeasy.totp({ secret, encoding: 'base32' }) }),
  });
  assert.equal(response.status, 302);
  response = await client.request('/admin/lab');
  assert.equal(response.status, 200);
  return extract(await response.text(), /name="_csrf" value="([^"]+)"/, '小作坊页面应包含CSRF令牌');
}

test('有效网页ZIP可解压、发布显隐、生成链接并在删除时清理记录和目录', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());
  const file = await runtime.writeUpload('design.zip', validLabZip());
  const project = await runtime.labService.createProject(file, {
    title: '安全网页实验',
    description: '包含HTML、CSS、JS和图片。',
    isVisible: true,
  });
  assert.match(project.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.equal(project.accessUrl, `http://localhost:3001/lab/${project.slug}/`);
  assert.match(await fs.readFile(path.join(runtime.config.labStorageDir, project.slug, 'index.html'), 'utf8'), /本地小作坊验证/);
  assert.match(await fs.readFile(path.join(runtime.config.labStorageDir, project.slug, 'assets', 'readme.txt'), 'utf8'), /完整检查和解压/);
  await runtime.publishService.publishAll();
  let works = await fs.readFile(path.join(runtime.config.siteRoot, 'works.html'), 'utf8');
  assert.match(works, /<h2 id="lab-section-title">小作坊<\/h2>/);
  assert.match(works, /安全网页实验/);
  assert.match(works, /target="_blank" rel="noopener noreferrer"/);

  assert.equal(runtime.labService.toggleVisibility(project.id).isVisible, false);
  await runtime.publishService.publishAll();
  works = await fs.readFile(path.join(runtime.config.siteRoot, 'works.html'), 'utf8');
  assert.doesNotMatch(works, /lab-section-title|安全网页实验/);

  runtime.labService.toggleVisibility(project.id);
  await runtime.labService.deleteProject(project.id);
  assert.equal(runtime.database.prepare('SELECT COUNT(*) AS count FROM lab_projects').get().count, 0);
  await assert.rejects(fs.access(path.join(runtime.config.labStorageDir, project.slug)), /ENOENT/);
});

test('ZIP路径穿越、解压炸弹和服务端脚本均在写出文件前被拒绝', async (t) => {
  const runtime = await createRuntime({ labMaxUncompressedBytes: 1024 });
  t.after(() => runtime.close());
  const attempts = [
    {
      name: 'slip.zip',
      body: zip([{ name: 'index.html', body: 'safe' }, { name: '../outside.html', body: 'escaped' }]),
      pattern: /不安全|invalid relative path|越过/,
    },
    {
      name: 'bomb.zip',
      body: zip([{ name: 'index.html', body: Buffer.alloc(4096, 65), deflate: true }]),
      pattern: /解压后总大小超过/,
    },
    {
      name: 'server-script.zip',
      body: zip([{ name: 'index.html', body: 'safe' }, { name: 'shell.php', body: '<?php echo 1;' }]),
      pattern: /不允许的文件类型/,
    },
  ];
  for (const attempt of attempts) {
    const file = await runtime.writeUpload(attempt.name, attempt.body);
    await assert.rejects(
      runtime.labService.createProject(file, { title: attempt.name, description: '恶意测试包' }),
      (error) => error instanceof LabValidationError && attempt.pattern.test(error.message),
    );
  }
  assert.equal(runtime.database.prepare('SELECT COUNT(*) AS count FROM lab_projects').get().count, 0);
  const labEntries = (await fs.readdir(runtime.config.labStorageDir)).filter((name) => !name.startsWith('.'));
  assert.deepEqual(labEntries, []);
  await assert.rejects(fs.access(path.join(runtime.runtimeRoot, 'outside.html')), /ENOENT/);
});

test('小作坊上传接口要求管理员和CSRF，成功后后台可列出项目', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());
  const anonymous = new FormData();
  anonymous.set('title', '匿名上传');
  anonymous.set('description', '不应成功');
  anonymous.set('file', new Blob([validLabZip()], { type: 'application/zip' }), 'anonymous.zip');
  let response = await fetch(`${runtime.baseUrl}/api/admin/lab/upload`, { method: 'POST', body: anonymous });
  assert.equal(response.status, 401);

  const client = createClient(runtime.baseUrl);
  const csrf = await authenticate(client, runtime);
  const invalidCsrf = new FormData();
  invalidCsrf.set('title', '错误令牌');
  invalidCsrf.set('description', '不应成功');
  invalidCsrf.set('file', new Blob([validLabZip()], { type: 'application/zip' }), 'invalid.zip');
  response = await client.request('/api/admin/lab/upload', {
    method: 'POST',
    headers: { 'x-csrf-token': 'invalid' },
    body: invalidCsrf,
  });
  assert.equal(response.status, 403);

  const upload = new FormData();
  upload.set('title', '接口上传项目');
  upload.set('description', '由受保护接口创建。');
  upload.set('isVisible', '1');
  upload.set('file', new Blob([validLabZip()], { type: 'application/zip' }), 'api-design.zip');
  response = await client.request('/api/admin/lab/upload', {
    method: 'POST',
    headers: { 'x-csrf-token': csrf },
    body: upload,
  });
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.project.title, '接口上传项目');
  assert.equal(payload.project.isVisible, true);
  response = await client.request('/admin/lab');
  const html = await response.text();
  assert.match(html, /接口上传项目/);
  assert.match(html, /data-copy-lab-link/);
  assert.equal(runtime.database.prepare('SELECT COUNT(*) AS count FROM lab_projects').get().count, 1);
});

test('/lab静态响应不经过session、不写Set-Cookie，并带限制API连接的CSP', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());
  const project = await runtime.labService.createProject(
    await runtime.writeUpload('headers.zip', validLabZip()),
    { title: '响应头测试', description: '检查隔离前的额外防线。' },
  );
  const response = await fetch(`${runtime.baseUrl}/lab/${project.slug}/`, {
    headers: { cookie: 'zhiliaohub.admin.sid=fake-admin-cookie' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  const csp = response.headers.get('content-security-policy');
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /frame-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(await response.text(), /本地小作坊验证/);

  const missing = await fetch(`${runtime.baseUrl}/lab/not-found/`, {
    headers: { cookie: 'zhiliaohub.admin.sid=fake-admin-cookie' },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('set-cookie'), null);
});
