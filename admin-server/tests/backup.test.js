// Proves backup integrity, encrypted restore, destructive recovery and retention cleanup.
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');
const Database = require('better-sqlite3');
const tar = require('tar');
const bcrypt = require('bcrypt');

const execFileAsync = promisify(execFile);
const restoreScript = path.resolve(__dirname, '..', 'scripts', 'restore.js');

const { createApp } = require('../src/app');
const { initializeDatabase } = require('../src/db');
const { loadBackupConfig } = require('../src/backup-config');
const { ContentService } = require('../src/services/content-service');
const {
  DEFAULT_RESTORE_PROBE_TIMEOUT_MS,
  PRE_RESTORE_PREFIX,
  createBackup,
  probeDatabaseExclusiveLock,
  probeServiceHealth,
  restoreBackup,
  verifyExtractedBackup,
} = require('../src/services/backup-service');

test('恢复健康探测默认总预算为60秒', () => {
  assert.equal(DEFAULT_RESTORE_PROBE_TIMEOUT_MS, 60000);
});

function createConfig(runtimeRoot) {
  const dataDir = path.join(runtimeRoot, 'data');
  return {
    serverRoot: path.resolve(__dirname, '..'),
    dataDir,
    databasePath: path.join(dataDir, 'admin.sqlite3'),
    contentDir: path.join(runtimeRoot, 'content'),
    uploadsDir: path.join(runtimeRoot, 'uploads'),
    labStorageDir: path.join(runtimeRoot, 'lab-storage'),
    labBaseUrl: 'http://localhost/lab',
    backupDir: path.join(runtimeRoot, 'backups'),
    backupRetentionCount: 3,
    backupExcludeZip: false,
    backupEncryptionPassword: '',
    contentMaxBytes: 64 * 1024,
  };
}

async function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function unusedLoopbackPort() {
  const server = http.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function startNginxProbe(statusCode = 503) {
  let requestCount = 0;
  const server = http.createServer((request, response) => {
    requestCount += 1;
    response.setHeader('Server', 'nginx');
    response.writeHead(request.url === '/health' ? statusCode : 404);
    response.end();
  });
  const port = await listen(server);
  return {
    server,
    url: `http://127.0.0.1:${port}/health`,
    requestCount: () => requestCount,
  };
}

async function restoreWithStoppedService(config, archivePath, options = {}) {
  const probe = await startNginxProbe(503);
  try {
    return await restoreBackup(
      { ...config, restoreProbeUrl: probe.url },
      archivePath,
      { force: true, confirmServiceStopped: true, ...options },
    );
  } finally {
    await closeServer(probe.server);
  }
}

async function archiveWithoutLabStorage(sourceArchive, runtimeRoot, name) {
  const unpacked = path.join(runtimeRoot, `${name}-unpacked`);
  const archivePath = path.join(runtimeRoot, `${name}.tar.gz`);
  await fs.mkdir(unpacked, { recursive: true });
  await tar.x({ cwd: unpacked, file: sourceArchive, strict: true });
  const manifestPath = path.join(unpacked, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.files = manifest.files.filter((file) => !file.path.startsWith('lab-storage/'));
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await fs.rm(path.join(unpacked, 'lab-storage'), { recursive: true, force: true });
  await tar.c({
    cwd: unpacked,
    file: archivePath,
    gzip: true,
    portable: true,
  }, ['manifest.json', 'data', 'content', 'uploads']);
  return archivePath;
}

async function seedLabProject(config) {
  const database = initializeDatabase(config);
  const slug = 'backup-round-trip-lab';
  const indexBody = '<!doctype html><meta charset="utf-8"><h1>LAB_BACKUP_ROUND_TRIP</h1>';
  const projectDirectory = path.join(config.labStorageDir, slug);
  await fs.mkdir(projectDirectory, { recursive: true });
  await fs.writeFile(path.join(projectDirectory, 'index.html'), indexBody, 'utf8');
  database.prepare(`
    INSERT INTO lab_projects (
      slug, title, description, original_filename, is_visible, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(
    slug,
    '备份往返小作坊',
    '验证小作坊唯一解压产物能够完整恢复。',
    'backup-round-trip.zip',
    '2026-08-26T00:00:00.000Z',
    '2026-08-26T00:00:00.000Z',
  );
  database.close();
  return { slug, indexBody, projectDirectory };
}

async function openLabPage(config, slug) {
  const context = createApp({
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 3001,
    sessionSecret: crypto.randomBytes(48).toString('base64url'),
    adminPasswordHash: await bcrypt.hash('backup-round-trip-password', 4),
    totpEncryptionKey: crypto.randomBytes(32),
    dataDir: config.dataDir,
    databasePath: config.databasePath,
    contentDir: config.contentDir,
    uploadsDir: config.uploadsDir,
    labStorageDir: config.labStorageDir,
    labBaseUrl: config.labBaseUrl,
    siteRoot: path.join(path.dirname(config.dataDir), 'site'),
  });
  const server = await new Promise((resolve) => {
    const instance = context.app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/lab/${slug}/`);
    return { status: response.status, body: await response.text() };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    context.sessionStore.close();
    context.database.close();
  }
}

async function seedStorage(config) {
  const database = initializeDatabase(config);
  const contentService = new ContentService(database, config);
  const work = await contentService.createWork({
    title: '待恢复作品',
    workDate: '2026-08-04',
    category: '程序',
    summary: '验证作品元数据与正文恢复。',
    detailIntro: '验证作品元数据与正文恢复。',
    body: '# 待恢复作品\n\n作品正文必须完整恢复。',
  });
  const note = await contentService.createNote({
    title: '待恢复日记',
    noteDate: '2026-08-04',
    summary: '验证日记元数据与正文恢复。',
    body: '# 待恢复日记\n\n日记正文必须完整恢复。',
  });
  await fs.writeFile(path.join(config.uploadsDir, 'proof.txt'), 'uploaded-file-proof\n', 'utf8');
  database.close();
  return { work, note };
}

test('备份配置默认包含ZIP并保留3份，环境开关可启用ZIP排除', () => {
  const previousRetention = process.env.BACKUP_RETENTION_COUNT;
  const previousExcludeZip = process.env.BACKUP_EXCLUDE_ZIP;
  const previousScheduleLocalTime = process.env.BACKUP_SCHEDULE_LOCAL_TIME;
  const previousRestoreProbeUrl = process.env.RESTORE_PROBE_URL;
  try {
    delete process.env.BACKUP_RETENTION_COUNT;
    delete process.env.BACKUP_EXCLUDE_ZIP;
    delete process.env.BACKUP_SCHEDULE_LOCAL_TIME;
    process.env.RESTORE_PROBE_URL = 'https://127.0.0.1/health';
    const defaults = loadBackupConfig();
    assert.equal(defaults.backupRetentionCount, 3);
    assert.equal(defaults.backupExcludeZip, false);
    assert.equal(defaults.backupScheduleLocalTime, '00:00');
    assert.equal(defaults.restoreProbeUrl, 'https://127.0.0.1/health');

    process.env.BACKUP_EXCLUDE_ZIP = 'true';
    assert.equal(loadBackupConfig().backupExcludeZip, true);
    process.env.BACKUP_SCHEDULE_LOCAL_TIME = '24:00';
    assert.throws(() => loadBackupConfig(), /BACKUP_SCHEDULE_LOCAL_TIME must use 24-hour HH:MM format/);
  } finally {
    if (previousRetention === undefined) delete process.env.BACKUP_RETENTION_COUNT;
    else process.env.BACKUP_RETENTION_COUNT = previousRetention;
    if (previousExcludeZip === undefined) delete process.env.BACKUP_EXCLUDE_ZIP;
    else process.env.BACKUP_EXCLUDE_ZIP = previousExcludeZip;
    if (previousScheduleLocalTime === undefined) delete process.env.BACKUP_SCHEDULE_LOCAL_TIME;
    else process.env.BACKUP_SCHEDULE_LOCAL_TIME = previousScheduleLocalTime;
    if (previousRestoreProbeUrl === undefined) delete process.env.RESTORE_PROBE_URL;
    else process.env.RESTORE_PROBE_URL = previousRestoreProbeUrl;
  }
});

test('缺少停服确认参数时恢复在任何探测或写入前被拒绝', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-restore-confirmation-'));
  const config = createConfig(runtimeRoot);
  try {
    await seedStorage(config);
    const backup = await createBackup(config, { now: new Date('2026-09-02T00:00:00.000Z') });
    const database = new Database(config.databasePath);
    database.prepare('UPDATE works SET title = ?').run('缺少确认时必须保留');
    database.close();

    await assert.rejects(
      restoreBackup(config, backup.archivePath, { force: true }),
      /requires --confirm-service-stopped/,
    );
    const untouched = new Database(config.databasePath, { readonly: true });
    try {
      assert.equal(untouched.prepare('SELECT title FROM works').get().title, '缺少确认时必须保留');
    } finally {
      untouched.close();
    }
    assert.equal(
      (await fs.readdir(config.backupDir)).filter((name) => name.startsWith('pre-restore-')).length,
      0,
    );
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('恢复探测地址必须显式指向本机Nginx且连接失败绝不作为停服证据', async () => {
  await assert.rejects(
    probeServiceHealth({ restoreProbeUrl: '' }),
    /RESTORE_PROBE_URL is required.*Public domains are forbidden/s,
  );
  await assert.rejects(
    probeServiceHealth({ restoreProbeUrl: 'https://zhiliaohub.com/health' }),
    /Public domain names are forbidden.*old machine during migration/s,
  );
  const port = await unusedLoopbackPort();
  await assert.rejects(
    probeServiceHealth(
      { restoreProbeUrl: `http://127.0.0.1:${port}/health` },
      { restoreProbeTimeoutMs: 200 },
    ),
    /remained inconclusive after \d+ attempt\(s\).*total budget 200ms.*Last result:.*Only an explicit Nginx 502\/503\/504/s,
  );
});

test('健康探测首次返回200时立即拒绝且不重试', async () => {
  const probe = await startNginxProbe(200);
  const startedAt = Date.now();
  try {
    await assert.rejects(
      probeServiceHealth(
        { restoreProbeUrl: probe.url },
        { restoreProbeTimeoutMs: 3000 },
      ),
      /returned HTTP 200 on attempt 1.*No retry was performed/s,
    );
    assert.equal(probe.requestCount(), 1);
    assert.ok(Date.now() - startedAt < 1000, '明确的HTTP 200不得等待总预算或发起第二次请求。');
  } finally {
    await closeServer(probe.server);
  }
});

test('健康探测连续超时会用尽总预算后拒绝且不会无限等待', async () => {
  let requestCount = 0;
  const server = http.createServer(() => {
    requestCount += 1;
  });
  const port = await listen(server);
  const budgetMs = 1400;
  const startedAt = Date.now();
  try {
    await assert.rejects(
      probeServiceHealth(
        { restoreProbeUrl: `http://127.0.0.1:${port}/health` },
        { restoreProbeTimeoutMs: budgetMs },
      ),
      /remained inconclusive after 2 attempt\(s\).*total budget 1400ms.*Last result: timed out/s,
    );
    const elapsedMs = Date.now() - startedAt;
    assert.equal(requestCount, 2);
    assert.ok(elapsedMs >= budgetMs, `实际耗时 ${elapsedMs}ms 不得短于总预算 ${budgetMs}ms。`);
    assert.ok(elapsedMs < budgetMs + 1000, `实际耗时 ${elapsedMs}ms 不得无限超出预算。`);
  } finally {
    await closeServer(server);
  }
});

test('健康探测前两次超时后收到Nginx 503即可通过', async () => {
  let requestCount = 0;
  const server = http.createServer((request, response) => {
    requestCount += 1;
    if (requestCount <= 2) return;
    response.setHeader('Server', 'nginx');
    response.writeHead(request.url === '/health' ? 503 : 404);
    response.end();
  });
  const port = await listen(server);
  try {
    const result = await probeServiceHealth(
      { restoreProbeUrl: `http://127.0.0.1:${port}/health` },
      { restoreProbeTimeoutMs: 4000 },
    );
    assert.equal(requestCount, 3);
    assert.equal(result.statusCode, 503);
    assert.equal(result.attempts, 3);
    assert.ok(result.elapsedMs >= 2000 && result.elapsedMs < 4000);
  } finally {
    await closeServer(server);
  }
});

test('人工跳过恢复前快照要求两个参数成对出现且不替代停服确认', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-restore-snapshot-confirmation-'));
  const config = createConfig(runtimeRoot);
  try {
    await seedStorage(config);
    const backup = await createBackup(config, { now: new Date('2026-09-02T00:00:30.000Z') });
    const database = new Database(config.databasePath);
    database.prepare('UPDATE works SET title = ?').run('双参数不齐时必须保留');
    database.close();
    const stoppedConfig = { ...config, restoreProbeUrl: '' };

    await assert.rejects(
      restoreBackup(stoppedConfig, backup.archivePath, {
        force: true,
        confirmServiceStopped: true,
        skipPreRestoreSnapshot: true,
      }),
      /requires --confirm-no-pre-restore-snapshot together with --skip-pre-restore-snapshot/,
    );
    await assert.rejects(
      restoreBackup(stoppedConfig, backup.archivePath, {
        force: true,
        confirmServiceStopped: true,
        confirmNoPreRestoreSnapshot: true,
      }),
      /--confirm-no-pre-restore-snapshot is only valid together with --skip-pre-restore-snapshot/,
    );
    await assert.rejects(
      restoreBackup(stoppedConfig, backup.archivePath, {
        force: true,
        skipPreRestoreSnapshot: true,
        confirmNoPreRestoreSnapshot: true,
      }),
      /requires --confirm-service-stopped/,
      '放弃恢复前快照不得隐含服务已经停止。',
    );

    const untouched = new Database(config.databasePath, { readonly: true });
    try {
      assert.equal(untouched.prepare('SELECT title FROM works').get().title, '双参数不齐时必须保留');
    } finally {
      untouched.close();
    }
    assert.equal(
      (await fs.readdir(config.backupDir)).filter((name) => name.startsWith('pre-restore-')).length,
      0,
    );
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('恢复CLI只接受成对跳过参数并显著声明本次恢复没有回退点', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-restore-snapshot-cli-'));
  const config = createConfig(runtimeRoot);
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [
        restoreScript,
        '--archive',
        'unused.tar.gz',
        '--force',
        '--confirm-service-stopped',
        '--skip-pre-restore-snapshot',
      ], { cwd: config.serverRoot, windowsHide: true }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /必须与 --confirm-no-pre-restore-snapshot 同时给出/);
        return true;
      },
    );
    await assert.rejects(
      execFileAsync(process.execPath, [
        restoreScript,
        '--archive',
        'unused.tar.gz',
        '--force',
        '--confirm-service-stopped',
        '--confirm-no-pre-restore-snapshot',
      ], { cwd: config.serverRoot, windowsHide: true }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /只能与 --skip-pre-restore-snapshot 同时使用/);
        return true;
      },
    );

    await seedStorage(config);
    const backup = await createBackup(config, { now: new Date('2026-09-02T00:00:45.000Z') });
    const database = new Database(config.databasePath);
    database.prepare('UPDATE works SET title = ?').run('即将无回退点恢复');
    database.close();
    const probe = await startNginxProbe(503);
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [
        restoreScript,
        '--archive',
        backup.archivePath,
        '--force',
        '--confirm-service-stopped',
        '--skip-pre-restore-snapshot',
        '--confirm-no-pre-restore-snapshot',
        '--probe-timeout-ms',
        '1000',
      ], {
        cwd: config.serverRoot,
        windowsHide: true,
        env: {
          ...process.env,
          RESTORE_PROBE_URL: probe.url,
          DATA_DIR: config.dataDir,
          CONTENT_DIR: config.contentDir,
          UPLOAD_DIR: config.uploadsDir,
          LAB_STORAGE_DIR: config.labStorageDir,
          BACKUP_DIR: config.backupDir,
          BACKUP_ENCRYPTION_PASSWORD: '',
        },
      });
      assert.match(stderr, /严重警告：本次恢复已按独立双重确认跳过恢复前快照/);
      assert.match(stderr, /本次恢复没有回退点/);
      assert.match(stderr, /恢复失败或选错归档，无法通过恢复前快照回滚/);
      assert.match(stdout, /恢复完成/);
      assert.equal(
        (await fs.readdir(config.backupDir)).filter((name) => name.startsWith('pre-restore-')).length,
        0,
      );
      const restored = new Database(config.databasePath, { readonly: true });
      try {
        assert.equal(restored.prepare('SELECT title FROM works').get().title, '待恢复作品');
      } finally {
        restored.close();
      }
    } finally {
      await closeServer(probe.server);
    }
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('恢复CLI只接受严格正整数探测超时且缺值不会静默回退', async () => {
  for (const invalid of ['', '0', '-1', '1.5', 'abc', '9007199254740992']) {
    const args = [
      restoreScript,
      '--archive',
      'unused.tar.gz',
      '--force',
      '--confirm-service-stopped',
      '--probe-timeout-ms',
    ];
    if (invalid) args.push(invalid);
    await assert.rejects(
      execFileAsync(process.execPath, args, { windowsHide: true }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--probe-timeout-ms 必须提供一个严格大于 0 的安全整数毫秒值/);
        return true;
      },
    );
  }
});

test('健康但可能属于旧机器的探测地址返回200时恢复被拒绝并给出迁移提示', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-restore-healthy-probe-'));
  const config = createConfig(runtimeRoot);
  const probe = await startNginxProbe(200);
  try {
    await seedStorage(config);
    const backup = await createBackup(config, { now: new Date('2026-09-02T00:01:00.000Z') });
    const database = new Database(config.databasePath);
    database.prepare('UPDATE works SET title = ?').run('健康地址命中时必须保留');
    database.close();

    await assert.rejects(
      restoreBackup(
        { ...config, restoreProbeUrl: probe.url },
        backup.archivePath,
        { force: true, confirmServiceStopped: true },
      ),
      /returned HTTP 200.*confirm this address resolves to this machine rather than the old machine/s,
    );
    const untouched = new Database(config.databasePath, { readonly: true });
    try {
      assert.equal(untouched.prepare('SELECT title FROM works').get().title, '健康地址命中时必须保留');
    } finally {
      untouched.close();
    }
    assert.equal(
      (await fs.readdir(config.backupDir)).filter((name) => name.startsWith('pre-restore-')).length,
      0,
    );
  } finally {
    if (probe.server.listening) await closeServer(probe.server);
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('SQLite 被占用时独占写锁探测拒绝恢复且不创建恢复前快照', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-restore-lock-probe-'));
  const config = createConfig(runtimeRoot);
  let blocker = null;
  try {
    await seedStorage(config);
    const backup = await createBackup(config, { now: new Date('2026-09-02T00:02:00.000Z') });
    blocker = new Database(config.databasePath);
    blocker.pragma('journal_mode = DELETE');
    blocker.prepare('UPDATE works SET title = ?').run('写锁命中时必须保留');
    blocker.exec('BEGIN IMMEDIATE');

    await assert.rejects(
      probeDatabaseExclusiveLock(config.databasePath),
      /SQLite exclusive-lock probe.*Stop the backend service/s,
    );
    assert.equal(
      (await fs.readdir(config.backupDir)).filter((name) => name.startsWith('pre-restore-')).length,
      0,
    );
    blocker.exec('ROLLBACK');
    assert.equal(blocker.prepare('SELECT title FROM works').get().title, '写锁命中时必须保留');
  } finally {
    if (blocker?.inTransaction) blocker.exec('ROLLBACK');
    blocker?.close();
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('空闲但存活的WAL连接即使允许BEGIN EXCLUSIVE也会被-shm证据拦住', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-restore-idle-wal-'));
  const config = createConfig(runtimeRoot);
  let idle = null;
  const probe = await startNginxProbe(503);
  try {
    await seedStorage(config);
    const backup = await createBackup(config, { now: new Date('2026-09-02T00:02:30.000Z') });
    idle = new Database(config.databasePath, { fileMustExist: true });
    idle.pragma('journal_mode = WAL');
    assert.equal(
      await fs.stat(`${config.databasePath}-shm`).then(() => true).catch(() => false),
      true,
      '空闲WAL连接必须留下共享内存文件作为独立证据。',
    );
    await assert.doesNotReject(
      probeDatabaseExclusiveLock(config.databasePath),
      '旧探测的BEGIN EXCLUSIVE在空闲WAL连接存在时确实会误放行。',
    );

    await assert.rejects(
      restoreBackup(
        { ...config, restoreProbeUrl: probe.url },
        backup.archivePath,
        { force: true, confirmServiceStopped: true },
      ),
      /WAL shared-memory file.*idle connection may still be open/s,
    );
    assert.equal(
      (await fs.readdir(config.backupDir)).filter((name) => name.startsWith('pre-restore-')).length,
      0,
    );
  } finally {
    idle?.close();
    if (probe.server.listening) await closeServer(probe.server);
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('崩溃后残留的-shm按安全侧误报拒绝恢复且不建议直接删除', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-restore-stale-shm-'));
  const config = createConfig(runtimeRoot);
  const probe = await startNginxProbe(503);
  try {
    await seedStorage(config);
    const backup = await createBackup(config, { now: new Date('2026-09-02T00:02:45.000Z') });
    await fs.writeFile(`${config.databasePath}-shm`, 'STALE_SHM_PROBE', 'utf8');
    await assert.rejects(
      restoreBackup(
        { ...config, restoreProbeUrl: probe.url },
        backup.archivePath,
        { force: true, confirmServiceStopped: true },
      ),
      /stale file after a crash is treated as unsafe.*Do not delete -shm\/-wal files/s,
    );
    assert.equal(
      (await fs.readdir(config.backupDir)).filter((name) => name.startsWith('pre-restore-')).length,
      0,
    );
  } finally {
    if (probe.server.listening) await closeServer(probe.server);
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('服务已停止且确认参数齐全时恢复正常完成', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-restore-stopped-'));
  const config = createConfig(runtimeRoot);
  try {
    await seedStorage(config);
    const backup = await createBackup(config, { now: new Date('2026-09-02T00:03:00.000Z') });
    const database = new Database(config.databasePath);
    database.prepare('UPDATE works SET title = ?').run('恢复前变化');
    database.close();

    const restored = await restoreWithStoppedService(config, backup.archivePath);
    assert.equal(restored.preRestoreSnapshot.skipped, undefined);
    const recovered = new Database(config.databasePath, { readonly: true });
    try {
      assert.equal(recovered.prepare('SELECT title FROM works').get().title, '待恢复作品');
    } finally {
      recovered.close();
    }
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('旧归档缺少lab-storage且恢复后数据库有小作坊记录时警告并保留目标目录', async () => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-legacy-lab-source-'));
  const targetRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-legacy-lab-target-'));
  const sourceConfig = createConfig(sourceRoot);
  const targetConfig = createConfig(targetRoot);
  const sentinel = path.join(targetConfig.labStorageDir, 'keep-existing.txt');
  try {
    await seedStorage(sourceConfig);
    const labProject = await seedLabProject(sourceConfig);
    const backup = await createBackup(sourceConfig, { now: new Date('2026-09-02T00:04:00.000Z') });
    const legacyArchive = await archiveWithoutLabStorage(backup.archivePath, sourceRoot, 'legacy-with-record');
    await fs.mkdir(targetConfig.labStorageDir, { recursive: true });
    await fs.writeFile(sentinel, 'TARGET_DIRECTORY_MUST_SURVIVE', 'utf8');

    const restored = await restoreWithStoppedService(targetConfig, legacyArchive);
    assert.match(restored.warnings.join('\n'), /数据库中有 1 条小作坊记录/);
    assert.match(restored.warnings.join('\n'), /本归档不含 lab-storage/);
    assert.match(restored.warnings.join('\n'), /创建于 lab-storage 纳入备份之前/);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'TARGET_DIRECTORY_MUST_SURVIVE');
    assert.equal(
      await fs.stat(path.join(targetConfig.labStorageDir, labProject.slug, 'index.html'))
        .then(() => true)
        .catch(() => false),
      false,
    );
    const recovered = new Database(targetConfig.databasePath, { readonly: true });
    try {
      assert.equal(recovered.prepare('SELECT COUNT(*) AS count FROM lab_projects').get().count, 1);
    } finally {
      recovered.close();
    }
  } finally {
    await fs.rm(sourceRoot, { recursive: true, force: true });
    await fs.rm(targetRoot, { recursive: true, force: true });
  }
});

test('旧归档缺少lab-storage但恢复后数据库无小作坊记录时不制造警告', async () => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-legacy-empty-lab-source-'));
  const targetRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-legacy-empty-lab-target-'));
  const sourceConfig = createConfig(sourceRoot);
  const targetConfig = createConfig(targetRoot);
  const sentinel = path.join(targetConfig.labStorageDir, 'keep-existing.txt');
  try {
    await seedStorage(sourceConfig);
    const backup = await createBackup(sourceConfig, { now: new Date('2026-09-02T00:05:00.000Z') });
    const legacyArchive = await archiveWithoutLabStorage(backup.archivePath, sourceRoot, 'legacy-without-record');
    await fs.mkdir(targetConfig.labStorageDir, { recursive: true });
    await fs.writeFile(sentinel, 'TARGET_DIRECTORY_MUST_SURVIVE', 'utf8');

    const restored = await restoreWithStoppedService(targetConfig, legacyArchive);
    assert.doesNotMatch(restored.warnings.join('\n'), /lab-storage/);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'TARGET_DIRECTORY_MUST_SURVIVE');
    const recovered = new Database(targetConfig.databasePath, { readonly: true });
    try {
      assert.equal(recovered.prepare('SELECT COUNT(*) AS count FROM lab_projects').get().count, 0);
    } finally {
      recovered.close();
    }
  } finally {
    await fs.rm(sourceRoot, { recursive: true, force: true });
    await fs.rm(targetRoot, { recursive: true, force: true });
  }
});

test('默认备份包含ZIP，开启排除后保留清单元数据并在恢复时明确提示补齐', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-backup-excluded-zip-'));
  const freshRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-backup-excluded-zip-restore-'));
  const config = createConfig(runtimeRoot);
  const freshConfig = createConfig(freshRoot);
  const zipName = '1787417000000-11111111-2222-4333-8444-555555555555.zip';
  const imageName = '1787417000001-66666666-7777-4888-8999-aaaaaaaaaaaa.png';
  const zipPath = path.join(config.uploadsDir, zipName);
  const zipBytes = crypto.randomBytes(2 * 1024 * 1024);
  const imageBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const zipSha256 = crypto.createHash('sha256').update(zipBytes).digest('hex');
  try {
    await seedStorage(config);
    await fs.writeFile(zipPath, zipBytes);
    await fs.writeFile(path.join(config.uploadsDir, imageName), imageBytes);

    const includedBackup = await createBackup(config, { now: new Date('2026-08-04T00:00:00.000Z') });
    const includedArchiveSize = (await fs.stat(includedBackup.archivePath)).size;
    assert.equal(includedBackup.manifest.formatVersion, 2);
    assert.ok(includedBackup.manifest.files.some((file) => file.path === `uploads/${zipName}`));
    assert.deepEqual(includedBackup.manifest.excluded, []);

    const unpackedIncluded = path.join(runtimeRoot, 'unpacked-included');
    await fs.mkdir(unpackedIncluded);
    await tar.x({ cwd: unpackedIncluded, file: includedBackup.archivePath, strict: true });
    assert.deepEqual(await fs.readFile(path.join(unpackedIncluded, 'uploads', zipName)), zipBytes);
    assert.deepEqual((await verifyExtractedBackup(unpackedIncluded)).excluded, []);

    const excludedBackup = await createBackup(
      { ...config, backupExcludeZip: true },
      { now: new Date('2026-08-04T00:01:00.000Z') },
    );
    const excludedArchiveSize = (await fs.stat(excludedBackup.archivePath)).size;
    assert.equal(excludedBackup.manifest.formatVersion, 2);
    assert.ok(excludedBackup.manifest.files.some((file) => file.path === 'uploads/proof.txt'));
    assert.deepEqual(excludedBackup.manifest.excluded, [{
      path: `uploads/${zipName}`,
      size: zipBytes.length,
      sha256: zipSha256,
    }]);

    const unpacked = path.join(runtimeRoot, 'unpacked-excluded');
    await fs.mkdir(unpacked);
    await tar.x({ cwd: unpacked, file: excludedBackup.archivePath, strict: true });
    assert.equal(await fs.readFile(path.join(unpacked, 'uploads', 'proof.txt'), 'utf8'), 'uploaded-file-proof\n');
    assert.deepEqual(await fs.readFile(path.join(unpacked, 'uploads', imageName)), imageBytes);
    assert.equal(
      await fs.stat(path.join(unpacked, 'uploads', zipName)).then(() => true).catch(() => false),
      false,
      '被排除的ZIP不得出现在解包内容中。',
    );
    const unpackedManifest = JSON.parse(await fs.readFile(path.join(unpacked, 'manifest.json'), 'utf8'));
    assert.deepEqual(unpackedManifest.excluded, excludedBackup.manifest.excluded);

    const restored = await restoreWithStoppedService(freshConfig, excludedBackup.archivePath);
    assert.deepEqual(restored.excludedFiles, excludedBackup.manifest.excluded);
    assert.equal(restored.warnings.length, 2);
    assert.match(restored.warnings.join('\n'), /未包含 1 个 ZIP 文件/);
    assert.match(restored.warnings.join('\n'), /manifest\.excluded/);
    assert.equal(await fs.readFile(path.join(freshConfig.uploadsDir, 'proof.txt'), 'utf8'), 'uploaded-file-proof\n');
    assert.deepEqual(await fs.readFile(path.join(freshConfig.uploadsDir, imageName)), imageBytes);
    assert.equal(await fs.stat(path.join(freshConfig.uploadsDir, zipName)).then(() => true).catch(() => false), false);

    assert.ok(
      includedArchiveSize > excludedArchiveSize + (zipBytes.length * 0.9),
      '同一份ZIP进入归档时，归档体积应明显大于排除ZIP时。',
    );
    console.log(`备份体积对比：含 .zip ${includedArchiveSize} 字节；排除 .zip ${excludedArchiveSize} 字节；减少 ${includedArchiveSize - excludedArchiveSize} 字节。`);
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
    await fs.rm(freshRoot, { recursive: true, force: true });
  }
});

test('小作坊解压产物真实备份恢复且瞬时目录不进入归档', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-lab-backup-round-trip-'));
  const config = createConfig(runtimeRoot);
  try {
    const seeded = await seedStorage(config);
    const labProject = await seedLabProject(config);
    const pendingDirectory = path.join(config.labStorageDir, '.pending-x');
    const deletedDirectory = path.join(config.labStorageDir, '.deleted-y');
    await fs.mkdir(pendingDirectory, { recursive: true });
    await fs.mkdir(deletedDirectory, { recursive: true });
    await fs.writeFile(path.join(pendingDirectory, 'partial.html'), 'PENDING_MUST_NOT_BACK_UP', 'utf8');
    await fs.writeFile(path.join(deletedDirectory, 'removed.html'), 'DELETED_MUST_NOT_BACK_UP', 'utf8');

    const backup = await createBackup(config, { now: new Date('2026-08-26T00:00:00.000Z') });
    assert.ok(backup.manifest.files.some(
      (file) => file.path === `lab-storage/${labProject.slug}/index.html`,
    ));
    assert.ok(backup.manifest.files.every(
      (file) => !file.path.startsWith('lab-storage/.pending-')
        && !file.path.startsWith('lab-storage/.deleted-'),
    ));
    assert.deepEqual(backup.manifest.excluded, [], '瞬时目录不得成为manifest.excluded条目。');

    const unpacked = path.join(runtimeRoot, 'unpacked-lab-backup');
    await fs.mkdir(unpacked);
    await tar.x({ cwd: unpacked, file: backup.archivePath, strict: true });
    assert.equal(
      await fs.readFile(path.join(unpacked, 'lab-storage', labProject.slug, 'index.html'), 'utf8'),
      labProject.indexBody,
    );
    assert.equal(
      await fs.stat(path.join(unpacked, 'lab-storage', '.pending-x')).then(() => true).catch(() => false),
      false,
    );
    assert.equal(
      await fs.stat(path.join(unpacked, 'lab-storage', '.deleted-y')).then(() => true).catch(() => false),
      false,
    );

    const damaged = new Database(config.databasePath);
    damaged.exec('DELETE FROM works; DELETE FROM notes; DELETE FROM lab_projects;');
    damaged.close();
    await fs.rm(path.join(config.contentDir, 'works'), { recursive: true, force: true });
    await fs.rm(path.join(config.contentDir, 'notes'), { recursive: true, force: true });
    await fs.rm(config.uploadsDir, { recursive: true, force: true });
    await fs.rm(labProject.projectDirectory, { recursive: true, force: true });

    await restoreWithStoppedService(config, backup.archivePath);

    const recovered = new Database(config.databasePath, { readonly: true });
    try {
      assert.equal(recovered.prepare('SELECT title FROM works').get().title, '待恢复作品');
      assert.equal(recovered.prepare('SELECT title FROM notes').get().title, '待恢复日记');
      assert.equal(recovered.prepare('SELECT slug FROM lab_projects').get().slug, labProject.slug);
    } finally {
      recovered.close();
    }
    assert.match(
      await fs.readFile(path.join(config.contentDir, ...seeded.work.markdown_path.split('/')), 'utf8'),
      /作品正文必须完整恢复/,
    );
    assert.match(
      await fs.readFile(path.join(config.contentDir, ...seeded.note.markdown_path.split('/')), 'utf8'),
      /日记正文必须完整恢复/,
    );
    assert.equal(await fs.readFile(path.join(config.uploadsDir, 'proof.txt'), 'utf8'), 'uploaded-file-proof\n');
    assert.equal(await fs.readFile(path.join(labProject.projectDirectory, 'index.html'), 'utf8'), labProject.indexBody);

    const labPage = await openLabPage(config, labProject.slug);
    assert.equal(labPage.status, 200);
    assert.equal(labPage.body, labProject.indexBody);
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('仅内容原子临时文件被排除，合法的tmp命名在小作坊与其他目录仍完整入档', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-backup-tmp-scope-'));
  const config = createConfig(runtimeRoot);
  const atomicWorkName = 'draft.md.tmp-4321-11111111-2222-4333-8444-555555555555';
  const atomicNoteName = 'note.md.tmp-9876-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const legitimateContentName = 'release.tmp-preview.md';
  const legitimateLabName = 'bundle.tmp-release.js';
  const legitimateUploadName = 'asset.tmp-release.bin';
  try {
    await seedStorage(config);
    const labProject = await seedLabProject(config);
    await fs.writeFile(path.join(config.contentDir, 'works', atomicWorkName), 'ATOMIC_WORK_TEMP', 'utf8');
    await fs.writeFile(path.join(config.contentDir, 'notes', atomicNoteName), 'ATOMIC_NOTE_TEMP', 'utf8');
    await fs.writeFile(
      path.join(config.contentDir, 'works', legitimateContentName),
      'LEGITIMATE_CONTENT_TMP_NAME',
      'utf8',
    );
    await fs.writeFile(
      path.join(labProject.projectDirectory, legitimateLabName),
      'LEGITIMATE_LAB_TMP_NAME',
      'utf8',
    );
    await fs.writeFile(
      path.join(config.uploadsDir, legitimateUploadName),
      'LEGITIMATE_UPLOAD_TMP_NAME',
      'utf8',
    );

    const backup = await createBackup(config, { now: new Date('2026-08-27T00:00:00.000Z') });
    const archivedPaths = new Set(backup.manifest.files.map((file) => file.path));
    assert.equal(archivedPaths.has(`content/works/${atomicWorkName}`), false);
    assert.equal(archivedPaths.has(`content/notes/${atomicNoteName}`), false);
    assert.ok(archivedPaths.has(`content/works/${legitimateContentName}`));
    assert.ok(archivedPaths.has(`lab-storage/${labProject.slug}/${legitimateLabName}`));
    assert.ok(archivedPaths.has(`uploads/${legitimateUploadName}`));
    assert.deepEqual(backup.manifest.excluded, [], '原子临时文件不是可恢复源文件，不写入排除清单。');

    const unpacked = path.join(runtimeRoot, 'unpacked-tmp-scope');
    await fs.mkdir(unpacked);
    await tar.x({ cwd: unpacked, file: backup.archivePath, strict: true });
    assert.equal(
      await fs.readFile(
        path.join(unpacked, 'lab-storage', labProject.slug, legitimateLabName),
        'utf8',
      ),
      'LEGITIMATE_LAB_TMP_NAME',
    );
    assert.equal(
      await fs.stat(path.join(unpacked, 'content', 'works', atomicWorkName))
        .then(() => true)
        .catch(() => false),
      false,
    );
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('格式2恢复器继续接受没有excluded字段的旧格式1清单', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-backup-v1-manifest-'));
  try {
    const relativePath = 'data/admin.sqlite3';
    const absolutePath = path.join(root, 'data', 'admin.sqlite3');
    const bytes = Buffer.from('legacy-manifest-proof');
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, bytes);
    await fs.writeFile(path.join(root, 'manifest.json'), `${JSON.stringify({
      formatVersion: 1,
      createdAt: '2026-08-04T00:00:00.000Z',
      encryption: 'none',
      files: [{
        path: relativePath,
        size: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      }],
    }, null, 2)}\n`, 'utf8');

    const manifest = await verifyExtractedBackup(root);
    assert.equal(manifest.formatVersion, 1);
    assert.deepEqual(manifest.excluded, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('加密备份可在原始数据被破坏后完整恢复 SQLite、Markdown 与上传文件', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-backup-flow-'));
  const config = createConfig(runtimeRoot);
  const password = 'test-only-backup-password';
  try {
    const seeded = await seedStorage(config);
    const backup = await createBackup(config, {
      encryptionPassword: password,
      now: new Date('2026-08-04T01:02:03.456Z'),
    });
    assert.match(backup.archivePath, /backup-20260804T010203456Z\.tar\.gz\.enc$/);
    assert.ok(backup.manifest.files.some((file) => file.path === 'data/admin.sqlite3'));
    assert.ok(backup.manifest.files.some((file) => file.path === path.posix.join('content', seeded.work.markdown_path)));
    assert.ok(backup.manifest.files.some((file) => file.path === path.posix.join('content', seeded.note.markdown_path)));
    assert.ok(backup.manifest.files.some((file) => file.path === 'uploads/proof.txt'));

    await assert.rejects(
      restoreWithStoppedService(config, backup.archivePath, {
        encryptionPassword: 'incorrect-password',
      }),
      /authenticate data|bad decrypt|Unsupported state/i,
      '错误的备份密码不得产生可恢复数据。',
    );

    const damaged = new Database(config.databasePath);
    damaged.exec('DELETE FROM works; DELETE FROM notes;');
    damaged.close();
    await fs.rm(path.join(config.contentDir, 'works'), { recursive: true, force: true });
    await fs.rm(path.join(config.contentDir, 'notes'), { recursive: true, force: true });
    await fs.rm(config.uploadsDir, { recursive: true, force: true });

    const restored = await restoreWithStoppedService(config, backup.archivePath, {
      encryptionPassword: password,
    });
    assert.equal(restored.manifest.createdAt, '2026-08-04T01:02:03.456Z');

    const recovered = new Database(config.databasePath, { readonly: true });
    try {
      assert.equal(recovered.prepare('SELECT title FROM works').get().title, '待恢复作品');
      assert.equal(recovered.prepare('SELECT title FROM notes').get().title, '待恢复日记');
    } finally {
      recovered.close();
    }
    assert.match(
      await fs.readFile(path.join(config.contentDir, ...seeded.work.markdown_path.split('/')), 'utf8'),
      /作品正文必须完整恢复/,
    );
    assert.match(
      await fs.readFile(path.join(config.contentDir, ...seeded.note.markdown_path.split('/')), 'utf8'),
      /日记正文必须完整恢复/,
    );
    assert.equal(await fs.readFile(path.join(config.uploadsDir, 'proof.txt'), 'utf8'), 'uploaded-file-proof\n');
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('恢复前自动创建快照，误选旧归档后仍能退回恢复前的状态', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-pre-restore-'));
  const config = { ...createConfig(runtimeRoot), preRestoreRetentionCount: 3 };
  try {
    const seeded = await seedStorage(config);
    const oldArchive = await createBackup(config, { now: new Date('2026-08-01T01:00:00.000Z') });

    // Move to a newer state that must survive an accidental restore of the old archive.
    const database = new Database(config.databasePath);
    const contentService = new ContentService(database, config);
    await contentService.updateWork(seeded.work.id, {
      title: '恢复前的最新作品',
      workDate: '2026-08-11',
      category: '程序',
      summary: '恢复前的最新摘要。',
      detailIntro: '恢复前的最新摘要。',
      body: '# 最新\n\nCURRENT_MARKER 最新正文。',
    });
    database.close();
    await fs.writeFile(path.join(config.uploadsDir, 'proof.txt'), 'current-upload\n', 'utf8');

    const wrongRestore = await restoreWithStoppedService(config, oldArchive.archivePath);
    assert.equal(wrongRestore.preRestoreSnapshot.skipped, undefined, '恢复前必须自动创建快照。');
    const snapshotPath = wrongRestore.preRestoreSnapshot.archivePath;
    assert.match(path.basename(snapshotPath), new RegExp(`^${PRE_RESTORE_PREFIX}-\\d{8}T\\d{9}Z\\.tar\\.gz$`));
    assert.ok(
      wrongRestore.preRestoreSnapshot.manifest.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256)),
      '恢复前快照必须复用带 SHA-256 校验的清单。',
    );

    // The wrong restore really did roll the live data back.
    const afterWrong = new Database(config.databasePath, { fileMustExist: true });
    try {
      assert.equal(afterWrong.prepare('SELECT title FROM works').get().title, '待恢复作品');
    } finally {
      afterWrong.close();
    }

    // The snapshot brings the pre-restore state back, content included.
    await restoreWithStoppedService(config, snapshotPath);
    const recovered = new Database(config.databasePath, { readonly: true });
    try {
      assert.equal(recovered.prepare('SELECT title FROM works').get().title, '恢复前的最新作品');
      assert.equal(recovered.prepare('SELECT summary FROM works').get().summary, '恢复前的最新摘要。');
    } finally {
      recovered.close();
    }
    const recoveredBody = await fs.readFile(
      path.join(config.contentDir, ...seeded.work.markdown_path.split('/')),
      'utf8',
    );
    assert.match(recoveredBody, /CURRENT_MARKER/);
    assert.equal(await fs.readFile(path.join(config.uploadsDir, 'proof.txt'), 'utf8'), 'current-upload\n');
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('恢复前快照创建失败时中止恢复，且不修改任何现有数据', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-pre-restore-abort-'));
  const config = createConfig(runtimeRoot);
  try {
    const seeded = await seedStorage(config);
    const archive = await createBackup(config, { now: new Date('2026-08-01T02:00:00.000Z') });
    // Keep the archive outside backupDir, so breaking backupDir below can only fail the
    // snapshot step and never the reading of the archive being restored.
    const externalArchive = path.join(runtimeRoot, 'external-archive.tar.gz');
    await fs.copyFile(archive.archivePath, externalArchive);

    const database = new Database(config.databasePath);
    database.prepare('UPDATE works SET title = ?').run('中止测试的当前标题');
    database.close();
    await fs.writeFile(path.join(config.uploadsDir, 'proof.txt'), 'must-not-change\n', 'utf8');

    // Make the backup destination unusable: a regular file where the directory must be.
    await fs.rm(config.backupDir, { recursive: true, force: true });
    await fs.writeFile(config.backupDir, 'not-a-directory', 'utf8');

    await assert.rejects(
      restoreWithStoppedService(config, externalArchive),
      /Restore aborted: the pre-restore snapshot could not be created/,
      '快照失败时必须中止恢复。',
    );

    // Nothing may have been overwritten.
    const untouched = new Database(config.databasePath, { readonly: true });
    try {
      assert.equal(untouched.prepare('SELECT title FROM works').get().title, '中止测试的当前标题');
    } finally {
      untouched.close();
    }
    assert.equal(await fs.readFile(path.join(config.uploadsDir, 'proof.txt'), 'utf8'), 'must-not-change\n');
    assert.match(
      await fs.readFile(path.join(config.contentDir, ...seeded.work.markdown_path.split('/')), 'utf8'),
      /作品正文必须完整恢复/,
    );
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('恢复前快照使用独立保留策略，不被常规备份的最近 N 份挤掉', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-pre-restore-retention-'));
  const config = createConfig(runtimeRoot);
  try {
    await seedStorage(config);
    const snapshot = await createBackup(config, {
      namePrefix: PRE_RESTORE_PREFIX,
      now: new Date('2026-08-04T02:00:00.000Z'),
      retentionCount: 3,
    });

    // A regular schedule keeping only the latest 2 must not evict the snapshot.
    for (const millisecond of [1, 2, 3, 4, 5]) {
      await createBackup(config, {
        now: new Date(`2026-08-04T03:00:00.00${millisecond}Z`),
        retentionCount: 2,
      });
    }
    const listing = await fs.readdir(config.backupDir);
    assert.ok(listing.includes(path.basename(snapshot.archivePath)), '恢复前快照不得被常规保留策略清理。');
    assert.equal(listing.filter((name) => name.startsWith('backup-')).length, 2);

    // The snapshot pool prunes against its own count.
    for (const millisecond of [1, 2, 3] ) {
      await createBackup(config, {
        namePrefix: PRE_RESTORE_PREFIX,
        now: new Date(`2026-08-04T04:00:00.00${millisecond}Z`),
        retentionCount: 3,
      });
    }
    const snapshots = (await fs.readdir(config.backupDir))
      .filter((name) => name.startsWith(`${PRE_RESTORE_PREFIX}-`))
      .sort();
    assert.deepEqual(snapshots, [
      'pre-restore-20260804T040000001Z.tar.gz',
      'pre-restore-20260804T040000002Z.tar.gz',
      'pre-restore-20260804T040000003Z.tar.gz',
    ]);
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('目标环境还没有数据库时跳过恢复前快照并继续恢复', async () => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-pre-restore-source-'));
  const freshRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-pre-restore-fresh-'));
  const sourceConfig = createConfig(sourceRoot);
  const freshConfig = createConfig(freshRoot);
  try {
    await seedStorage(sourceConfig);
    const archive = await createBackup(sourceConfig, { now: new Date('2026-08-05T01:00:00.000Z') });

    const restored = await restoreWithStoppedService(freshConfig, archive.archivePath);
    assert.equal(restored.preRestoreSnapshot.skipped, true);
    assert.equal(restored.preRestoreSnapshot.explicitlySkipped, undefined);
    assert.match(restored.preRestoreSnapshot.reason, /no existing database/);

    const database = new Database(freshConfig.databasePath, { readonly: true });
    try {
      assert.equal(database.prepare('SELECT title FROM works').get().title, '待恢复作品');
    } finally {
      database.close();
    }
    assert.equal(
      (await fs.readdir(freshConfig.backupDir).catch(() => []))
        .filter((name) => name.startsWith(`${PRE_RESTORE_PREFIX}-`)).length,
      0,
      '没有可保护的数据时不应产生快照。',
    );
  } finally {
    await fs.rm(sourceRoot, { recursive: true, force: true });
    await fs.rm(freshRoot, { recursive: true, force: true });
  }
});

test('默认备份保留策略连续产出4份后只保留最近3份归档', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-backup-retention-'));
  const config = createConfig(runtimeRoot);
  try {
    await seedStorage(config);
    const dates = [1, 2, 3, 4].map(
      (millisecond) => new Date(`2026-08-04T01:00:00.00${millisecond}Z`),
    );
    for (const now of dates) await createBackup(config, { now });
    const archives = (await fs.readdir(config.backupDir)).filter((name) => name.startsWith('backup-')).sort();
    assert.deepEqual(archives, [
      'backup-20260804T010000002Z.tar.gz',
      'backup-20260804T010000003Z.tar.gz',
      'backup-20260804T010000004Z.tar.gz',
    ]);
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});
