// Proves backup integrity, encrypted restore, destructive recovery and retention cleanup.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const tar = require('tar');
const bcrypt = require('bcrypt');

const { createApp } = require('../src/app');
const { initializeDatabase } = require('../src/db');
const { loadBackupConfig } = require('../src/backup-config');
const { ContentService } = require('../src/services/content-service');
const {
  PRE_RESTORE_PREFIX,
  createBackup,
  restoreBackup,
  verifyExtractedBackup,
} = require('../src/services/backup-service');

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
  try {
    delete process.env.BACKUP_RETENTION_COUNT;
    delete process.env.BACKUP_EXCLUDE_ZIP;
    delete process.env.BACKUP_SCHEDULE_LOCAL_TIME;
    const defaults = loadBackupConfig();
    assert.equal(defaults.backupRetentionCount, 3);
    assert.equal(defaults.backupExcludeZip, false);
    assert.equal(defaults.backupScheduleLocalTime, '00:00');

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

    const restored = await restoreBackup(freshConfig, excludedBackup.archivePath, { force: true });
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

    await restoreBackup(config, backup.archivePath, { force: true });

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
      restoreBackup(config, backup.archivePath, {
        force: true,
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

    const restored = await restoreBackup(config, backup.archivePath, {
      force: true,
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

    const wrongRestore = await restoreBackup(config, oldArchive.archivePath, { force: true });
    assert.equal(wrongRestore.preRestoreSnapshot.skipped, undefined, '恢复前必须自动创建快照。');
    const snapshotPath = wrongRestore.preRestoreSnapshot.archivePath;
    assert.match(path.basename(snapshotPath), new RegExp(`^${PRE_RESTORE_PREFIX}-\\d{8}T\\d{9}Z\\.tar\\.gz$`));
    assert.ok(
      wrongRestore.preRestoreSnapshot.manifest.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256)),
      '恢复前快照必须复用带 SHA-256 校验的清单。',
    );

    // The wrong restore really did roll the live data back.
    const afterWrong = new Database(config.databasePath, { readonly: true });
    try {
      assert.equal(afterWrong.prepare('SELECT title FROM works').get().title, '待恢复作品');
    } finally {
      afterWrong.close();
    }

    // The snapshot brings the pre-restore state back, content included.
    await restoreBackup(config, snapshotPath, { force: true });
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
      restoreBackup(config, externalArchive, { force: true }),
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

    const restored = await restoreBackup(freshConfig, archive.archivePath, { force: true });
    assert.equal(restored.preRestoreSnapshot.skipped, true);
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
