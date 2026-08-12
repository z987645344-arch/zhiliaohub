// Covers scheduled backups, the pluggable secondary destination and the distinction between
// "no database yet" and "a database is there but cannot be read".
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { initializeDatabase } = require('../src/db');
const { ContentService } = require('../src/services/content-service');
const {
  createBackup,
  inspectLiveDatabase,
  restoreBackup,
} = require('../src/services/backup-service');
const { LocalMirrorDestination } = require('../src/services/backup-destination');
const { BackupScheduler, lastBackupAt, parseArchiveTimestamp } = require('../src/services/backup-scheduler');

function createConfig(runtimeRoot, overrides = {}) {
  const dataDir = path.join(runtimeRoot, 'data');
  return {
    serverRoot: path.resolve(__dirname, '..'),
    dataDir,
    databasePath: path.join(dataDir, 'admin.sqlite3'),
    contentDir: path.join(runtimeRoot, 'content'),
    uploadsDir: path.join(runtimeRoot, 'uploads'),
    backupDir: path.join(runtimeRoot, 'backups'),
    backupRetentionCount: 7,
    preRestoreRetentionCount: 3,
    backupEncryptionPassword: '',
    backupMirrorDir: '',
    contentMaxBytes: 64 * 1024,
    ...overrides,
  };
}

async function seedStorage(config, title = '定时备份验证作品') {
  const database = initializeDatabase(config);
  const contentService = new ContentService(database, config);
  const work = await contentService.createWork({
    title,
    workDate: '2026-08-11',
    category: '程序',
    summary: '用于自动化备份验证。',
    detailIntro: '用于自动化备份验证。',
    body: `# ${title}\n\nSCHEDULED_BACKUP_MARKER`,
  });
  await fs.writeFile(path.join(config.uploadsDir, 'proof.txt'), 'scheduled-upload\n', 'utf8');
  database.close();
  return work;
}

const silentLogger = { log() {}, error() {} };

test('数据库文件确实不存在与存在但读不出来会被区分处理', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-db-probe-'));
  try {
    // Genuinely absent: safe to report as "nothing to protect".
    assert.deepEqual(await inspectLiveDatabase(path.join(runtimeRoot, 'missing.sqlite3')), { exists: false });

    // Present but not a regular file: must not be mistaken for an empty machine.
    const directoryPath = path.join(runtimeRoot, 'admin.sqlite3');
    await fs.mkdir(directoryPath);
    await assert.rejects(
      inspectLiveDatabase(directoryPath),
      /exists but is not a regular file/,
    );

    // Any non-ENOENT failure must surface instead of being swallowed into exists:false.
    // A NUL byte in the path makes fs.stat fail with ERR_INVALID_ARG_VALUE instead of
    // ENOENT, which stands in for "something is there but the OS cannot describe it".
    // The escape sequence is written out deliberately: a literal NUL byte in the source
    // is invisible in most editors and reads as an ordinary space.
    const unreadablePath = path.join(runtimeRoot, `unreadable${String.fromCharCode(0)}name.sqlite3`);
    await assert.rejects(
      inspectLiveDatabase(unreadablePath),
      /exists but could not be inspected/,
    );
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('数据库存在但无法读取时恢复中止，不会被当成全新机器静默覆盖', async () => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-unreadable-source-'));
  const targetRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-unreadable-target-'));
  const sourceConfig = createConfig(sourceRoot);
  const targetConfig = createConfig(targetRoot);
  try {
    await seedStorage(sourceConfig);
    const archive = await createBackup(sourceConfig, { now: new Date('2026-08-11T01:00:00.000Z') });

    // A directory sitting where the database file belongs stands in for "something is here
    // but it cannot be read as a database".
    await fs.mkdir(targetConfig.dataDir, { recursive: true });
    await fs.mkdir(targetConfig.databasePath);
    const before = await fs.readdir(targetConfig.databasePath);

    await assert.rejects(
      restoreBackup(targetConfig, archive.archivePath, { force: true }),
      /Restore aborted: .*is not a regular file/,
      '读不出来的当前数据库不得被静默当成空机器。',
    );
    assert.deepEqual(await fs.readdir(targetConfig.databasePath), before, '中止后不得修改任何内容。');
  } finally {
    await fs.rm(sourceRoot, { recursive: true, force: true });
    await fs.rm(targetRoot, { recursive: true, force: true });
  }
});

test('定时备份在到期时触发、未到期时跳过，重启后不会重复也不会漏掉', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-schedule-'));
  const config = createConfig(runtimeRoot, {
    backupIntervalMs: 24 * 60 * 60 * 1000,
    backupScheduleCheckIntervalMs: 60 * 1000,
  });
  try {
    await seedStorage(config);
    let clock = new Date('2026-08-11T00:00:00.000Z');
    const scheduler = new BackupScheduler(config, { now: () => clock, logger: silentLogger });

    // First ever run: no archive exists, so one is taken immediately.
    const first = await scheduler.tick();
    assert.equal(first.created, true, '没有任何备份时应立即创建。');

    // A restart right afterwards must not produce a second archive.
    clock = new Date('2026-08-11T00:05:00.000Z');
    const afterRestart = await new BackupScheduler(config, { now: () => clock, logger: silentLogger }).tick();
    assert.equal(afterRestart.created, undefined);
    assert.equal(afterRestart.skipped, true);
    assert.equal(afterRestart.reason, 'not due yet');

    // Once a full interval has passed, the next check backs up again.
    clock = new Date('2026-08-12T00:00:01.000Z');
    const due = await scheduler.tick();
    assert.equal(due.created, true, '超过一个周期后应再次备份。');

    // A restart after a long outage notices the overdue backup at boot rather than waiting.
    clock = new Date('2026-08-20T00:00:00.000Z');
    const afterOutage = await new BackupScheduler(config, { now: () => clock, logger: silentLogger }).tick();
    assert.equal(afterOutage.created, true, '长时间停机后重启应立即补一次备份。');

    const archives = (await fs.readdir(config.backupDir)).filter((name) => name.startsWith('backup-'));
    assert.equal(archives.length, 3, `应恰好产生3份归档，实际：${archives.join(', ')}`);

    // The recorded "last backup" really is derived from the newest archive on disk.
    assert.equal((await lastBackupAt(config.backupDir)).toISOString(), '2026-08-20T00:00:00.000Z');
    assert.equal(parseArchiveTimestamp('backup-20260811T000000000Z.tar.gz').toISOString(), '2026-08-11T00:00:00.000Z');
    assert.equal(parseArchiveTimestamp('pre-restore-20260811T000000000Z.tar.gz'), null, '恢复前快照不参与定时判断。');
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('定时备份失败时记录明确日志且不抛出，不会静默失败', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-schedule-fail-'));
  const config = createConfig(runtimeRoot);
  const messages = [];
  try {
    await seedStorage(config);
    const scheduler = new BackupScheduler(config, {
      logger: { log() {}, error: (message) => messages.push(message) },
      createBackup: async () => { throw new Error('no space left on device'); },
    });

    const result = await scheduler.tick();
    assert.equal(result.failed, true, 'tick 不得抛出，必须返回失败结果。');
    assert.equal(scheduler.failureCount, 1);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /定时备份失败/);
    assert.match(messages[0], /no space left on device/);
    assert.match(messages[0], /现在没有产生新的备份/, '日志必须说明当前没有新备份。');
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('备份生成后被复制到模拟异地目录，且该副本可独立完成恢复', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-mirror-'));
  const mirrorDir = path.join(runtimeRoot, 'offsite-simulation');
  const config = createConfig(runtimeRoot, { backupMirrorDir: mirrorDir });
  try {
    const work = await seedStorage(config, '异地副本验证作品');
    const backup = await createBackup(config, { now: new Date('2026-08-11T02:00:00.000Z') });

    assert.equal(backup.replication.ok, true);
    assert.equal(backup.replication.destination, 'local-mirror');
    const mirrored = path.join(mirrorDir, path.basename(backup.archivePath));
    assert.equal(backup.replication.location, mirrored);
    assert.equal(
      (await fs.stat(mirrored)).size,
      (await fs.stat(backup.archivePath)).size,
      '副本必须与本地归档大小一致。',
    );

    // Simulate losing the entire local backup directory, then recover from the mirror alone.
    await fs.rm(config.backupDir, { recursive: true, force: true });
    const database = new Database(config.databasePath);
    database.exec('DELETE FROM works;');
    database.close();
    await fs.rm(path.join(config.contentDir, 'works'), { recursive: true, force: true });

    const restored = await restoreBackup(config, mirrored, { force: true });
    assert.ok(restored.manifest.createdAt);
    const recovered = new Database(config.databasePath, { readonly: true });
    try {
      assert.equal(recovered.prepare('SELECT title FROM works').get().title, '异地副本验证作品');
    } finally {
      recovered.close();
    }
    assert.match(
      await fs.readFile(path.join(config.contentDir, ...work.markdown_path.split('/')), 'utf8'),
      /SCHEDULED_BACKUP_MARKER/,
    );
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('副本同步失败不影响本地备份本身，也不会让备份整体失败', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-mirror-fail-'));
  // A regular file where the mirror directory must be makes every send() fail.
  const mirrorDir = path.join(runtimeRoot, 'unusable-mirror');
  const config = createConfig(runtimeRoot, { backupMirrorDir: mirrorDir });
  const originalError = console.error;
  const messages = [];
  console.error = (message) => messages.push(message);
  try {
    await seedStorage(config, '同步失败验证作品');
    await fs.writeFile(mirrorDir, 'not-a-directory', 'utf8');

    const backup = await createBackup(config, { now: new Date('2026-08-11T03:00:00.000Z') });
    assert.equal(backup.replication.ok, false, '同步失败必须如实报告。');
    assert.ok(backup.replication.error);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /本地归档已生成成功/);
    assert.match(messages[0], /本地备份不受影响/);

    // The local archive must still be complete and fully usable.
    assert.ok((await fs.stat(backup.archivePath)).size > 0);
    const database = new Database(config.databasePath);
    database.exec('DELETE FROM works;');
    database.close();
    await restoreBackup(config, backup.archivePath, { force: true });
    const recovered = new Database(config.databasePath, { readonly: true });
    try {
      assert.equal(recovered.prepare('SELECT title FROM works').get().title, '同步失败验证作品');
    } finally {
      recovered.close();
    }
  } finally {
    console.error = originalError;
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('模拟异地目录按同一保留策略清理，不会无限增长', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-mirror-prune-'));
  const mirrorDir = path.join(runtimeRoot, 'offsite-simulation');
  const config = createConfig(runtimeRoot, { backupMirrorDir: mirrorDir });
  try {
    await seedStorage(config);
    for (const millisecond of [1, 2, 3, 4]) {
      await createBackup(config, {
        now: new Date(`2026-08-11T04:00:00.00${millisecond}Z`),
        retentionCount: 2,
      });
    }
    const mirrored = (await fs.readdir(mirrorDir)).sort();
    assert.deepEqual(mirrored, [
      'backup-20260811T040000003Z.tar.gz',
      'backup-20260811T040000004Z.tar.gz',
    ]);
    const local = (await fs.readdir(config.backupDir)).filter((name) => name.startsWith('backup-')).sort();
    assert.deepEqual(local, mirrored, '副本目录应与本地保持一致。');
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('LocalMirrorDestination 不修改也不删除传入的本地归档', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-mirror-contract-'));
  try {
    const source = path.join(runtimeRoot, 'backup-20260811T050000000Z.tar.gz');
    await fs.writeFile(source, 'archive-bytes', 'utf8');
    const destination = new LocalMirrorDestination(path.join(runtimeRoot, 'mirror'));
    const { location } = await destination.send(source);

    assert.equal(await fs.readFile(source, 'utf8'), 'archive-bytes', '本地归档内容不得被改动。');
    assert.equal(await fs.readFile(location, 'utf8'), 'archive-bytes');
    // No partial staging files may survive a successful send.
    assert.deepEqual(
      (await fs.readdir(path.join(runtimeRoot, 'mirror'))).filter((name) => name.startsWith('.partial-')),
      [],
    );
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});
