const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const test = require('node:test');
const fsSync = require('node:fs');
const { PassThrough } = require('node:stream');
const { initializeDatabase } = require('../src/db');
const { withArchiveUse } = require('../src/services/archive-lease');
const { pruneBackups, sweepArchiveRetention } = require('../src/services/backup-retention');
const { createBackup, restoreBackup } = require('../src/services/backup-service');
const { LocalMirrorDestination } = require('../src/services/backup-destination');
const { cleanupOrphanUploads } = require('../src/services/orphan-upload-service');

const gate = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const old = new Date('2026-10-10T04:00:00Z');
const now = new Date('2026-10-17T04:00:00Z');
const expired = 'backup-20261010T040000000Z.tar.gz';
const policy = { retentionDays: 3, minCount: 0 };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-archive-lease-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { serverRoot: path.resolve(__dirname, '..'), dataDir: path.join(root, 'data'),
    databasePath: path.join(root, 'data', 'admin.sqlite3'), contentDir: path.join(root, 'content'),
    uploadsDir: path.join(root, 'uploads'), labStorageDir: path.join(root, 'lab-storage'),
    backupDir: path.join(root, 'backups'), backupMirrorDir: path.join(root, 'mirror'),
    backupEncryptionPassword: '', backupExcludeZip: false };
  initializeDatabase(config).close();
  await fs.mkdir(config.backupDir, { recursive: true });
  await fs.mkdir(config.backupMirrorDir, { recursive: true });
  return { root, config };
}

test('占用归档不删，deferred持久化而非成功；释放后同边界补扫完成', async (t) => {
  const { config } = await fixture(t);
  const target = path.join(config.backupDir, expired);
  await fs.writeFile(target, 'keep while verifying');
  const blocked = await withArchiveUse(target, 'test-read', async () => {
    const state = await sweepArchiveRetention(config, { now, boundary: now });
    assert.equal(state.status, 'deferred');
    const pool = state.results.find((entry) => entry.destination === 'local' && entry.prefix === 'backup');
    assert.deepEqual(pool.deferred, [expired]);
    assert.equal(await fs.readFile(target, 'utf8'), 'keep while verifying');
    return state;
  });
  const stored = JSON.parse(await fs.readFile(path.join(config.backupDir, '.archive-retention-state.json'), 'utf8'));
  assert.deepEqual(stored, blocked);
  assert.equal((await sweepArchiveRetention(config, { now, boundary: now })).status, 'ok');
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

test('跨进程租约也保护归档；另一个Node退出释放后可删除', { timeout: 15000 }, async (t) => {
  const { config } = await fixture(t);
  const target = path.join(config.backupDir, expired);
  await fs.writeFile(target, 'cross process');
  const modulePath = path.resolve(__dirname, '../src/services/archive-lease');
  const code = `const {withArchiveUse}=require(${JSON.stringify(modulePath)});
    withArchiveUse(${JSON.stringify(target)},'child-read',async()=>{
      process.send('ready'); await new Promise(resolve=>process.once('message',resolve));
    }).then(()=>process.disconnect()).catch(error=>{console.error(error);process.exit(1)});`;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await once(child, 'message');
  const skipped = await pruneBackups(config.backupDir, policy, 'backup', now);
  assert.deepEqual(skipped, []);
  assert.deepEqual(skipped.deferred, [expired]);
  const done = once(child, 'exit');
  child.send('release');
  const [exitCode] = await done;
  assert.equal(exitCode, 0);
  assert.deepEqual(await pruneBackups(config.backupDir, policy, 'backup', now), [expired]);
});

test('创建后本地轮转和副本目的地轮转都保留被读取的旧包，并返回暂缓清单', async (t) => {
  const { config } = await fixture(t);
  const local = path.join(config.backupDir, expired);
  const mirror = path.join(config.backupMirrorDir, expired);
  await fs.writeFile(local, 'old local');
  await fs.writeFile(mirror, 'old mirror');
  const backup = await withArchiveUse(local, 'verify-local', () =>
    withArchiveUse(mirror, 'verify-mirror', () => createBackup(config, { now })));
  assert.deepEqual(backup.deferred, [expired]);
  assert.equal(backup.replication.ok, true);
  assert.deepEqual(backup.replication.deferred, [expired]);
  assert.equal(await fs.readFile(local, 'utf8'), 'old local');
  assert.equal(await fs.readFile(mirror, 'utf8'), 'old mirror');
  await sweepArchiveRetention(config, { now, boundary: now });
  await assert.rejects(fs.stat(local), { code: 'ENOENT' });
  await assert.rejects(fs.stat(mirror), { code: 'ENOENT' });
});

test('复制进行时源包与目标包都不能被清扫，完成后可补扫', async (t) => {
  const { config } = await fixture(t);
  const source = path.join(config.backupDir, expired);
  const target = path.join(config.backupMirrorDir, expired);
  await fs.writeFile(source, 'source');
  await fs.writeFile(target, 'old target');
  const started = gate();
  const release = gate();
  const copyFile = fs.copyFile;
  const mock = t.mock.method(fs, 'copyFile', async (...args) => {
    started.resolve(); await release.promise; return copyFile(...args);
  });
  const sending = new LocalMirrorDestination(config.backupMirrorDir).send(source);
  try {
    await started.promise;
    assert.deepEqual((await pruneBackups(config.backupDir, policy, 'backup', now)).deferred, [expired]);
    assert.deepEqual((await pruneBackups(config.backupMirrorDir, policy, 'backup', now)).deferred, [expired]);
  } finally { release.resolve(); await sending; mock.mock.restore(); }
  assert.equal(await fs.readFile(target, 'utf8'), 'source');
  assert.deepEqual(await pruneBackups(config.backupDir, policy, 'backup', now), [expired]);
  assert.deepEqual(await pruneBackups(config.backupMirrorDir, policy, 'backup', now), [expired]);
});

test('创建任务未返回时成品仍保护，复制失败后租约也释放', async (t) => {
  const { config } = await fixture(t);
  const started = gate();
  const release = gate();
  const creating = createBackup(config, { now: old, destination: { name: 'test', describe: () => 'test',
    async send() { started.resolve(); await release.promise; throw new Error('simulated copy failure'); } } });
  await started.promise;
  assert.deepEqual((await pruneBackups(config.backupDir, policy, 'backup', now)).deferred, [expired]);
  release.resolve();
  assert.equal((await creating).replication.ok, false);
  assert.deepEqual(await pruneBackups(config.backupDir, policy, 'backup', now), [expired]);
});

test('孤儿证明归档从真实核验到最终删除全程占用，清扫不得中途删除恢复点', async (t) => {
  const { config } = await fixture(t);
  const upload = path.join(config.uploadsDir, 'old.webp');
  await fs.writeFile(upload, 'orphan');
  await fs.utimes(upload, old, old);
  const backup = await createBackup(config, { now: old });
  const result = await cleanupOrphanUploads(config, { delete: true, now, beforeFinalScan: async () => {
    const state = await sweepArchiveRetention(config, { now, boundary: now });
    assert.equal(state.status, 'deferred');
    assert.equal((await fs.stat(backup.archivePath)).isFile(), true);
  } });
  assert.equal(result.deleted.length, 1);
  await assert.rejects(fs.stat(upload), { code: 'ENOENT' });
  assert.equal((await fs.stat(backup.archivePath)).isFile(), true);
  assert.equal((await sweepArchiveRetention(config, { now, boundary: now })).status, 'ok');
  await assert.rejects(fs.stat(backup.archivePath), { code: 'ENOENT' });
});

test('完整恢复读取输入包时受保护，读取异常不遗留租约', async (t) => {
  const { config } = await fixture(t);
  config.backupEncryptionPassword = 'test-only-stream-lease';
  const backup = await createBackup(config, { now: old });
  const entered = gate();
  const release = gate();
  const createReadStream = fsSync.createReadStream;
  const mock = t.mock.method(fsSync, 'createReadStream', (source, options) => {
    if (source !== backup.archivePath) return createReadStream(source, options);
    entered.resolve();
    const input = new PassThrough();
    release.promise.then(() => input.destroy(new Error('test stopped before data writes')));
    return input;
  });
  const restoring = restoreBackup(config, backup.archivePath, { force: true, confirmServiceStopped: true });
  // Attach rejection handler before releasing the deliberately failed reader.
  const rejected = assert.rejects(restoring, /test stopped before data writes/);
  try {
    await entered.promise;
    assert.deepEqual((await pruneBackups(config.backupDir, policy, 'backup', now)).deferred, [path.basename(backup.archivePath)]);
  } finally { release.resolve(); await rejected; mock.mock.restore(); }
  assert.deepEqual(await pruneBackups(config.backupDir, policy, 'backup', now), [path.basename(backup.archivePath)]);
});

test('未显式传now时也只取一次时间，目录I/O跨毫秒不会让租约与归档名错位', async (t) => {
  const { config } = await fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: old.getTime() });
  const mkdir = fs.mkdir;
  const mocked = t.mock.method(fs, 'mkdir', async (...args) => {
    t.mock.timers.tick(1);
    return mkdir(...args);
  });
  try {
    const result = await createBackup(config, { destination: { name: 'probe', describe: () => 'probe',
      async send(archive) {
        const rotated = await pruneBackups(config.backupDir, policy, 'backup', now);
        assert.deepEqual(rotated.deferred, [path.basename(archive)]);
        assert.equal((await fs.stat(archive)).isFile(), true);
        return { location: 'probe' };
      } } });
    assert.equal(path.basename(result.archivePath), expired);
    assert.equal(result.replication.ok, true);
  } finally { mocked.mock.restore(); t.mock.timers.reset(); }
});

test('强杀留下的租约不按年龄擅自失效：记录暂缓，确认无任务后才可人工解除', { timeout: 15000 }, async (t) => {
  const { config } = await fixture(t);
  const target = path.join(config.backupDir, expired);
  await fs.writeFile(target, 'keep');
  const modulePath = path.resolve(__dirname, '../src/services/archive-lease');
  const code = `const {withArchiveUse}=require(${JSON.stringify(modulePath)});
    withArchiveUse(${JSON.stringify(target)},'crash-test',async()=>{
      process.send('ready'); process.once('message',()=>process.exit(0));
      await new Promise(()=>{});
    });`;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await once(child, 'message');
  const exited = once(child, 'exit');
  child.send('exit-without-finally');
  await exited;
  assert.equal((await sweepArchiveRetention(config, { now, boundary: now })).status, 'deferred');
  const leaseDirectory = path.join(config.backupDir, '.archive-leases');
  const leases = await fs.readdir(leaseDirectory);
  assert.equal(leases.length, 1);
  const leasePath = path.join(leaseDirectory, leases[0]);
  assert.equal(JSON.parse(await fs.readFile(leasePath, 'utf8')).pid, child.pid);
  // This is an isolated dead-child fixture, not automatic age/PID-based removal.
  await fs.unlink(leasePath);
  assert.equal((await sweepArchiveRetention(config, { now, boundary: now })).status, 'ok');
});

test('归档已删除但释放标记失败时，清扫记录error且已删清单仍准确', async (t) => {
  const { config } = await fixture(t);
  const target = path.join(config.backupDir, expired);
  await fs.writeFile(target, 'expired');
  const unlink = fs.unlink;
  const mocked = t.mock.method(fs, 'unlink', async (file) => {
    if (path.basename(path.dirname(file)) === '.archive-leases') throw new Error('simulated lease release failure');
    return unlink(file);
  });
  try {
    const state = await sweepArchiveRetention(config, { now, boundary: now });
    assert.equal(state.status, 'error');
    const pool = state.results.find((entry) => entry.destination === 'local' && entry.prefix === 'backup');
    assert.deepEqual(pool.removed, [expired]);
    assert.match(pool.error, /lease release failure/);
    await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  } finally { mocked.mock.restore(); }
});
