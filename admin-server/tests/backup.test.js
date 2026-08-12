// Proves backup integrity, encrypted restore, destructive recovery and retention cleanup.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { initializeDatabase } = require('../src/db');
const { ContentService } = require('../src/services/content-service');
const {
  PRE_RESTORE_PREFIX,
  createBackup,
  restoreBackup,
} = require('../src/services/backup-service');

function createConfig(runtimeRoot) {
  const dataDir = path.join(runtimeRoot, 'data');
  return {
    serverRoot: path.resolve(__dirname, '..'),
    dataDir,
    databasePath: path.join(dataDir, 'admin.sqlite3'),
    contentDir: path.join(runtimeRoot, 'content'),
    uploadsDir: path.join(runtimeRoot, 'uploads'),
    backupDir: path.join(runtimeRoot, 'backups'),
    backupRetentionCount: 7,
    backupEncryptionPassword: '',
    contentMaxBytes: 64 * 1024,
  };
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

test('备份保留策略只保留最近 N 份归档', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-backup-retention-'));
  const config = createConfig(runtimeRoot);
  try {
    await seedStorage(config);
    const dates = [
      new Date('2026-08-04T01:00:00.001Z'),
      new Date('2026-08-04T01:00:00.002Z'),
      new Date('2026-08-04T01:00:00.003Z'),
    ];
    for (const now of dates) await createBackup(config, { now, retentionCount: 2 });
    const archives = (await fs.readdir(config.backupDir)).filter((name) => name.startsWith('backup-')).sort();
    assert.deepEqual(archives, [
      'backup-20260804T010000002Z.tar.gz',
      'backup-20260804T010000003Z.tar.gz',
    ]);
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});
