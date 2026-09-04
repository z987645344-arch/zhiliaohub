// Covers scheduled backups, the pluggable secondary destination and the distinction between
// "no database yet" and "a database is there but cannot be read".
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { initializeDatabase } = require('../src/db');
const { ContentService } = require('../src/services/content-service');
const {
  BACKUP_PREFIX,
  PRE_RESTORE_PREFIX,
  SCHEDULED_BACKUP_PREFIX,
  createBackup,
  inspectLiveDatabase,
  pruneBackups,
  restoreBackup,
} = require('../src/services/backup-service');
const { LocalMirrorDestination } = require('../src/services/backup-destination');
const {
  BackupScheduler,
  RETRY_DELAYS_MS,
  nextScheduledAt,
  lastBackupAt,
  parseArchiveTimestamp,
  scheduledBoundaryAtOrBefore,
} = require('../src/services/backup-scheduler');
const { BackupStatusService } = require('../src/services/backup-status-service');

function createConfig(runtimeRoot, overrides = {}) {
  const dataDir = path.join(runtimeRoot, 'data');
  return {
    serverRoot: path.resolve(__dirname, '..'),
    dataDir,
    databasePath: path.join(dataDir, 'admin.sqlite3'),
    contentDir: path.join(runtimeRoot, 'content'),
    uploadsDir: path.join(runtimeRoot, 'uploads'),
    labStorageDir: path.join(runtimeRoot, 'lab-storage'),
    backupDir: path.join(runtimeRoot, 'backups'),
    backupRetentionCount: 3,
    backupExcludeZip: false,
    preRestoreRetentionCount: 3,
    backupEncryptionPassword: '',
    backupMirrorDir: '',
    backupScheduleLocalTime: '00:00',
    contentMaxBytes: 64 * 1024,
    ...overrides,
  };
}

async function restoreWithStoppedService(config, archivePath) {
  const server = http.createServer((request, response) => {
    response.setHeader('Server', 'nginx');
    response.writeHead(request.url === '/health' ? 503 : 404);
    response.end();
  });
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  try {
    return await restoreBackup(
      { ...config, restoreProbeUrl: `http://127.0.0.1:${port}/health` },
      archivePath,
      { force: true, confirmServiceStopped: true },
    );
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
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
      restoreWithStoppedService(targetConfig, archive.archivePath),
      /Restore aborted: .*is not a regular file/,
      '读不出来的当前数据库不得被静默当成空机器。',
    );
    assert.deepEqual(await fs.readdir(targetConfig.databasePath), before, '中止后不得修改任何内容。');
  } finally {
    await fs.rm(sourceRoot, { recursive: true, force: true });
    await fs.rm(targetRoot, { recursive: true, force: true });
  }
});

test('定时备份按UTC+8零点分日：空目录立即备份、同日重启不重复、次日零点再备份', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-schedule-'));
  const config = createConfig(runtimeRoot);
  try {
    await seedStorage(config);
    // 2026-08-11 00:00 UTC is 08:00 at UTC+8. No archive exists, so startup protection
    // must happen immediately instead of waiting until the next local midnight.
    let clock = new Date('2026-08-11T00:00:00.000Z');
    const scheduler = new BackupScheduler(config, { now: () => clock, logger: silentLogger });
    const first = await scheduler.tick();
    assert.equal(first.created, true, '没有任何备份时应立即创建。');
    assert.equal(first.scheduledBoundaryAt.toISOString(), '2026-08-10T16:00:00.000Z');

    // Three independent scheduler instances stand in for three process restarts during the
    // same UTC+8 day. The archive directory is the only shared state.
    for (const instant of [
      '2026-08-11T00:05:00.000Z',
      '2026-08-11T08:00:00.000Z',
      '2026-08-11T15:59:59.999Z',
    ]) {
      clock = new Date(instant);
      const restarted = await new BackupScheduler(config, { now: () => clock, logger: silentLogger }).tick();
      assert.equal(restarted.skipped, true);
      assert.equal(restarted.reason, 'already backed up since scheduled boundary');
    }

    // UTC+8 2026-08-12 00:00 is exactly UTC 2026-08-11 16:00. Crossing this fixed
    // boundary, rather than waiting 24 hours after the 08:00 startup backup, makes it due.
    clock = new Date('2026-08-11T16:00:00.000Z');
    const due = await scheduler.tick();
    assert.equal(due.created, true, 'UTC+8次日零点应创建第二份备份。');
    assert.equal(due.scheduledBoundaryAt.toISOString(), '2026-08-11T16:00:00.000Z');

    const archives = (await fs.readdir(config.backupDir))
      .filter((name) => name.startsWith(`${SCHEDULED_BACKUP_PREFIX}-`))
      .sort();
    assert.deepEqual(archives, [
      'scheduled-backup-20260811T000000000Z.tar.gz',
      'scheduled-backup-20260811T160000000Z.tar.gz',
    ]);

    // The recorded "last backup" really is derived only from the newest scheduled archive.
    assert.equal((await lastBackupAt(config.backupDir)).toISOString(), '2026-08-11T16:00:00.000Z');
    assert.equal(
      parseArchiveTimestamp('scheduled-backup-20260811T000000000Z.tar.gz').toISOString(),
      '2026-08-11T00:00:00.000Z',
    );
    assert.equal(parseArchiveTimestamp('backup-20260811T000000000Z.tar.gz'), null, '手工归档不参与定时判断。');
    assert.equal(parseArchiveTimestamp('pre-restore-20260811T000000000Z.tar.gz'), null, '恢复前快照不参与定时判断。');
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('手工、调度与恢复前三个归档前缀严格互斥', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-prefix-isolation-'));
  const names = {
    manual: 'backup-20260811T000000000Z.tar.gz',
    scheduled: 'scheduled-backup-20260811T000000000Z.tar.gz',
    preRestore: 'pre-restore-20260811T000000000Z.tar.gz',
  };
  try {
    await Promise.all(Object.values(names).map((name) => fs.writeFile(path.join(runtimeRoot, name), name)));

    assert.deepEqual(
      await pruneBackups(runtimeRoot, 0, BACKUP_PREFIX),
      [names.manual],
      'backup池只能匹配手工归档。',
    );
    assert.deepEqual((await fs.readdir(runtimeRoot)).sort(), [names.preRestore, names.scheduled].sort());

    assert.deepEqual(
      await pruneBackups(runtimeRoot, 0, SCHEDULED_BACKUP_PREFIX),
      [names.scheduled],
      'scheduled池只能匹配调度归档。',
    );
    assert.deepEqual(await fs.readdir(runtimeRoot), [names.preRestore], '恢复前快照不应被两个常规池匹配。');
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('当天已有手工归档时仍创建调度归档，已有调度归档时才跳过', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-manual-vs-scheduled-'));
  const config = createConfig(runtimeRoot);
  try {
    await seedStorage(config);
    await createBackup(config, { now: new Date('2026-08-11T00:00:00.000Z') });

    let clock = new Date('2026-08-11T00:05:00.000Z');
    const scheduler = new BackupScheduler(config, { now: () => clock, logger: silentLogger });
    const created = await scheduler.tick();
    assert.equal(created.created, true, '手工归档不得满足当天的调度边界。');
    assert.match(path.basename(created.result.archivePath), /^scheduled-backup-/);

    clock = new Date('2026-08-11T00:06:00.000Z');
    const skipped = await scheduler.tick();
    assert.equal(skipped.skipped, true, '当天已有调度归档时必须去重。');
    assert.equal(skipped.reason, 'already backed up since scheduled boundary');
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('恢复前快照不影响当天的调度判定', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-pre-restore-vs-scheduled-'));
  const config = createConfig(runtimeRoot);
  try {
    await seedStorage(config);
    await createBackup(config, {
      namePrefix: PRE_RESTORE_PREFIX,
      now: new Date('2026-08-11T00:00:00.000Z'),
      retentionCount: config.preRestoreRetentionCount,
    });
    const created = await new BackupScheduler(config, {
      now: () => new Date('2026-08-11T00:05:00.000Z'),
      logger: silentLogger,
    }).tick();
    assert.equal(created.created, true, '恢复前快照不得满足当天的调度边界。');
    assert.match(path.basename(created.result.archivePath), /^scheduled-backup-/);
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('UTC+8的00:00严格映射为UTC前一日16:00，不读取容器本地时区', () => {
  const before = new Date('2026-08-11T15:59:59.999Z');
  const boundary = new Date('2026-08-11T16:00:00.000Z');
  assert.equal(nextScheduledAt(before, '00:00').toISOString(), boundary.toISOString());
  assert.equal(scheduledBoundaryAtOrBefore(boundary, '00:00').toISOString(), boundary.toISOString());
  assert.equal(nextScheduledAt(boundary, '00:00').toISOString(), '2026-08-12T16:00:00.000Z');

  let actualDelay = null;
  let cleared = false;
  const timerHandle = { unref() {} };
  const scheduler = new BackupScheduler({
    backupDir: 'unused-in-this-clock-only-test',
    backupScheduleLocalTime: '00:00',
  }, {
    now: () => before,
    logger: silentLogger,
    setTimeout: (_callback, delay) => {
      actualDelay = delay;
      return timerHandle;
    },
    clearTimeout: (handle) => { cleared = handle === timerHandle; },
  });
  assert.equal(scheduler.scheduleNext().toISOString(), boundary.toISOString());
  assert.equal(actualDelay, 1, '运行时计时器应瞄准UTC 16:00，而不是容器本地零点。');
  scheduler.stop();
  assert.equal(cleared, true);
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

test('定时备份失败会在同一调度周期按固定退避重试，成功后连续失败计数归零', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-schedule-retry-'));
  const config = createConfig(runtimeRoot);
  const waits = [];
  const errors = [];
  let attempt = 0;
  try {
    await seedStorage(config);
    const scheduler = new BackupScheduler(config, {
      now: () => new Date('2026-08-11T00:00:00.000Z'),
      logger: { log() {}, error: (message) => errors.push(message) },
      wait: async (delay) => { waits.push(delay); return true; },
      createBackup: async () => {
        attempt += 1;
        if (attempt <= 2 || attempt === 4) throw new Error(`attempt-${attempt}-failed`);
        return { archivePath: `scheduled-attempt-${attempt}.tar.gz` };
      },
    });

    const recovered = await scheduler.runDueCycle();
    assert.equal(recovered.created, true);
    assert.equal(recovered.attempts, 3, '首次尝试加两次自动重试后成功。');
    assert.deepEqual(waits, RETRY_DELAYS_MS);
    assert.equal(scheduler.failureCount, 0, '成功后连续失败计数必须清零。');

    const failedAgain = await scheduler.tick();
    assert.equal(failedAgain.failed, true);
    assert.equal(scheduler.failureCount, 1);
    assert.match(errors.at(-1), /连续第1次/, '成功后的下一次失败必须重新从1计数。');
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('持续失败只尝试三次，耗尽后才排到下一调度边界且不会无限重试', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-schedule-exhaust-'));
  const config = createConfig(runtimeRoot);
  const waits = [];
  const scheduledDelays = [];
  let attempts = 0;
  const clock = new Date('2026-08-11T00:00:00.000Z');
  try {
    await seedStorage(config);
    const scheduler = new BackupScheduler(config, {
      now: () => clock,
      logger: silentLogger,
      wait: async (delay) => { waits.push(delay); return true; },
      setTimeout: (_callback, delay) => {
        scheduledDelays.push(delay);
        return { unref() {} };
      },
      clearTimeout() {},
      createBackup: async () => {
        attempts += 1;
        throw new Error('persistent failure');
      },
    });

    const result = await scheduler.runAndSchedule();
    assert.equal(result.failed, true);
    assert.equal(result.retriesExhausted, true);
    assert.equal(result.attempts, 3);
    assert.equal(attempts, 3);
    assert.deepEqual(waits, RETRY_DELAYS_MS);
    assert.deepEqual(
      scheduledDelays,
      [nextScheduledAt(clock, '00:00').getTime() - clock.getTime()],
      '重试预算耗尽后才应设置下一日主计时器。',
    );
    scheduler.stop();
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('重试等待会跨过下一调度边界时停止本周期重试', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-schedule-budget-'));
  const config = createConfig(runtimeRoot);
  let attempts = 0;
  let waits = 0;
  try {
    await seedStorage(config);
    const scheduler = new BackupScheduler(config, {
      now: () => new Date('2026-08-11T15:56:00.000Z'),
      logger: silentLogger,
      wait: async () => { waits += 1; return true; },
      createBackup: async () => {
        attempts += 1;
        throw new Error('near-boundary failure');
      },
    });
    const result = await scheduler.runDueCycle();
    assert.equal(result.retriesExhausted, true);
    assert.equal(result.attempts, 1);
    assert.equal(attempts, 1);
    assert.equal(waits, 0, '不得启动会跨过UTC+8下一调度边界的等待。');
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('进程错过调度边界后启动仍会立即补做当日备份', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-schedule-boot-catchup-'));
  const config = createConfig(runtimeRoot);
  let created = 0;
  try {
    await seedStorage(config);
    await fs.mkdir(config.backupDir, { recursive: true });
    await fs.writeFile(
      path.join(config.backupDir, 'scheduled-backup-20260810T160000000Z.tar.gz'),
      'previous-day',
    );
    const scheduler = new BackupScheduler(config, {
      now: () => new Date('2026-08-11T17:00:00.000Z'),
      logger: silentLogger,
      setTimeout: () => ({ unref() {} }),
      clearTimeout() {},
      createBackup: async () => {
        created += 1;
        return { archivePath: 'startup-catchup.tar.gz' };
      },
    }).start();
    const result = await scheduler.runPromise;
    assert.equal(result.created, true);
    assert.equal(created, 1, 'start()必须立即执行缺失调度备份，不能只排到明天。');
    scheduler.stop();
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('调度备份状态区分正常、已超期与从未成功，且阈值可配置', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-backup-status-'));
  const backupDir = path.join(runtimeRoot, 'backups');
  const now = new Date('2026-09-04T12:00:00.000Z');
  try {
    await fs.mkdir(backupDir, { recursive: true });
    const never = await new BackupStatusService({
      backupDir,
      backupStatusOverdueMs: 30 * 60 * 60 * 1000,
    }, { now: () => now }).getStatus();
    assert.deepEqual(never, {
      status: 'never',
      label: '从未成功过',
      description: '尚未发现成功的调度备份。',
      lastSuccessfulAt: null,
    });

    await fs.writeFile(
      path.join(backupDir, 'scheduled-backup-20260904T100000000Z.tar.gz'),
      'status-proof',
    );
    const normal = await new BackupStatusService({
      backupDir,
      backupStatusOverdueMs: 30 * 60 * 60 * 1000,
    }, { now: () => now }).getStatus();
    assert.equal(normal.status, 'normal');
    assert.equal(normal.label, '正常');
    assert.equal(normal.description, '最近一次调度备份成功于2小时前。');

    const overdue = await new BackupStatusService({
      backupDir,
      backupStatusOverdueMs: 60 * 60 * 1000,
    }, { now: () => now }).getStatus();
    assert.equal(overdue.status, 'overdue', '缩短配置阈值后，同一归档应变为超期。');
    assert.equal(overdue.label, '已超期');
    assert.equal(overdue.lastSuccessfulAt, '2026-09-04T10:00:00.000Z');
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

    const restored = await restoreWithStoppedService(config, mirrored);
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
    await restoreWithStoppedService(config, backup.archivePath);
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

test('本地与模拟异地目录的手工、调度、恢复前三个池各自独立轮转', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-mirror-prune-'));
  const mirrorDir = path.join(runtimeRoot, 'offsite-simulation');
  const config = createConfig(runtimeRoot, { backupMirrorDir: mirrorDir });
  const namesFor = async (directory, prefix) => (await fs.readdir(directory))
    .filter((name) => name.startsWith(`${prefix}-`))
    .sort();
  try {
    await seedStorage(config);

    // Seed the scheduled pool, then run N+1 manual backups. Manual pruning must not
    // reduce the scheduled pool in either the primary or mirror destination.
    await createBackup(config, {
      namePrefix: SCHEDULED_BACKUP_PREFIX,
      now: new Date('2026-08-11T04:00:00.000Z'),
    });
    for (const millisecond of [1, 2, 3, 4]) {
      await createBackup(config, {
        now: new Date(`2026-08-11T04:00:00.00${millisecond}Z`),
      });
    }
    for (const directory of [config.backupDir, mirrorDir]) {
      assert.equal((await namesFor(directory, SCHEDULED_BACKUP_PREFIX)).length, 1);
      assert.deepEqual(await namesFor(directory, BACKUP_PREFIX), [
        'backup-20260811T040000002Z.tar.gz',
        'backup-20260811T040000003Z.tar.gz',
        'backup-20260811T040000004Z.tar.gz',
      ]);
    }

    // Now run N+1 scheduled backups. The three retained manual archives must survive.
    for (const millisecond of [1, 2, 3, 4]) {
      await createBackup(config, {
        namePrefix: SCHEDULED_BACKUP_PREFIX,
        now: new Date(`2026-08-11T05:00:00.00${millisecond}Z`),
      });
    }
    for (const directory of [config.backupDir, mirrorDir]) {
      assert.equal((await namesFor(directory, BACKUP_PREFIX)).length, 3);
      assert.deepEqual(await namesFor(directory, SCHEDULED_BACKUP_PREFIX), [
        'scheduled-backup-20260811T050000002Z.tar.gz',
        'scheduled-backup-20260811T050000003Z.tar.gz',
        'scheduled-backup-20260811T050000004Z.tar.gz',
      ]);
    }

    // The pre-restore lineage keeps its own configured count and cannot evict either
    // regular lineage, locally or in the mirrored destination.
    for (const millisecond of [1, 2, 3, 4]) {
      await createBackup(config, {
        namePrefix: PRE_RESTORE_PREFIX,
        now: new Date(`2026-08-11T06:00:00.00${millisecond}Z`),
        retentionCount: config.preRestoreRetentionCount,
      });
    }
    for (const directory of [config.backupDir, mirrorDir]) {
      assert.equal((await namesFor(directory, BACKUP_PREFIX)).length, 3);
      assert.equal((await namesFor(directory, SCHEDULED_BACKUP_PREFIX)).length, 3);
      assert.deepEqual(await namesFor(directory, PRE_RESTORE_PREFIX), [
        'pre-restore-20260811T060000002Z.tar.gz',
        'pre-restore-20260811T060000003Z.tar.gz',
        'pre-restore-20260811T060000004Z.tar.gz',
      ]);
    }

    assert.deepEqual(
      (await fs.readdir(config.backupDir)).sort(),
      (await fs.readdir(mirrorDir)).sort(),
      '本地与镜像目录的三个归档池应保持一致。',
    );
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
