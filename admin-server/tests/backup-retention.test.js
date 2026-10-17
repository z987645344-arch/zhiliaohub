const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { RETENTION_POOLS, RETENTION_STATE_FILE, loadRetentionConfig, pruneBackups,
  retentionForPool, sweepArchiveRetention } = require('../src/services/backup-retention');
const { BackupScheduler, lastBackupAt, scheduledBoundaryAtOrBefore } = require('../src/services/backup-scheduler');
const { archiveTimestamp } = require('../src/services/backup-service');

const DAY = 86400000;
const now = new Date('2026-10-17T04:00:00.000Z');
const logger = { log() {}, error() {} };
const filename = (prefix, age, encrypted = false) => `${prefix}-${archiveTimestamp(new Date(now.getTime() - age * DAY))}.tar.gz${encrypted ? '.enc' : ''}`;
async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-retention-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function seed(directory, prefix, ages) {
  await fs.mkdir(directory, { recursive: true });
  for (const age of ages) await fs.writeFile(path.join(directory, filename(prefix, age, age % 2 === 0)), 'unparsed archive');
}
const forPool = async (directory, prefix) => (await fs.readdir(directory))
  .filter((name) => name.startsWith(`${prefix}-`)).sort();

test('四池八个环境变量独立解析，天数须正整数、保底允许0且默认各自正确', () => {
  const defaults = loadRetentionConfig({}, {});
  assert.equal(loadRetentionConfig({}, { SCHEDULED_BACKUP_MIN_COUNT: '  ' }).scheduledBackupMinCount, 3);
  assert.deepEqual(loadRetentionConfig({}, { BACKUP_RETENTION_COUNT: '99', PRE_RESTORE_RETENTION_COUNT: '99' }), defaults);
  assert.deepEqual(RETENTION_POOLS.map((pool) => retentionForPool(defaults, pool.prefix)), [
    { retentionDays: 3, minCount: 3 }, { retentionDays: 3, minCount: 0 },
    { retentionDays: 3, minCount: 0 }, { retentionDays: 3, minCount: 0 },
  ]);
  RETENTION_POOLS.forEach((pool, index) => {
    const environment = { [`${pool.env}_RETENTION_DAYS`]: String(index + 5), [`${pool.env}_MIN_COUNT`]: String(index) };
    const config = loadRetentionConfig({}, environment);
    assert.deepEqual(retentionForPool(config, pool.prefix), { retentionDays: index + 5, minCount: index });
    assert.throws(() => loadRetentionConfig({}, { [`${pool.env}_RETENTION_DAYS`]: '0' }), /positive integer/);
    assert.throws(() => loadRetentionConfig({}, { [`${pool.env}_MIN_COUNT`]: '-1' }), /non-negative integer/);
    assert.throws(() => loadRetentionConfig({}, { [`${pool.env}_RETENTION_DAYS`]: '1.5' }), /positive integer/);
  });
});

test('默认四池过期与保底取交集，旧全量哨兵不解析，镜像同样独立清扫', async (t) => {
  const root = await temp(t);
  const config = { backupDir: path.join(root, 'backups'), backupMirrorDir: path.join(root, 'mirror') };
  for (const directory of [config.backupDir, config.backupMirrorDir]) {
    for (const pool of RETENTION_POOLS) await seed(directory, pool.prefix, [4, 5, 6, 7]);
  }
  const result = await sweepArchiveRetention(config, { now, boundary: scheduledBoundaryAtOrBefore(now) });
  assert.equal(result.status, 'ok');
  assert.equal(result.results.length, 8);
  for (const directory of [config.backupDir, config.backupMirrorDir]) {
    for (const pool of RETENTION_POOLS) {
      const retained = await forPool(directory, pool.prefix);
      assert.equal(retained.length, pool.minCount);
      assert.deepEqual(retained, [4, 5, 6, 7].slice(0, pool.minCount)
        .map((age) => filename(pool.prefix, age, age % 2 === 0)).sort());
    }
  }
  const persisted = JSON.parse(await fs.readFile(path.join(config.backupDir, RETENTION_STATE_FILE), 'utf8'));
  assert.deepEqual(persisted, result);
});

test('四池自定义保留天数与份数都生效，未过期数量可超过保底且恰好到期不删', async (t) => {
  const directory = await temp(t);
  for (const [index, pool] of RETENTION_POOLS.entries()) {
    const retentionDays = index + 1;
    await seed(directory, pool.prefix, [0, retentionDays, retentionDays + 1, retentionDays + 2]);
    const removed = await pruneBackups(directory, { retentionDays, minCount: 3 }, pool.prefix, now);
    assert.deepEqual(removed, [filename(pool.prefix, retentionDays + 2, (retentionDays + 2) % 2 === 0)]);
    assert.equal((await forPool(directory, pool.prefix)).length, 3);
    // Lowering the floor does not make current/unexpired archives eligible.
    await pruneBackups(directory, { retentionDays, minCount: 0 }, pool.prefix, now);
    assert.deepEqual(await forPool(directory, pool.prefix), [filename(pool.prefix, 0, true),
      filename(pool.prefix, retentionDays, retentionDays % 2 === 0)].sort());
  }
});

test('手工池4天无写入也清零，不能靠再创建新包触发', async (t) => {
  const directory = await temp(t);
  await seed(directory, 'backup', [4]);
  const config = { backupDir: directory };
  await sweepArchiveRetention(config, { now, boundary: scheduledBoundaryAtOrBefore(now) });
  assert.deepEqual(await forPool(directory, 'backup'), []);
});

test('连续10天没有新调度包，每日清扫仍保留最新3份且调度器时间可读', async (t) => {
  const directory = await temp(t);
  await seed(directory, 'scheduled-backup', [1, 2, 3, 4, 5]);
  const expectedLast = new Date(now.getTime() - DAY).toISOString();
  for (let day = 1; day <= 10; day++) {
    const clock = new Date(now.getTime() + day * DAY);
    await sweepArchiveRetention({ backupDir: directory }, { now: clock, boundary: scheduledBoundaryAtOrBefore(clock) });
    assert.equal((await forPool(directory, 'scheduled-backup')).length, 3);
    assert.equal((await lastBackupAt(directory)).toISOString(), expectedLast);
  }
});

test('当日备份持续失败且耗尽重试时四池照常清扫，但不触发上传孤儿删除', async (t) => {
  const directory = await temp(t);
  for (const pool of RETENTION_POOLS) await seed(directory, pool.prefix, [4, 5, 6, 7]);
  let attempts = 0;
  let orphanCalls = 0;
  let nextTimer = 0;
  const scheduler = new BackupScheduler({ backupDir: directory }, {
    now: () => now, logger, wait: async () => true,
    createBackup: async () => { attempts++; throw new Error('simulated backup failure'); },
    cleanupOrphanUploads: async () => { orphanCalls++; },
    setTimeout: () => { nextTimer++; return { unref() {} }; }, clearTimeout() {},
  });
  t.after(() => scheduler.stop());
  const result = await scheduler.runAndSchedule();
  assert.equal(result.failed, true);
  assert.equal(result.attempts, 3);
  assert.equal(attempts, 3);
  assert.equal(orphanCalls, 0);
  assert.equal(result.retentionCleanup.status, 'ok');
  assert.equal(nextTimer, 1);
  for (const pool of RETENTION_POOLS) assert.equal((await forPool(directory, pool.prefix)).length, pool.minCount);
});

test('每日清扫状态重启不丢，同边界不重复，已有当日备份时仍能清扫其它池', async (t) => {
  const directory = await temp(t);
  await seed(directory, 'backup', [4]);
  await seed(directory, 'scheduled-backup', [0]);
  const config = { backupDir: directory };
  const options = { now: () => now, logger, createBackup: async () => assert.fail('不得重复备份'),
    setTimeout: () => ({ unref() {} }), clearTimeout() {} };
  const first = new BackupScheduler(config, options);
  const second = new BackupScheduler(config, options);
  t.after(() => { first.stop(); second.stop(); });
  assert.equal((await first.runAndSchedule()).retentionCleanup.status, 'ok');
  assert.deepEqual(await forPool(directory, 'backup'), []);
  assert.equal((await second.runAndSchedule()).retentionCleanup.skipped, true);
});

test('关闭备份创建仍启动每日归档维护，清扫失败不阻断下一日调度', async (t) => {
  const directory = await temp(t);
  await seed(directory, 'backup', [4]);
  const mirror = path.join(directory, 'unreadable-mirror');
  await fs.writeFile(mirror, 'not a directory');
  let timers = 0;
  const scheduler = new BackupScheduler({ backupDir: directory, backupMirrorDir: mirror, backupScheduleEnabled: false }, {
    now: () => now, logger, createBackup: () => assert.fail('已关闭的备份不得创建'),
    setTimeout: () => { timers++; return { unref() {} }; }, clearTimeout() {},
  }).start();
  t.after(() => scheduler.stop());
  const result = await scheduler.runPromise;
  assert.equal(result.skipped, true);
  assert.equal(result.retentionCleanup.status, 'error');
  assert.equal(result.retentionCleanup.results.filter((pool) => pool.status === 'error').length, 4);
  assert.equal(timers, 1);
  assert.deepEqual(await forPool(directory, 'backup'), []);
});

test('未知前缀/非法配置拒绝删除，目录、临时文件、无效日期与普通文件均不匹配', async (t) => {
  const directory = await temp(t);
  const names = ['backup-20261301T000000000Z.tar.gz', '.backup-temporary.tar.gz', 'notes.txt',
    'other-20260101T000000000Z.tar.gz'];
  for (const name of names) await fs.writeFile(path.join(directory, name), name);
  await fs.mkdir(path.join(directory, 'backup-20260101T000000000Z.tar.gz'));
  await assert.rejects(pruneBackups(directory, { retentionDays: 3, minCount: 0 }, '.*', now), /Unknown/);
  await assert.rejects(pruneBackups(directory, { retentionDays: -1, minCount: 0 }, 'backup', now), /positive/);
  assert.deepEqual(await pruneBackups(directory, { retentionDays: 3, minCount: 0 }, 'backup', now), []);
  for (const name of names) assert.equal(await fs.readFile(path.join(directory, name), 'utf8'), name);
});

test('某池删到一半失败仍记录已删文件，并继续清扫其它池而不虚报成功', async (t) => {
  const directory = await temp(t);
  await seed(directory, 'scheduled-backup', [4, 5, 6, 7, 8]);
  await seed(directory, 'backup', [4]);
  const blockedName = filename('scheduled-backup', 8, true);
  const originalUnlink = fs.unlink;
  const unlink = t.mock.method(fs, 'unlink', async (file) => {
    if (path.basename(file) === blockedName) throw Object.assign(new Error('simulated permission failure'), { code: 'EACCES' });
    return originalUnlink(file);
  });
  try {
    const state = await sweepArchiveRetention({ backupDir: directory }, { now, boundary: scheduledBoundaryAtOrBefore(now) });
    assert.equal(state.status, 'error');
    const scheduled = state.results.find((pool) => pool.prefix === 'scheduled-backup');
    assert.equal(scheduled.status, 'error');
    assert.deepEqual(scheduled.removed, [filename('scheduled-backup', 7)]);
    assert.equal((await forPool(directory, 'scheduled-backup')).length, 4);
    assert.deepEqual(await forPool(directory, 'backup'), []);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, RETENTION_STATE_FILE), 'utf8')), state);
  } finally {
    unlink.mock.restore();
  }
});
