const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { initializeDatabase } = require('../src/db');
const { loadBackupConfig } = require('../src/backup-config');
const { parseArguments } = require('../scripts/orphan-uploads');
const {
  MINIMUM_ORPHAN_UPLOAD_AGE_MS,
  cleanupOrphanUploads,
  inventoryOrphanUploads,
} = require('../src/services/orphan-upload-service');

function createConfig(runtimeRoot) {
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
    backupEncryptionPassword: '',
    orphanUploadMinAgeMs: MINIMUM_ORPHAN_UPLOAD_AGE_MS,
  };
}

async function writeUpload(config, filename, body, modifiedAt) {
  const target = path.join(config.uploadsDir, filename);
  await fs.writeFile(target, body, 'utf8');
  await fs.utimes(target, modifiedAt, modifiedAt);
  return target;
}

async function seedEveryReferenceClass(config, filenames) {
  const database = initializeDatabase(config);
  const now = '2026-09-04T00:00:00.000Z';
  database.prepare(`
    INSERT INTO works (
      title, slug, work_date, category, summary, detail_intro,
      cover_image, download_file, main_media_type, main_media_path, gallery, version_log,
      markdown_path, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    '引用覆盖作品',
    'orphan-reference-work',
    '2026-09-04',
    '程序',
    '引用覆盖',
    '引用覆盖',
    `assets/works/covers/${filenames.cover}`,
    `assets/works/downloads/${filenames.download}`,
    'image',
    `assets/works/main/${filenames.main}`,
    JSON.stringify([`assets/works/gallery/${filenames.gallery}`]),
    `版本日志引用 ${filenames.versionLog}`,
    'orphan-reference-work.md',
    now,
    now,
  );
  database.prepare(`
    INSERT INTO notes (title, slug, note_date, summary, markdown_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('引用覆盖日记', 'orphan-reference-note', '2026-09-04', '引用覆盖', 'orphan-reference-note.md', now, now);
  database.exec('CREATE TABLE future_upload_references (id INTEGER PRIMARY KEY, attachment TEXT)');
  database.prepare('INSERT INTO future_upload_references (attachment) VALUES (?)')
    .run(`future/${filenames.futureColumn}`);
  database.close();

  await fs.writeFile(
    path.join(config.contentDir, 'works', 'orphan-reference-work.md'),
    `作品正文引用 /uploads/${filenames.workMarkdown}\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(config.contentDir, 'notes', 'orphan-reference-note.md'),
    `日记正文引用 /uploads/${filenames.noteMarkdown}\n`,
    'utf8',
  );
  const labDirectory = path.join(config.labStorageDir, 'reference-lab');
  await fs.mkdir(labDirectory, { recursive: true });
  await fs.writeFile(path.join(labDirectory, 'index.html'), `<img src="/uploads/${filenames.labContent}">`, 'utf8');
}

test('孤儿盘点从全部SQLite值与内容目录识别每类引用，并保护新上传文件', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-orphan-inventory-'));
  const config = createConfig(runtimeRoot);
  const now = new Date('2026-09-04T12:00:00.000Z');
  const old = new Date(now.getTime() - MINIMUM_ORPHAN_UPLOAD_AGE_MS - 1000);
  const recent = new Date(now.getTime() - 60 * 60 * 1000);
  const filenames = {
    cover: 'cover-reference.webp',
    main: 'main-reference.mp4',
    gallery: 'gallery-reference.png',
    download: 'download-reference.zip',
    versionLog: 'version-log-reference.pdf',
    workMarkdown: 'work-markdown-reference.mp3',
    noteMarkdown: 'note-markdown-reference.wav',
    labContent: 'lab-content-reference.ogg',
    futureColumn: 'future-column-reference.bin',
  };
  try {
    initializeDatabase(config).close();
    for (const filename of Object.values(filenames)) await writeUpload(config, filename, filename, old);
    await writeUpload(config, 'recent-unreferenced.webp', 'recent', recent);
    const oldOrphanPath = await writeUpload(config, 'old-unreferenced.webp', 'old', old);
    await seedEveryReferenceClass(config, filenames);

    const result = await inventoryOrphanUploads(config, { now });
    assert.deepEqual(result.orphans.map((file) => file.relativePath), ['old-unreferenced.webp']);
    assert.deepEqual(result.recentUnreferenced.map((file) => file.relativePath), ['recent-unreferenced.webp']);
    assert.deepEqual(
      result.referenced.map((file) => file.relativePath).sort(),
      Object.values(filenames).sort(),
    );
    for (const filename of Object.values(filenames)) {
      const file = result.referenced.find((candidate) => candidate.relativePath === filename);
      assert.ok(file.references.length > 0, `${filename} should have a concrete reference source`);
    }

    const reportOnly = await cleanupOrphanUploads(config, { now });
    assert.equal(reportOnly.deleteEnabled, false);
    assert.equal(reportOnly.backup, null);
    assert.deepEqual(reportOnly.deleted, []);
    assert.equal(await fs.readFile(oldOrphanPath, 'utf8'), 'old');
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('显式清理先生成包含ZIP的回退备份，再删除仍未变化的旧孤儿', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-orphan-cleanup-'));
  const config = { ...createConfig(runtimeRoot), backupExcludeZip: true };
  const now = new Date('2026-09-04T12:00:00.000Z');
  const old = new Date(now.getTime() - MINIMUM_ORPHAN_UPLOAD_AGE_MS - 1000);
  const orphanName = 'old-unreferenced.zip';
  const orphanPath = path.join(config.uploadsDir, orphanName);
  try {
    initializeDatabase(config).close();
    await writeUpload(config, orphanName, 'rollback-copy', old);
    const result = await cleanupOrphanUploads(config, {
      delete: true,
      now,
      backupOptions: { now: new Date('2026-09-04T12:00:01.000Z') },
    });

    assert.deepEqual(result.deleted.map((file) => file.relativePath), [orphanName]);
    await assert.rejects(fs.stat(orphanPath), { code: 'ENOENT' });
    assert.ok(result.backup);
    assert.equal((await fs.stat(result.backup.archivePath)).isFile(), true);
    const manifestEntry = result.backup.manifest.files.find((file) => file.path === `uploads/${orphanName}`);
    assert.ok(manifestEntry, 'cleanup rollback backup must physically contain the ZIP');
    assert.equal(manifestEntry.size, Buffer.byteLength('rollback-copy'));
    assert.deepEqual(result.backup.manifest.excluded, []);
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('孤儿清理参数与年龄配置默认安全关闭并拒绝低于24小时', () => {
  assert.deepEqual(parseArguments([]), { delete: false });
  assert.deepEqual(parseArguments(['--delete']), { delete: true });
  assert.throws(() => parseArguments(['--force']), /Unknown argument: --force/);
  assert.equal(loadBackupConfig({ orphanUploadMinAgeMs: MINIMUM_ORPHAN_UPLOAD_AGE_MS }).orphanUploadMinAgeMs, MINIMUM_ORPHAN_UPLOAD_AGE_MS);
  assert.throws(
    () => loadBackupConfig({ orphanUploadMinAgeMs: MINIMUM_ORPHAN_UPLOAD_AGE_MS - 1 }),
    /ORPHAN_UPLOAD_MIN_AGE_MS must be at least 86400000/,
  );
});
