// Proves backup integrity, encrypted restore, destructive recovery and retention cleanup.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { initializeDatabase } = require('../src/db');
const { ContentService } = require('../src/services/content-service');
const { createBackup, restoreBackup } = require('../src/services/backup-service');

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
    category: '备份验证',
    summary: '验证作品元数据与正文恢复。',
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
