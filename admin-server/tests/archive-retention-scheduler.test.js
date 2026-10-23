const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { BackupScheduler } = require('../src/services/backup-scheduler');
const { ArchiveRetentionScheduler, RETENTION_RETRY_MS } = require('../src/services/archive-retention-scheduler');
const { scheduledBoundaryAtOrBefore } = require('../src/services/backup-schedule-clock');
const { RETENTION_STATE_FILE, RETENTION_SCHEDULE_VERSION, sweepArchiveRetention } = require('../src/services/backup-retention');

const gate = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const logger = { log() {}, error() {} };
const ok = () => ({ status: 'ok', results: [] });

function clock(iso) {
  let now = new Date(iso);
  let id = 0;
  const timers = new Map();
  return { timers, now: () => now,
    setTimeout(fn, delay) {
      const handle = { id: ++id, at: new Date(now.getTime() + delay), fn, unref() {} };
      timers.set(handle.id, handle);
      return handle;
    },
    clearTimeout(handle) { timers.delete(handle.id); },
    fire(when) {
      now = new Date(when);
      const due = [...timers.values()].filter((timer) => timer.at <= now).sort((a, b) => a.at - b.at);
      for (const timer of due) { timers.delete(timer.id); timer.fn(); }
    },
    set(when) { now = new Date(when); },
  };
}
async function configFor(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-0030-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { backupDir: root };
}
function options(time, overrides = {}) {
  return { ...time, logger, sweepArchiveRetention: async () => ok(),
    createBackup: async () => ({ archivePath: 'test-backup' }),
    cleanupOrphanUploads: async () => ({ deleted: [], uncovered: [] }),
    persistOrphanCleanupResult: () => ({ lastRunAt: time.now().toISOString() }), ...overrides };
}

test('正常运行有00:00与00:30两个计时器，午夜备份回调不附带清扫', async (t) => {
  const config = await configFor(t);
  const time = clock('2026-10-22T23:59:00+08:00');
  let backups = 0;
  let sweeps = 0;
  const scheduler = new BackupScheduler(config, options(time, {
    createBackup: async () => { backups++; return { archivePath: 'backup' }; },
    sweepArchiveRetention: async () => { sweeps++; return ok(); },
  })).start();
  t.after(() => scheduler.stop());
  await Promise.all([scheduler.runPromise, scheduler.retentionScheduler.runPromise]);
  assert.deepEqual([...time.timers.values()].map((timer) => timer.at.toISOString()).sort(),
    ['2026-10-22T16:00:00.000Z', '2026-10-22T16:30:00.000Z']);
  const initialSweeps = sweeps;
  time.fire('2026-10-23T00:00:00+08:00');
  await scheduler.runPromise;
  assert.equal(backups, 2);
  assert.equal(sweeps, initialSweeps);
  time.fire('2026-10-23T00:30:00+08:00');
  await scheduler.retentionScheduler.runPromise;
  assert.equal(sweeps, initialSweeps + 1);
});

for (const mode of ['disabled', 'failed', 'retry-wait', 'unfinished']) {
  test(`备份${mode}时00:30清扫仍独立触发`, async (t) => {
    const config = { ...await configFor(t), backupScheduleEnabled: mode !== 'disabled' };
    const time = clock('2026-10-22T23:59:00+08:00');
    const backupGate = gate();
    const retryGate = gate();
    const entered = gate();
    let armed = false;
    let sweeps = 0;
    const scheduler = new BackupScheduler(config, options(time, {
      createBackup: async () => {
        if (!armed) return { archivePath: 'boot' };
        entered.resolve();
        if (mode === 'unfinished') { await backupGate.promise; return { archivePath: 'slow' }; }
        throw new Error('simulated failure');
      },
      wait: async () => mode === 'retry-wait' ? retryGate.promise : true,
      sweepArchiveRetention: async () => { sweeps++; return ok(); },
    })).start();
    t.after(() => scheduler.stop());
    await Promise.all([scheduler.runPromise, scheduler.retentionScheduler.runPromise]);
    armed = true;
    time.fire('2026-10-23T00:00:00+08:00');
    if (mode !== 'disabled') await entered.promise;
    if (mode === 'failed' || mode === 'disabled') await scheduler.runPromise;
    const before = sweeps;
    time.fire('2026-10-23T00:30:00+08:00');
    await scheduler.retentionScheduler.runPromise;
    assert.equal(sweeps, before + 1);
    backupGate.resolve();
    retryGate.resolve(false);
    await scheduler.runPromise;
  });
}

test('00:30前启动补最近昨日边界，00:30后重启补当日，同边界成功持久化去重', async (t) => {
  const config = await configFor(t);
  const time = clock('2026-10-23T00:29:00+08:00');
  const run = async () => {
    const scheduler = new ArchiveRetentionScheduler(config, options(time, { sweepArchiveRetention }));
    const result = await scheduler.runAndSchedule();
    scheduler.stop();
    return result;
  };
  assert.equal((await run()).boundary, '2026-10-21T16:30:00.000Z');
  assert.equal((await run()).skipped, true);
  time.set('2026-10-23T00:30:00+08:00');
  assert.equal((await run()).boundary, '2026-10-22T16:30:00.000Z');
  assert.equal((await run()).skipped, true);
  const persisted = JSON.parse(await fs.readFile(path.join(config.backupDir, RETENTION_STATE_FILE), 'utf8'));
  assert.equal(persisted.scheduleVersion, RETENTION_SCHEDULE_VERSION);
  time.set('2026-10-24T00:31:00+08:00');
  assert.equal((await run()).boundary, '2026-10-23T16:30:00.000Z');
});

test('旧状态含ok也必须重新清扫，新状态error/deferred同边界不去重', async (t) => {
  const config = await configFor(t);
  const now = new Date('2026-10-23T01:00:00+08:00');
  const boundary = scheduledBoundaryAtOrBefore(now, '00:30');
  for (const previous of [
    { status: 'ok', boundary: boundary.toISOString() },
    { status: 'ok', boundary: scheduledBoundaryAtOrBefore(now).toISOString() },
    { scheduleVersion: RETENTION_SCHEDULE_VERSION, status: 'error', boundary: boundary.toISOString() },
    { scheduleVersion: RETENTION_SCHEDULE_VERSION, status: 'deferred', boundary: boundary.toISOString() },
  ]) {
    await fs.writeFile(path.join(config.backupDir, RETENTION_STATE_FILE), JSON.stringify(previous));
    assert.equal((await sweepArchiveRetention(config, { now, boundary })).status, 'ok');
    assert.equal((await sweepArchiveRetention(config, { now, boundary })).skipped, true);
  }
});

test('清扫失败/占用5分钟后重试，跨下个00:30时不越界，异常回调被捕获', async (t) => {
  const config = await configFor(t);
  const time = clock('2026-10-23T01:00:00+08:00');
  let attempts = 0;
  const scheduler = new ArchiveRetentionScheduler(config, options(time, {
    sweepArchiveRetention: async () => {
      attempts++;
      if (attempts === 1) throw new Error('failed write');
      return attempts === 2 ? { status: 'deferred', results: [] } : ok();
    },
  })).start();
  t.after(() => scheduler.stop());
  assert.equal((await scheduler.runPromise).status, 'error');
  assert.equal([...time.timers.values()][0].at - time.now(), RETENTION_RETRY_MS);
  time.fire('2026-10-23T01:05:00+08:00');
  assert.equal((await scheduler.runPromise).status, 'deferred');
  time.fire('2026-10-23T01:10:00+08:00');
  assert.equal((await scheduler.runPromise).status, 'ok');
  time.set('2026-10-24T00:29:00+08:00');
  assert.equal(scheduler.scheduleNext({ retry: true }).toISOString(), '2026-10-23T16:30:00.000Z');
});

test('上次清扫跨00:30才完成时立即补新边界，不并发重入；stop移除计时器', async (t) => {
  const config = await configFor(t);
  const time = clock('2026-10-23T00:29:00+08:00');
  const hold = gate();
  let calls = 0;
  const boundaries = [];
  const scheduler = new ArchiveRetentionScheduler(config, options(time, {
    sweepArchiveRetention: async (_config, { boundary }) => {
      calls++;
      boundaries.push(boundary.toISOString());
      if (calls === 1) await hold.promise;
      return ok();
    },
  })).start();
  const boot = scheduler.runPromise;
  scheduler.start(); // idempotent
  time.fire('2026-10-23T00:30:00+08:00');
  assert.equal((await scheduler.runPromise).status, 'deferred');
  assert.equal(calls, 1);
  hold.resolve();
  await boot;
  assert.equal([...time.timers.values()][0].at - time.now(), 0);
  time.fire('2026-10-23T00:30:00+08:00');
  await scheduler.runPromise;
  assert.deepEqual(boundaries, ['2026-10-21T16:30:00.000Z', '2026-10-22T16:30:00.000Z']);
  const late = [...time.timers.values()][0].fn;
  scheduler.stop();
  assert.equal(time.timers.size, 0);
  late();
  assert.equal(calls, 2, '停止后已排队的迟到回调不能重启调度。');
});

test('停止备份调度会同时取消备份、重试与清扫定时器', async (t) => {
  const config = await configFor(t);
  const time = clock('2026-10-23T00:01:00+08:00');
  const retryStarted = gate();
  const scheduler = new BackupScheduler(config, options(time, {
    createBackup: async () => { retryStarted.resolve(); throw new Error('retry'); },
  })).start();
  await retryStarted.promise;
  await scheduler.retentionScheduler.runPromise;
  // Let tick enter waitForRetry before stopping it.
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(time.timers.size >= 2);
  scheduler.stop();
  await scheduler.runPromise;
  assert.equal(time.timers.size, 0);
});

test('正常关闭等待在途清扫收尾，不能因一次busy回调返回就提前退出', async (t) => {
  const config = await configFor(t);
  const time = clock('2026-10-23T00:29:00+08:00');
  const hold = gate();
  const entered = gate();
  const scheduler = new BackupScheduler({ ...config, backupScheduleEnabled: false }, options(time, {
    sweepArchiveRetention: async () => { entered.resolve(); await hold.promise; return ok(); },
  })).start();
  await entered.promise;
  time.fire('2026-10-23T00:30:00+08:00');
  assert.equal((await scheduler.retentionScheduler.runPromise).status, 'deferred');
  scheduler.stop();
  let idle = false;
  const waiting = scheduler.waitForIdle().then(() => { idle = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idle, false);
  hold.resolve();
  await waiting;
  assert.equal(idle, true);
  assert.equal(time.timers.size, 0);
});
