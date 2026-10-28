const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const speakeasy = require('speakeasy');

const { createApp, createLabUploadReceiver } = require('../src/app');
const { loadConfig } = require('../src/config');
const {
  LAB_COVER_MIGRATION_NAME,
  LAB_FILENAME_LATIN1_FIX_MIGRATION_NAME,
  LAB_PROJECT_TYPE_MIGRATION_NAME,
  initializeDatabase,
} = require('../src/db');
const { MAX_SLUG_BYTES } = require('../src/lib/slug');
const {
  LAB_MAX_HTML_DEMO_UNCOMPRESSED_BYTES,
  LAB_MAX_UNITY_UNCOMPRESSED_BYTES,
  LAB_MAX_HTML_DEMO_UPLOAD_BYTES,
  LAB_MAX_UNITY_UPLOAD_BYTES,
  LabService,
  LabValidationError,
  inspectZip,
  labLimits,
} = require('../src/services/lab-service');

const UNCHANGED_MAIN_ADMIN_CSP = "default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';frame-ancestors 'self';img-src 'self' data: blob:;object-src 'none';script-src 'self';script-src-attr 'none';style-src 'self' 'unsafe-inline';upgrade-insecure-requests";
const UNITY_LAB_CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'self'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'";

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

function setZipEntryUncompressedSize(zipBuffer, entryName, size) {
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const wantedName = Buffer.from(entryName, 'utf8');
  let cursor = 0;
  while ((cursor = zipBuffer.indexOf(signature, cursor)) !== -1) {
    const nameLength = zipBuffer.readUInt16LE(cursor + 28);
    const extraLength = zipBuffer.readUInt16LE(cursor + 30);
    const commentLength = zipBuffer.readUInt16LE(cursor + 32);
    const nameStart = cursor + 46;
    const name = zipBuffer.subarray(nameStart, nameStart + nameLength);
    if (name.equals(wantedName)) {
      zipBuffer.writeUInt32LE(size, cursor + 24);
      return zipBuffer;
    }
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP entry not found in central directory: ${entryName}`);
}

function requestRawHttp(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.on('error', reject);
  });
}

async function createRuntime(overrides = {}) {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-lab-'));
  const password = 'lab-test-password';
  const uploadsDir = path.join(runtimeRoot, 'uploads');
  let interruptedLabUploadPath = '';
  if (overrides.seedInterruptedLabUpload) {
    await fs.mkdir(uploadsDir, { recursive: true });
    interruptedLabUploadPath = path.join(uploadsDir, `pending-lab-${crypto.randomUUID()}.zip`);
    await fs.writeFile(interruptedLabUploadPath, validLabZip());
  }
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
    uploadsDir,
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
    interruptedLabUploadPath,
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

test('生产环境LAB_BASE_URL指向localhost时发出醒目警告但不阻止启动', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(String(message)));
  const config = loadConfig({
    nodeEnv: 'production',
    sessionSecret: crypto.randomBytes(48).toString('base64url'),
    adminPasswordHash: await bcrypt.hash('warning-test-password', 4),
    totpEncryptionKey: crypto.randomBytes(32),
    labBaseUrl: 'http://localhost:3001/lab',
  });
  assert.equal(config.labBaseUrl, 'http://localhost:3001/lab');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /生产环境.*LAB_BASE_URL.*localhost/);
});

test('小作坊按项目类型固定上传与解压上限，旧配置只收紧HTML和Demo', () => {
  const mib = 1024 * 1024;
  assert.equal(LAB_MAX_HTML_DEMO_UPLOAD_BYTES, 100 * mib);
  assert.equal(LAB_MAX_UNITY_UPLOAD_BYTES, 280 * mib);
  assert.equal(LAB_MAX_HTML_DEMO_UNCOMPRESSED_BYTES, 100 * mib);
  assert.equal(LAB_MAX_UNITY_UNCOMPRESSED_BYTES, 300 * mib);
  const lowerLegacyConfig = { labMaxFiles: 500, labMaxUncompressedBytes: 64 * mib };
  const higherLegacyConfig = { labMaxFiles: 500, labMaxUncompressedBytes: 500 * mib };
  assert.deepEqual(labLimits(lowerLegacyConfig, 'html'), {
    uploadBytes: 100 * mib, maxFiles: 500, maxUncompressedBytes: 64 * mib,
  });
  assert.equal(labLimits(lowerLegacyConfig, 'demo').maxUncompressedBytes, 64 * mib);
  assert.deepEqual(labLimits(higherLegacyConfig, 'html'), {
    uploadBytes: 100 * mib, maxFiles: 500, maxUncompressedBytes: 100 * mib,
  });
  assert.deepEqual(labLimits(lowerLegacyConfig, 'unity-webgl'), {
    uploadBytes: 280 * mib, maxFiles: 500, maxUncompressedBytes: 300 * mib,
  });
});

test('上传入口在Multer解析multipart前按请求头或原生表单查询参数选择ZIP上限', () => {
  const observed = [];
  const receive = createLabUploadReceiver({
    config: { labMaxFiles: 20, labMaxUncompressedBytes: 1024 },
    storage: {},
    fileFilter: () => {},
    multerFactory(options) {
      observed.push(options);
      return {
        single(fieldName) {
          assert.equal(fieldName, 'file');
          return (request, _response, next) => {
            request.multipartParsed = true;
            next();
          };
        },
      };
    },
  });
  const invoke = (headerType, queryType, multipartType) => {
    const request = {
      query: queryType ? { projectType: queryType } : {},
      body: { projectType: multipartType },
      get: (name) => (name === 'X-Lab-Project-Type' ? headerType : undefined),
    };
    let receivedError;
    receive(request, {}, (error) => { receivedError = error; });
    return { request, error: receivedError };
  };

  const unity = invoke('unity-webgl', '', 'html');
  assert.equal(unity.error, undefined);
  assert.equal(unity.request.labProjectType, 'unity-webgl');
  assert.equal(observed[0].limits.fileSize, 280 * 1024 * 1024);
  const demoFallback = invoke('', 'demo', 'unity-webgl');
  assert.equal(demoFallback.error, undefined);
  assert.equal(demoFallback.request.labProjectType, 'demo');
  assert.equal(observed[1].limits.fileSize, 100 * 1024 * 1024);
  const mismatchedPrebodyHints = invoke('html', 'unity-webgl', 'html');
  assert.equal(mismatchedPrebodyHints.error.statusCode, 400);
  assert.equal(observed.length, 2);
  const invalidType = invoke('other', '', 'unity-webgl');
  assert.equal(invalidType.error.statusCode, 400);
  assert.equal(observed.length, 2);
});

test('小作坊服务端再次拒绝超过对应项目类型ZIP上限的文件', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());
  for (const item of [
    { type: 'html', limit: LAB_MAX_HTML_DEMO_UPLOAD_BYTES },
    { type: 'unity-webgl', limit: LAB_MAX_UNITY_UPLOAD_BYTES },
  ]) {
    const uploadPath = path.join(runtime.config.uploadsDir, `too-large-${item.type}.zip`);
    const handle = await fs.open(uploadPath, 'w');
    await handle.truncate(item.limit + 1);
    await handle.close();
    await assert.rejects(
      runtime.labService.createProject({ path: uploadPath, originalname: `${item.type}.zip` }, {
        title: `超限 ${item.type}`,
        description: '服务层二次检查上传文件字节数。',
        projectType: item.type,
      }),
      (error) => error instanceof LabValidationError && error.statusCode === 413,
    );
    await assert.rejects(fs.access(uploadPath), /ENOENT/);
  }
  assert.equal(runtime.database.prepare('SELECT COUNT(*) AS count FROM lab_projects').get().count, 0);
});

test('有效网页ZIP可解压、发布显隐、生成链接并在删除时清理记录和目录', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());
  const file = await runtime.writeUpload('design.zip', validLabZip());
  const project = await runtime.labService.createProject(file, {
    title: '安全网页实验',
    description: '包含HTML、CSS、JS和图片。',
    isVisible: true,
  });
  assert.equal(project.projectType, 'html');
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

test('旧小作坊库会幂等修正latin1错解文件名并补封面列', async (t) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-lab-migration-'));
  t.after(() => fs.rm(runtimeRoot, { recursive: true, force: true }));
  const dataDir = path.join(runtimeRoot, 'data');
  const databasePath = path.join(dataDir, 'legacy.sqlite3');
  await fs.mkdir(dataDir, { recursive: true });
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE lab_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      is_visible INTEGER NOT NULL DEFAULT 0 CHECK (is_visible IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const insert = legacy.prepare(`
    INSERT INTO lab_projects (slug, title, description, original_filename, is_visible, created_at, updated_at)
    VALUES (?, ?, '迁移测试', ?, 0, '2026-09-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z')
  `);
  insert.run('broken-name', '错解文件名', '11ç»\x84.zip');
  insert.run('fixed-name', '已正确文件名', '11组.zip');
  insert.run('invalid-sequence', '无效字节序列', 'badÿ.zip');
  legacy.close();

  const config = {
    serverRoot: path.resolve(__dirname, '..'), dataDir, databasePath,
    contentDir: path.join(runtimeRoot, 'content'), uploadsDir: path.join(runtimeRoot, 'uploads'),
    labStorageDir: path.join(runtimeRoot, 'lab-storage'),
  };
  await fs.mkdir(path.join(config.labStorageDir, 'broken-name'), { recursive: true });
  await fs.writeFile(path.join(config.labStorageDir, 'broken-name', 'index.html'), '<h1>existing project</h1>');
  let database = initializeDatabase(config);
  assert.equal(database.prepare('SELECT original_filename FROM lab_projects WHERE slug = ?').get('broken-name').original_filename, '11组.zip');
  assert.equal(database.prepare('SELECT original_filename FROM lab_projects WHERE slug = ?').get('fixed-name').original_filename, '11组.zip');
  assert.equal(database.prepare('SELECT original_filename FROM lab_projects WHERE slug = ?').get('invalid-sequence').original_filename, 'badÿ.zip');
  assert.ok(database.prepare('PRAGMA table_info(lab_projects)').all().some((column) => column.name === 'cover_image'));
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM content_migrations WHERE name = ?').get(LAB_FILENAME_LATIN1_FIX_MIGRATION_NAME).count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM content_migrations WHERE name = ?').get(LAB_COVER_MIGRATION_NAME).count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM content_migrations WHERE name = ?').get(LAB_PROJECT_TYPE_MIGRATION_NAME).count, 1);
  assert.deepEqual(database.prepare('SELECT project_type FROM lab_projects ORDER BY id').all().map((row) => row.project_type), ['html', 'html', 'html']);
  const createdBefore = database.prepare('SELECT created_at, updated_at, is_visible FROM lab_projects WHERE slug = ?').get('broken-name');
  assert.equal(createdBefore.is_visible, 0);
  database.close();

  database = initializeDatabase(config);
  assert.equal(database.prepare('SELECT original_filename FROM lab_projects WHERE slug = ?').get('broken-name').original_filename, '11组.zip');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM content_migrations WHERE name IN (?, ?)').get(LAB_FILENAME_LATIN1_FIX_MIGRATION_NAME, LAB_COVER_MIGRATION_NAME).count, 2);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM content_migrations WHERE name = ?').get(LAB_PROJECT_TYPE_MIGRATION_NAME).count, 1);
  const oldProject = new LabService(database, {
    labStorageDir: config.labStorageDir,
    labBaseUrl: 'http://localhost:3001/lab',
  }).getProject(database.prepare('SELECT id FROM lab_projects WHERE slug = ?').get('broken-name').id);
  assert.equal(oldProject.projectType, 'html');
  assert.equal(oldProject.accessUrl, 'http://localhost:3001/lab/broken-name/');
  assert.equal(oldProject.isVisible, false);
  assert.deepEqual(
    database.prepare('SELECT created_at, updated_at, is_visible FROM lab_projects WHERE slug = ?').get('broken-name'),
    createdBefore,
  );
  assert.equal(await fs.readFile(path.join(config.labStorageDir, 'broken-name', 'index.html'), 'utf8'), '<h1>existing project</h1>');
  const oldService = new LabService(database, { labStorageDir: config.labStorageDir, labBaseUrl: 'http://localhost:3001/lab' });
  assert.equal(oldService.toggleVisibility(oldProject.id).isVisible, true);
  assert.equal(oldService.toggleVisibility(oldProject.id).slug, 'broken-name');
  await oldService.deleteProject(oldProject.id);
  await assert.rejects(fs.access(path.join(config.labStorageDir, 'broken-name')), /ENOENT/);
  database.close();
});

test('旧链接项目可继续HTTP访问、切换显隐与删除且不改slug和目录', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());
  const slug = 'legacy-project-link';
  const projectDirectory = path.join(runtime.config.labStorageDir, slug);
  await fs.mkdir(projectDirectory, { recursive: true });
  await fs.writeFile(path.join(projectDirectory, 'index.html'), '<h1>旧项目继续可用</h1>');
  const result = runtime.database.prepare(`
    INSERT INTO lab_projects (
      slug, title, description, original_filename, is_visible, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(slug, '旧项目', '保留原有链接。', 'legacy.zip', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
  const original = runtime.labService.getProject(result.lastInsertRowid);
  assert.equal(original.projectType, 'html');
  assert.equal(original.accessUrl, `http://localhost:3001/lab/${slug}/`);
  assert.equal(original.isVisible, true);

  let response = await fetch(`${runtime.baseUrl}/lab/${slug}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /旧项目继续可用/);
  const hidden = runtime.labService.toggleVisibility(original.id);
  assert.equal(hidden.isVisible, false);
  assert.equal(hidden.slug, slug);
  assert.equal(hidden.accessUrl, original.accessUrl);
  assert.equal(await fs.readFile(path.join(projectDirectory, 'index.html'), 'utf8'), '<h1>旧项目继续可用</h1>');
  response = await fetch(`${runtime.baseUrl}/lab/${slug}/`);
  assert.equal(response.status, 200);

  await runtime.labService.deleteProject(original.id);
  assert.equal(runtime.database.prepare('SELECT COUNT(*) AS count FROM lab_projects WHERE id = ?').get(original.id).count, 0);
  await assert.rejects(fs.access(projectDirectory), /ENOENT/);
  response = await fetch(`${runtime.baseUrl}/lab/${slug}/`);
  assert.equal(response.status, 404);
});

test('Windows压缩文件夹的单一顶层目录会自动展开为项目根目录', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());
  const wrappedZip = zip([
    { name: '网页项目/', body: '' },
    { name: '网页项目/index.html', body: '<!doctype html><h1>Windows 顶层目录兼容</h1>' },
    { name: '网页项目/assets/app.js', body: 'document.body.dataset.ready="true";' },
  ]);
  const project = await runtime.labService.createProject(
    await runtime.writeUpload('windows-folder.zip', wrappedZip),
    { title: 'Windows 压缩项目', description: '自动识别唯一顶层目录。' },
  );
  const projectDirectory = path.join(runtime.config.labStorageDir, project.slug);
  assert.match(await fs.readFile(path.join(projectDirectory, 'index.html'), 'utf8'), /顶层目录兼容/);
  await assert.rejects(fs.access(path.join(projectDirectory, '网页项目')), /ENOENT/);
});

test('Unity WebGL的wasm与data文件可通过校验并按正确MIME静态提供', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());
  const unityZip = zip([
    { name: 'index.html', body: '<!doctype html><script>window.unityConfig={};</script><script src="Build/game.loader.js"></script>' },
    { name: 'Build/', body: '' },
    { name: 'Build/game.loader.js', body: 'window.createUnityInstance=()=>Promise.resolve();' },
    { name: 'Build/game.framework.js', body: 'self.unityFramework=true;' },
    { name: 'Build/game.wasm', body: Buffer.from('0061736d01000000', 'hex') },
    { name: 'Build/game.data', body: Buffer.from('unity-data') },
    { name: 'TemplateData/', body: '' },
    { name: 'TemplateData/style.css', body: 'canvas{width:100%}' },
  ]);
  const project = await runtime.labService.createProject(
    await runtime.writeUpload('unity-webgl.zip', unityZip),
    { title: 'Unity WebGL', description: '验证构建产物白名单。', projectType: 'unity-webgl' },
  );
  assert.equal(project.projectType, 'unity-webgl');
  const projectDirectory = path.join(runtime.config.labStorageDir, project.slug);
  assert.deepEqual(await fs.readFile(path.join(projectDirectory, 'Build', 'game.wasm')), Buffer.from('0061736d01000000', 'hex'));
  assert.equal(await fs.readFile(path.join(projectDirectory, 'Build', 'game.data'), 'utf8'), 'unity-data');

  const response = await fetch(`${runtime.baseUrl}/lab/${project.slug}/Build/game.wasm`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/wasm');
});

test('Unity仅允许br与gzip文件，静态响应保留原压缩字节并返回底层MIME与安全头', async (t) => {
  const runtime = await createRuntime({ labMaxUncompressedBytes: 1024 });
  t.after(() => runtime.close());
  const wasmBytes = Buffer.from('0061736d01000000', 'hex');
  const compressed = [
    { name: 'Build/game.loader.js.gz', body: zlib.gzipSync(Buffer.from('window.loader=true;')) },
    { name: 'Build/game.framework.js.br', body: zlib.brotliCompressSync(Buffer.from('window.framework=true;')) },
    { name: 'Build/game.wasm.br', body: zlib.brotliCompressSync(wasmBytes) },
    { name: 'Build/game.data.gz', body: zlib.gzipSync(Buffer.from('unity-data')) },
  ];
  const unityZip = zip([
    { name: 'index.html', body: '<!doctype html><script src="Build/game.loader.js.gz"></script>' },
    ...compressed,
  ]);
  const project = await runtime.labService.createProject(
    await runtime.writeUpload('unity-compressed.zip', unityZip),
    { title: '压缩 Unity', description: '验证gzip与Brotli静态响应。', projectType: 'unity-webgl' },
  );

  const expectedTypes = new Map([
    ['Build/game.loader.js.gz', 'application/javascript'],
    ['Build/game.framework.js.br', 'application/javascript'],
    ['Build/game.wasm.br', 'application/wasm'],
    ['Build/game.data.gz', 'application/octet-stream'],
  ]);
  for (const asset of compressed) {
    const response = await requestRawHttp(`${runtime.baseUrl}/lab/${project.slug}/${asset.name}`);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-encoding'], asset.name.endsWith('.br') ? 'br' : 'gzip');
    assert.ok(
      response.headers['content-type'].startsWith(expectedTypes.get(asset.name)),
      `${asset.name} returned Content-Type ${response.headers['content-type']}`,
    );
    assert.deepEqual(response.body, asset.body);
    assert.equal(response.headers['content-security-policy'], UNITY_LAB_CSP);
    assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['cross-origin-opener-policy'], undefined);
    assert.equal(response.headers['cross-origin-embedder-policy'], undefined);
  }

  const nginxConfig = await fs.readFile(path.resolve(__dirname, '..', '..', 'deploy', 'nginx.conf'), 'utf8');
  const labBlock = nginxConfig.split('server_name ${LAB_SERVER_NAME};')[1];
  assert.ok(labBlock);
  assert.match(nginxConfig, /map \$uri \$lab_asset_content_encoding/);
  assert.ok(labBlock.includes('location ~* \\.wasm\\.(?:br|gz)$ { types { } default_type application/wasm; }'));
  assert.doesNotMatch(labBlock, /rewrite .*\$1 last/);
  const mainBlock = nginxConfig.split('server_name ${SERVER_NAME};')[1].split('server_name ${LAB_SERVER_NAME};')[0];
  const labUploadIndex = mainBlock.indexOf('location ~ ^/(?:api/admin/lab/upload|admin/lab/upload)$');
  const ordinaryUploadIndex = mainBlock.indexOf('location ~ ^/api/admin/uploads$');
  assert.ok(labUploadIndex >= 0 && ordinaryUploadIndex > labUploadIndex);
  const labUploadLocation = mainBlock.slice(labUploadIndex, ordinaryUploadIndex);
  assert.match(labUploadLocation, /client_max_body_size 300m;[\s\S]*client_body_timeout 300s;[\s\S]*proxy_request_buffering off;/);
  const ordinaryUploadLocation = mainBlock.slice(ordinaryUploadIndex, mainBlock.indexOf('location ~ ^/(?:admin|api|uploads)', ordinaryUploadIndex));
  assert.doesNotMatch(ordinaryUploadLocation, /client_max_body_size/);
  assert.match(ordinaryUploadLocation, /client_body_timeout 300s;[\s\S]*proxy_request_buffering off;/);
  assert.equal((nginxConfig.match(/client_max_body_size 300m;/g) || []).length, 1);
});

test('小作坊ZIP解压边界按类型在limit内接受、超1字节拒绝', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());
  const cases = [
    { type: 'html', limit: LAB_MAX_HTML_DEMO_UNCOMPRESSED_BYTES, extension: 'html' },
    { type: 'demo', limit: LAB_MAX_HTML_DEMO_UNCOMPRESSED_BYTES, extension: 'html' },
    { type: 'unity-webgl', limit: LAB_MAX_UNITY_UNCOMPRESSED_BYTES, extension: 'data' },
  ];
  for (const { type, limit, extension } of cases) {
    const entryName = `payload.${extension}`;
    const entries = [{ name: 'index.html', body: '' }, { name: entryName, body: 'x' }];
    if (type === 'unity-webgl') entries.push(
      { name: 'Build/game.loader.js', body: '' },
      { name: 'Build/game.wasm', body: '' },
    );
    const zipAtLimit = setZipEntryUncompressedSize(zip(entries), entryName, limit);
    const exactPath = path.join(runtime.config.uploadsDir, `at-limit-${type}.zip`);
    await fs.writeFile(exactPath, zipAtLimit);
    const exact = await inspectZip(exactPath, runtime.config.labStorageDir, {
      maxFiles: 20,
      maxUncompressedBytes: limit,
    }, type);
    assert.equal(exact.totalBytes, limit, `${type} exact ceiling should be accepted`);

    const overPath = path.join(runtime.config.uploadsDir, `over-limit-${type}.zip`);
    await fs.writeFile(overPath, setZipEntryUncompressedSize(zip(entries), entryName, limit + 1));
    await assert.rejects(
      inspectZip(overPath, runtime.config.labStorageDir, {
        maxFiles: 20,
        maxUncompressedBytes: limit,
      }, type),
      (error) => error instanceof LabValidationError && error.statusCode === 413,
    );
  }
});

test('Unity压缩后缀只允许用于Unity项目，项目类型不匹配时不落库', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());
  for (const projectType of ['html', 'demo']) {
    const file = await runtime.writeUpload(`not-unity-${projectType}.zip`, zip([
      { name: 'index.html', body: 'safe' },
      { name: 'app.js.gz', body: zlib.gzipSync(Buffer.from('compressed')) },
    ]));
    await assert.rejects(
      runtime.labService.createProject(file, {
        title: `拒绝压缩 ${projectType}`,
        description: '只有Unity允许压缩后缀。',
        projectType,
      }),
      (error) => error instanceof LabValidationError && error.statusCode === 415,
    );
  }
  const ordinaryHtml = await runtime.writeUpload('ordinary-html.zip', validLabZip());
  await assert.rejects(
    runtime.labService.createProject(ordinaryHtml, {
      title: '类型不匹配',
      description: '普通网页不能声明为Unity。',
      projectType: 'unity-webgl',
    }),
    /必须包含 loader\.js、\.wasm 和 \.data/,
  );
  assert.equal(runtime.database.prepare('SELECT COUNT(*) AS count FROM lab_projects').get().count, 0);
});

test('Unity压缩格式与可执行文件仍被白名单以415拒绝', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());
  for (const extension of ['.exe', '.unityweb']) {
    const file = await runtime.writeUpload(`rejected-${extension.slice(1)}.zip`, zip([
      { name: 'index.html', body: 'safe' },
      { name: `Build/game${extension}`, body: 'not allowed' },
    ]));
    await assert.rejects(
      runtime.labService.createProject(file, { title: `拒绝 ${extension}`, description: '白名单边界验证。' }),
      (error) => error instanceof LabValidationError
        && error.statusCode === 415
        && error.message.includes(`Build/game${extension}`),
    );
  }
});

test('macOS与Windows元数据文件被忽略且不放宽其它ZIP安全校验', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());
  const metadataZip = zip([
    { name: '__MACOSX/', body: '' },
    { name: '__MACOSX/._index.html', body: 'metadata' },
    { name: '.DS_Store', body: 'finder' },
    { name: 'Thumbs.db', body: 'thumbs' },
    { name: 'desktop.ini', body: 'desktop' },
    { name: 'index.html', body: '<!doctype html><h1>元数据忽略验证</h1>' },
  ]);
  const project = await runtime.labService.createProject(
    await runtime.writeUpload('metadata.zip', metadataZip),
    { title: '元数据兼容项目', description: '忽略系统生成文件。' },
  );
  const projectDirectory = path.join(runtime.config.labStorageDir, project.slug);
  assert.match(await fs.readFile(path.join(projectDirectory, 'index.html'), 'utf8'), /元数据忽略验证/);
  for (const ignored of ['__MACOSX', '.DS_Store', 'Thumbs.db', 'desktop.ini']) {
    await assert.rejects(fs.access(path.join(projectDirectory, ignored)), /ENOENT/);
  }
});

test('不允许的ZIP文件类型会同时点名文件和允许的扩展名', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());
  const file = await runtime.writeUpload('bad-type.zip', zip([
    { name: 'index.html', body: 'safe' },
    { name: 'server/shell.php', body: '<?php echo 1;' },
  ]));
  await assert.rejects(
    runtime.labService.createProject(file, { title: '错误类型', description: '验证可执行错误信息。' }),
    (error) => error instanceof LabValidationError
      && error.statusCode === 415
      && /server\/shell\.php/.test(error.message)
      && /允许的扩展名/.test(error.message)
      && /\.html/.test(error.message)
      && /\.css/.test(error.message),
  );
});

test('唯一顶层文件夹缺少index时给出可执行的重新压缩提示', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());
  const file = await runtime.writeUpload('missing-index.zip', zip([
    { name: '网页项目/readme.txt', body: '缺少入口文件。' },
  ]));
  await assert.rejects(
    runtime.labService.createProject(file, { title: '缺入口', description: '验证目录提示。' }),
    (error) => error instanceof LabValidationError
      && /第一层是文件夹 网页项目/.test(error.message)
      && /进入文件夹选中全部内容再压缩/.test(error.message),
  );
});

test('进程中断遗留的pending-lab临时文件会在下一次启动时清理', async (t) => {
  const runtime = await createRuntime({ seedInterruptedLabUpload: true });
  t.after(() => runtime.close());
  assert.notEqual(runtime.interruptedLabUploadPath, '');
  await assert.rejects(fs.access(runtime.interruptedLabUploadPath), /ENOENT/);
});

test('ZIP解压中途抛错会清掉半成品pending目录与上传临时包', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());
  const file = await runtime.writeUpload('pending-lab-mid-extract.zip', validLabZip());
  const service = new LabService(runtime.database, runtime.config, {
    extractZip: async (_entries, destinationRoot) => {
      await fs.writeFile(path.join(destinationRoot, 'partial.html'), 'partial');
      throw new Error('simulated disk full during extraction');
    },
  });

  await assert.rejects(
    service.createProject(file, { title: '中途失败', description: '验证半成品清理。' }),
    /小作坊项目创建失败：simulated disk full during extraction/,
  );
  const storageEntries = await fs.readdir(runtime.config.labStorageDir);
  assert.deepEqual(storageEntries.filter((name) => name.startsWith('.pending-')), []);
  await assert.rejects(fs.stat(file.path), { code: 'ENOENT' });
});

test('小作坊超长中文标题仍创建受限且唯一的目录名', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());
  const commonPrefix = '坊'.repeat(100);
  const first = await runtime.labService.createProject(
    await runtime.writeUpload('long-first.zip', validLabZip()),
    { title: `${commonPrefix}甲`, description: '第一个超长标题项目。' },
  );
  const second = await runtime.labService.createProject(
    await runtime.writeUpload('long-second.zip', validLabZip()),
    { title: `${commonPrefix}乙`, description: '第二个超长标题项目。' },
  );

  assert.notEqual(first.slug, second.slug);
  assert.equal(second.slug.endsWith('-2'), true);
  for (const project of [first, second]) {
    assert.ok(Buffer.byteLength(project.slug, 'utf8') <= MAX_SLUG_BYTES);
    assert.match(project.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    const directory = path.join(runtime.config.labStorageDir, project.slug);
    assert.ok((await fs.stat(directory)).isDirectory());
    assert.match(await fs.readFile(path.join(directory, 'index.html'), 'utf8'), /本地小作坊验证/);
  }
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
  upload.set('projectType', 'html');
  upload.set('isVisible', '1');
  upload.set('file', new Blob([validLabZip()], { type: 'application/zip' }), '接口设计.zip');
  response = await client.request('/api/admin/lab/upload', {
    method: 'POST',
    headers: { 'x-csrf-token': csrf, 'x-lab-project-type': 'html' },
    body: upload,
  });
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.project.title, '接口上传项目');
  assert.equal(payload.project.isVisible, true);
  assert.equal(payload.project.projectType, 'html');
  assert.equal(payload.project.original_filename, '接口设计.zip');

  const uploadsBeforeMismatch = await fs.readdir(runtime.config.uploadsDir);
  const mismatchedTypeUpload = new FormData();
  mismatchedTypeUpload.set('title', '请求类型冲突');
  mismatchedTypeUpload.set('description', 'multipart字段不能覆盖预先选定的类型。');
  mismatchedTypeUpload.set('projectType', 'unity-webgl');
  mismatchedTypeUpload.set('file', new Blob([validLabZip()], { type: 'application/zip' }), 'mismatch.zip');
  response = await client.request('/api/admin/lab/upload', {
    method: 'POST',
    headers: { 'x-csrf-token': csrf, 'x-lab-project-type': 'html' },
    body: mismatchedTypeUpload,
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /项目类型与上传请求头不一致/);
  assert.deepEqual(await fs.readdir(runtime.config.uploadsDir), uploadsBeforeMismatch);

  response = await client.request('/admin/lab');
  const html = await response.text();
  assert.match(html, /接口上传项目/);
  assert.match(html, /HTML 网页 · 接口设计\.zip/);
  assert.match(html, /data-copy-lab-link/);
  assert.equal(runtime.database.prepare('SELECT COUNT(*) AS count FROM lab_projects').get().count, 1);

  const unityFormFallback = new FormData();
  unityFormFallback.set('_csrf', csrf);
  unityFormFallback.set('title', '原生表单Unity项目');
  unityFormFallback.set('description', '查询参数在multipart正文之前选择限额。');
  unityFormFallback.set('projectType', 'unity-webgl');
  unityFormFallback.set('file', new Blob([zip([
    { name: 'index.html', body: '<script src="Build/game.loader.js"></script>' },
    { name: 'Build/game.loader.js', body: 'window.loader=true;' },
    { name: 'Build/game.wasm', body: Buffer.from('0061736d01000000', 'hex') },
    { name: 'Build/game.data', body: 'data' },
  ])], { type: 'application/zip' }), 'unity-form.zip');
  response = await client.request('/admin/lab/upload?projectType=unity-webgl', {
    method: 'POST',
    body: unityFormFallback,
  });
  assert.equal(response.status, 302);
  assert.equal(runtime.database.prepare('SELECT project_type FROM lab_projects WHERE title = ?').get('原生表单Unity项目').project_type, 'unity-webgl');
  response = await client.request('/admin/lab');
  assert.match(await response.text(), /Unity WebGL · unity-form\.zip/);

  response = await client.request(`/admin/lab/${payload.project.id}/download`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''%E6%8E%A5%E5%8F%A3%E8%AE%BE%E8%AE%A1\.zip/);
  assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 2).toString('hex'), '504b');
});

test('小作坊卡片使用可选封面且无封面时保留几何占位图', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());
  const coverName = `${Date.now()}-${crypto.randomUUID()}.webp`;
  await fs.writeFile(path.join(runtime.config.uploadsDir, coverName), Buffer.from('lab-cover'));
  const withCover = await runtime.labService.createProject(
    await runtime.writeUpload('with-cover.zip', validLabZip()),
    { title: '有封面项目', description: '应显示真实封面。', coverImage: `assets/works/covers/${coverName}`, isVisible: true },
  );
  const withoutCover = await runtime.labService.createProject(
    await runtime.writeUpload('without-cover.zip', validLabZip()),
    { title: '无封面项目', description: '应显示几何占位图。', isVisible: true },
  );
  await runtime.publishService.publishAll();
  const html = await fs.readFile(path.join(runtime.config.siteRoot, 'works.html'), 'utf8');
  assert.match(html, new RegExp(`<img src="assets/works/covers/${coverName}"`));
  assert.match(html, new RegExp(`href="${withCover.accessUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" target="_blank"`));
  assert.match(html, /class="work-slider-track"[\s\S]*?<article class="portfolio-card">[\s\S]*?<div class="portfolio-cover cover-/);
  assert.equal(withoutCover.cover_image, null);
  assert.match(html, /data-work-track tabindex="0" aria-label="小作坊项目，可横向滑动"/);
});

test('/lab静态响应使用Unity专用CSP且主站与后台CSP逐字保持原值', async (t) => {
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
  assert.equal(csp, UNITY_LAB_CSP);
  assert.match(csp, /script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /worker-src 'self' blob:/);
  assert.match(await response.text(), /本地小作坊验证/);

  const nginxConfig = await fs.readFile(path.resolve(__dirname, '..', '..', 'deploy', 'nginx.conf'), 'utf8');
  const nginxLabCsp = nginxConfig.match(
    /server_name \$\{LAB_SERVER_NAME\};[\s\S]*?add_header Content-Security-Policy "([^"]+)" always;/,
  )?.[1];
  assert.equal(nginxLabCsp, UNITY_LAB_CSP);

  for (const route of ['/health', '/admin/login']) {
    const unchanged = await fetch(`${runtime.baseUrl}${route}`);
    assert.equal(unchanged.headers.get('content-security-policy'), UNCHANGED_MAIN_ADMIN_CSP);
  }

  const missing = await fetch(`${runtime.baseUrl}/lab/not-found/`, {
    headers: { cookie: 'zhiliaohub.admin.sid=fake-admin-cookie' },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('set-cookie'), null);
});
