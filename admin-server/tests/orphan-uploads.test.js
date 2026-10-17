const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const tar = require('tar');

const { initializeDatabase } = require('../src/db');
const { loadBackupConfig } = require('../src/backup-config');
const { parseArguments } = require('../scripts/orphan-uploads');
const {
  MINIMUM_ORPHAN_UPLOAD_AGE_MS,
  ORPHAN_ROLLBACK_PREFIX,
  ORPHAN_ROLLBACK_FORMAT,
  cleanupOrphanUploads,
  deleteReplacedUploadIfUnreferenced,
  inventoryOrphanUploads,
  persistOrphanCleanupResult,
  readOrphanCleanupState,
  restoreOrphanRollback,
} = require('../src/services/orphan-upload-service');
const { parseArchiveTimestamp } = require('../src/services/backup-scheduler');
const { archiveTimestamp, createBackup, encryptArchive, verifyExtractedBackup } = require('../src/services/backup-service');
const { sweepArchiveRetention } = require('../src/services/backup-retention');
const { dashboardPage } = require('../src/views');

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

// Existing orphan-rollback-v1 fixtures are created ONLY in tests; production no
// longer generates them. Keep executing the retained real recovery path.
async function legacyRollback(config, filename, now) {
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-legacy-fixture-'));
  try {
    const body = await fs.readFile(path.join(config.uploadsDir, filename));
    const manifest = { formatVersion: ORPHAN_ROLLBACK_FORMAT, createdAt: now.toISOString(), excluded: [],
      files: [{ path: 'uploads/' + filename, size: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') }] };
    await fs.mkdir(path.join(staging, path.dirname('uploads/' + filename)), { recursive: true });
    await fs.writeFile(path.join(staging, 'uploads', filename), body);
    await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest));
    await fs.mkdir(config.backupDir, { recursive: true });
    let archivePath = path.join(config.backupDir, 'orphan-rollback-' + archiveTimestamp(now) + '.tar.gz');
    await tar.c({ cwd: staging, gzip: true, portable: true, file: archivePath }, ['manifest.json', 'uploads/' + filename]);
    if (config.backupEncryptionPassword) {
      await encryptArchive(archivePath, archivePath + '.enc', config.backupEncryptionPassword);
      await fs.unlink(archivePath);
      archivePath += '.enc';
    }
    return { archivePath, manifest };
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

async function seedEveryReferenceClass(config, filenames) {
  const database = initializeDatabase(config);
  const now = '2026-09-04T00:00:00.000Z';
  database.prepare(`
    INSERT INTO work_categories (
      name, slug, kicker, intro, empty_text, display_order, is_visible, created_at, updated_at
    ) VALUES ('程序', 'program', 'PROGRAM', '程序作品。', '暂无程序作品。', 10, 1, ?, ?)
  `).run(now, now);
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

    await createBackup(config, { now });
    const cleaned = await cleanupOrphanUploads(config, { delete: true, now });
    assert.deepEqual(cleaned.deleted.map((file) => file.relativePath), ['old-unreferenced.webp']);
    assert.equal(cleaned.backup, null);
    assert.deepEqual(cleaned.uncovered, []);
    assert.equal((await fs.readdir(config.backupDir)).filter((name) => name.startsWith('orphan-rollback-')).length, 0);
    for (const filename of Object.values(filenames)) {
      assert.equal(await fs.readFile(path.join(config.uploadsDir, filename), 'utf8'), filename);
    }
    assert.equal(await fs.readFile(path.join(config.uploadsDir, 'recent-unreferenced.webp'), 'utf8'), 'recent');
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('存量最小回退包仍能真实还原原位且SHA-256一致，不因取消生成而删除还原能力', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-orphan-cleanup-'));
  const config = { ...createConfig(runtimeRoot), backupExcludeZip: true };
  const now = new Date('2026-09-04T12:00:00.000Z');
  const old = new Date(now.getTime() - MINIMUM_ORPHAN_UPLOAD_AGE_MS - 1000);
  const orphanName = 'old-unreferenced.zip';
  const orphanPath = path.join(config.uploadsDir, orphanName);
  try {
    initializeDatabase(config).close();
    await writeUpload(config, orphanName, 'rollback-copy', old);
    await writeUpload(config, 'new-upload.webp', 'recent upload must not enter rollback', now);
    await fs.writeFile(path.join(config.contentDir, 'works', 'keep.md'), 'unrelated Markdown');
    await fs.mkdir(path.join(config.labStorageDir, 'keep'), { recursive: true });
    await fs.writeFile(path.join(config.labStorageDir, 'keep', 'index.html'), 'unrelated lab content');
    const originalHash = crypto.createHash('sha256').update(await fs.readFile(orphanPath)).digest('hex');
    const databaseBytes = await fs.readFile(config.databasePath);
    const result = { backup: await legacyRollback(config, orphanName, now) };
    await fs.unlink(orphanPath);
    await assert.rejects(fs.stat(orphanPath), { code: 'ENOENT' });
    assert.ok(result.backup);
    assert.match(path.basename(result.backup.archivePath), /^orphan-rollback-/);
    assert.equal(parseArchiveTimestamp(path.basename(result.backup.archivePath)), null);
    assert.equal((await fs.stat(result.backup.archivePath)).isFile(), true);
    const manifestEntry = result.backup.manifest.files.find((file) => file.path === `uploads/${orphanName}`);
    assert.ok(manifestEntry, 'cleanup rollback backup must physically contain the ZIP');
    assert.equal(manifestEntry.size, Buffer.byteLength('rollback-copy'));
    assert.deepEqual(result.backup.manifest.excluded, []);
    assert.equal(result.backup.manifest.formatVersion, ORPHAN_ROLLBACK_FORMAT);
    assert.deepEqual(result.backup.manifest.files.map((file) => file.path), [`uploads/${orphanName}`]);
    const entries = [];
    await tar.t({ file: result.backup.archivePath, onReadEntry: (entry) => entries.push(entry.path) });
    assert.deepEqual(entries.sort(), ['manifest.json', `uploads/${orphanName}`]);
    const unpacked = path.join(runtimeRoot, 'unpacked');
    await fs.mkdir(unpacked);
    await tar.x({ cwd: unpacked, file: result.backup.archivePath });
    await assert.rejects(verifyExtractedBackup(unpacked), /manifest format is unsupported/);

    const restored = await restoreOrphanRollback(config, result.backup.archivePath);
    assert.deepEqual(restored.restored.map((file) => file.path), [`uploads/${orphanName}`]);
    assert.equal(crypto.createHash('sha256').update(await fs.readFile(orphanPath)).digest('hex'), originalHash);
    assert.deepEqual(await fs.readFile(config.databasePath), databaseBytes);
    assert.equal(await fs.readFile(path.join(config.contentDir, 'works', 'keep.md'), 'utf8'), 'unrelated Markdown');
    assert.equal(await fs.readFile(path.join(config.labStorageDir, 'keep', 'index.html'), 'utf8'), 'unrelated lab content');
    assert.equal(await fs.readFile(path.join(config.uploadsDir, 'new-upload.webp'), 'utf8'), 'recent upload must not enter rollback');
    console.log(`Minimal orphan rollback: payload=${manifestEntry.size} bytes, archive=${(await fs.stat(result.backup.archivePath)).size} bytes; restored SHA-256=${originalHash}`);
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('回退包混存不读旧全量格式内容，本地和镜像均按同前缀自然轮转且隔离其它谱系', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-orphan-rotation-'));
  const config = { ...createConfig(runtimeRoot), backupMirrorDir: path.join(runtimeRoot, 'mirror') };
  const legacyNames = [1, 2, 3].map((day) => `orphan-rollback-2026090${day}T120000000Z.tar.gz`);
  const unrelatedNames = ['backup', 'scheduled-backup', 'pre-restore']
    .map((prefix) => `${prefix}-20260901T120000000Z.tar.gz`);
  try {
    initializeDatabase(config).close();
    for (const directory of [config.backupDir, config.backupMirrorDir]) {
      await fs.mkdir(directory, { recursive: true });
      for (const name of [...legacyNames, ...unrelatedNames]) {
        // Intentionally unparseable sentinels: any attempt to decode old contents
        // would fail. Retention must look only at filenames, never archive format.
        await fs.writeFile(path.join(directory, name), `legacy untouched ${name}`);
      }
    }
    const clock = new Date('2026-09-10T12:00:00.000Z');
    const result = await sweepArchiveRetention(config, { now: clock, boundary: clock });
    assert.equal(result.status, 'ok');
    for (const directory of [config.backupDir, config.backupMirrorDir]) {
      assert.equal((await fs.readdir(directory)).filter((name) => name.startsWith('orphan-rollback-')).length, 0);
      for (const name of legacyNames) await assert.rejects(fs.stat(path.join(directory, name)), { code: 'ENOENT' });
      assert.equal(await fs.readFile(path.join(directory, unrelatedNames[1]), 'utf8'), 'legacy untouched ' + unrelatedNames[1]);
    }
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('归档覆盖核验后size/mtime未变但SHA-256改变时拒绝整轮删除，先验全部文件再删', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-orphan-recheck-'));
  const config = createConfig(runtimeRoot);
  const now = new Date('2026-09-04T12:00:00.000Z');
  const old = new Date('2026-09-01T12:00:00.000Z');
  try {
    initializeDatabase(config).close();
    const first = await writeUpload(config, 'a-unchanged.webp', 'safe', old);
    const changed = await writeUpload(config, 'b-changed.webp', 'aaaa', old);
    const originalStat = await fs.stat(changed);
    await createBackup(config, { now });
    const beforeFinalScan = async () => {
      await fs.writeFile(changed, 'bbbb');
      await fs.utimes(changed, originalStat.atime, originalStat.mtime);
      assert.equal((await fs.stat(changed)).mtimeMs, originalStat.mtimeMs);
    };
    await assert.rejects(cleanupOrphanUploads(config, { delete: true, now, beforeFinalScan }),
      /changed after backup and will not be deleted/);
    assert.equal(await fs.readFile(first, 'utf8'), 'safe');
    assert.equal(await fs.readFile(changed, 'utf8'), 'bbbb');
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('归档覆盖核验后重新引用、size/mtime变化和新增的旧文件都不会被本轮删除', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-orphan-rescan-'));
  const config = createConfig(runtimeRoot);
  const now = new Date('2026-09-04T12:00:00.000Z');
  const old = new Date('2026-09-01T12:00:00.000Z');
  try {
    initializeDatabase(config).close();
    const referenced = await writeUpload(config, 'newly-referenced.webp', 'referenced after packaging', old);
    const changed = await writeUpload(config, 'changed.webp', 'before', old);
    const stable = await writeUpload(config, 'stable.webp', 'stable', old);
    await createBackup(config, { now });
    const beforeFinalScan = async () => {
      const database = initializeDatabase(config);
      database.exec('CREATE TABLE rollback_test_references (attachment TEXT)');
      database.prepare('INSERT INTO rollback_test_references VALUES (?)').run('newly-referenced.webp');
      database.close();
      await fs.writeFile(changed, 'size and mtime changed');
      await writeUpload(config, 'new-old.webp', 'appeared after snapshot', old);
    };
    const result = await cleanupOrphanUploads(config, { delete: true, now, beforeFinalScan });
    assert.deepEqual(result.deleted.map((file) => file.relativePath), ['stable.webp']);
    assert.deepEqual(result.changed.map((file) => file.relativePath).sort(), ['changed.webp', 'newly-referenced.webp']);
    await assert.rejects(fs.stat(stable), { code: 'ENOENT' });
    assert.equal(await fs.readFile(referenced, 'utf8'), 'referenced after packaging');
    assert.equal(await fs.readFile(changed, 'utf8'), 'size and mtime changed');
    assert.equal(await fs.readFile(path.join(config.uploadsDir, 'new-old.webp'), 'utf8'), 'appeared after snapshot');
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('加密最小回退包真实恢复嵌套孤儿，错误密码和已有文件冲突均拒绝写入', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-orphan-encrypted-'));
  const config = { ...createConfig(runtimeRoot), backupEncryptionPassword: 'test-only-orphan-rollback-password' };
  const now = new Date('2026-09-04T12:00:00.000Z');
  const old = new Date('2026-09-01T12:00:00.000Z');
  try {
    initializeDatabase(config).close();
    await fs.mkdir(path.join(config.uploadsDir, 'nested'));
    const target = await writeUpload(config, 'nested/old.zip', crypto.randomBytes(64 * 1024), old);
    const originalHash = crypto.createHash('sha256').update(await fs.readFile(target)).digest('hex');
    const result = { backup: await legacyRollback(config, 'nested/old.zip', now) };
    await fs.unlink(target);
    assert.match(result.backup.archivePath, /\.tar\.gz\.enc$/);
    await assert.rejects(restoreOrphanRollback(config, result.backup.archivePath, { encryptionPassword: 'wrong-password-for-test' }));
    await assert.rejects(fs.stat(target), { code: 'ENOENT' });
    await restoreOrphanRollback(config, result.backup.archivePath);
    assert.equal(crypto.createHash('sha256').update(await fs.readFile(target)).digest('hex'), originalHash);
    await assert.rejects(restoreOrphanRollback(config, result.backup.archivePath), /refuses to overwrite/);
    assert.equal(crypto.createHash('sha256').update(await fs.readFile(target)).digest('hex'), originalHash);
    console.log(`Minimal encrypted orphan rollback: payload=65536 bytes, archive=${(await fs.stat(result.backup.archivePath)).size} bytes`);
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('还原先验完整manifest与SHA-256，损坏/未声明/越界条目不写入上传池', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-orphan-invalid-'));
  const config = createConfig(runtimeRoot);
  try {
    initializeDatabase(config).close();
    const staging = path.join(runtimeRoot, 'payload');
    await fs.mkdir(path.join(staging, 'uploads'), { recursive: true });
    await fs.writeFile(path.join(staging, 'uploads', 'first.webp'), 'first');
    await fs.writeFile(path.join(staging, 'uploads', 'second.webp'), 'second');
    const validFiles = ['first', 'second'].map((name) => ({ path: `uploads/${name}.webp`,
      size: Buffer.byteLength(name), sha256: crypto.createHash('sha256').update(name).digest('hex') }));
    for (const [index, files] of [
      [validFiles[0], { ...validFiles[1], sha256: '0'.repeat(64) }],
      [validFiles[0]],
      [{ ...validFiles[0], path: 'uploads/../outside.webp' }, validFiles[1]],
    ].entries()) {
      await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify({ formatVersion: ORPHAN_ROLLBACK_FORMAT, files }));
      const archive = path.join(runtimeRoot, `invalid-${index}.tar.gz`);
      await tar.c({ cwd: staging, file: archive, gzip: true }, ['manifest.json', 'uploads/first.webp', 'uploads/second.webp']);
      await assert.rejects(restoreOrphanRollback(config, archive), /checksum|undeclared|invalid file metadata/);
      await assert.rejects(fs.stat(path.join(config.uploadsDir, 'first.webp')), { code: 'ENOENT' });
      await assert.rejects(fs.stat(path.join(config.uploadsDir, 'second.webp')), { code: 'ENOENT' });
    }
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('即时替换只删除命名合法、位于上传池且未被作品引用的旧上传', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-upload-replace-'));
  const config = createConfig(runtimeRoot);
  const referencedName = `1720000000000-${crypto.randomUUID()}.webp`;
  const unreferencedName = `1720000000001-${crypto.randomUUID()}.webp`;
  try {
    const database = initializeDatabase(config);
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO work_categories (name, slug, kicker, intro, empty_text, display_order, is_visible, created_at, updated_at)
      VALUES ('程序', 'program', 'PROGRAM', '程序', '暂无', 10, 1, ?, ?)
    `).run(now, now);
    database.prepare(`
      INSERT INTO works (title, slug, work_date, category, summary, detail_intro, cover_image, markdown_path, created_at, updated_at)
      VALUES ('在用作品', 'used-upload', '2026-09-19', '程序', '摘要', '简介', ?, 'works/used.md', ?, ?)
    `).run(`assets/works/covers/${referencedName}`, now, now);
    database.close();
    await writeUpload(config, referencedName, 'used', new Date());
    await writeUpload(config, unreferencedName, 'unused', new Date());

    assert.deepEqual(
      await deleteReplacedUploadIfUnreferenced(config, referencedName),
      { deleted: false, reason: 'referenced' },
    );
    assert.equal(await fs.readFile(path.join(config.uploadsDir, referencedName), 'utf8'), 'used');
    assert.equal((await deleteReplacedUploadIfUnreferenced(config, unreferencedName)).deleted, true);
    await assert.rejects(fs.stat(path.join(config.uploadsDir, unreferencedName)), { code: 'ENOENT' });
    assert.deepEqual(
      await deleteReplacedUploadIfUnreferenced(config, '../outside.webp'),
      { deleted: false, reason: 'invalid_name' },
    );
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('自动清理结果写入SQLite并可在重新打开数据库后读取', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-orphan-state-'));
  const config = createConfig(runtimeRoot);
  try {
    initializeDatabase(config).close();
    persistOrphanCleanupResult(config, { deleted: [{ size: 1024 }, { size: 2048 }] }, null, new Date('2026-09-19T00:00:00.000Z'));
    const reopened = initializeDatabase(config);
    assert.deepEqual(readOrphanCleanupState(reopened), {
      lastRunAt: '2026-09-19T00:00:00.000Z',
      status: 'ok',
      deletedCount: 2,
      reclaimedBytes: 3072,
      errorMessage: null,
    });
    reopened.close();
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('ZIP排除只留下manifest哈希时保留并在仪表盘明示；收录实体时同场景可删', async (t) => {
  for (const exclude of [true, false]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-zip-coverage-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const config = { ...createConfig(root), backupExcludeZip: exclude };
    const now = new Date('2026-10-17T04:00:00Z');
    initializeDatabase(config).close();
    const target = await writeUpload(config, 'old.zip', 'zip-payload', new Date('2026-10-10T04:00:00Z'));
    const backup = await createBackup(config, { now });
    const entries = [];
    await tar.t({ file: backup.archivePath, onReadEntry: (entry) => entries.push(entry.path) });
    assert.equal(entries.includes('uploads/old.zip'), !exclude);
    assert.equal(backup.manifest.excluded.some((file) => file.path === 'uploads/old.zip'), exclude);
    const result = await cleanupOrphanUploads(config, { ...parseArguments(['--delete']), now });
    assert.equal(result.deleted.length, exclude ? 0 : 1);
    assert.equal(result.uncovered.length, exclude ? 1 : 0);
    assert.equal(result.backup, null);
    assert.equal((await fs.readdir(config.backupDir)).some((name) => name.startsWith('orphan-rollback-')), false);
    if (exclude) {
      assert.equal(await fs.readFile(target, 'utf8'), 'zip-payload');
      assert.equal(result.uncovered[0].reason, 'no_matching_backup_payload');
      persistOrphanCleanupResult(config, result, null, now);
      const database = initializeDatabase(config);
      const status = readOrphanCleanupState(database);
      database.close();
      assert.equal(status.status, 'ok');
      assert.match(status.errorMessage, /保留 1 个孤儿.*归档实体及 SHA-256/);
      const html = dashboardPage({ csrfToken: 'test', works: [], notes: [], orphanCleanupStatus: status });
      assert.match(html, /上次自动清理.*删除 0 个.*保留 1 个孤儿/);
    } else await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  }
});

test('手工--delete无备份也不能绕过保护，旧回退包不解析且不生成新包', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-manual-coverage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = createConfig(root);
  initializeDatabase(config).close();
  const now = new Date('2026-10-17T04:00:00Z');
  const target = await writeUpload(config, 'old.webp', 'keep', new Date('2026-10-10T04:00:00Z'));
  await fs.mkdir(config.backupDir, { recursive: true });
  const legacy = 'orphan-rollback-20261016T040000000Z.tar.gz';
  await fs.writeFile(path.join(config.backupDir, legacy), 'unparseable old archive');
  const result = await cleanupOrphanUploads(config, { ...parseArguments(['--delete']), now });
  assert.equal(result.deleted.length, 0);
  assert.equal(result.uncovered.length, 1);
  assert.deepEqual(result.coverageErrors, []);
  assert.equal(await fs.readFile(target, 'utf8'), 'keep');
  assert.deepEqual(await fs.readdir(config.backupDir), [legacy]);
});

test('manifest声明但实体缺失或归档实体哈希错误都不能证明覆盖', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-forged-coverage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = createConfig(root);
  initializeDatabase(config).close();
  const now = new Date('2026-10-17T04:00:00Z');
  const target = await writeUpload(config, 'old.webp', 'correct', new Date('2026-10-10T04:00:00Z'));
  const payload = path.join(root, 'payload');
  await fs.mkdir(path.join(payload, 'uploads'), { recursive: true });
  await fs.mkdir(config.backupDir, { recursive: true });
  await fs.writeFile(path.join(payload, 'manifest.json'), JSON.stringify({ formatVersion: 2, excluded: [],
    files: [{ path: 'uploads/old.webp', size: 7, sha256: crypto.createHash('sha256').update('correct').digest('hex') }] }));
  const archive = path.join(config.backupDir, 'backup-20261017T040000000Z.tar.gz');
  for (const hasPayload of [false, true]) {
    await fs.writeFile(path.join(payload, 'uploads', 'old.webp'), 'corrupt');
    await tar.c({ cwd: payload, file: archive, gzip: true }, ['manifest.json', ...(hasPayload ? ['uploads/old.webp'] : [])]);
    const result = await cleanupOrphanUploads(config, { delete: true, now });
    assert.equal(result.deleted.length, 0);
    assert.equal(result.uncovered.length, 1);
    assert.equal(result.coverageErrors.length, 1);
    assert.equal(await fs.readFile(target, 'utf8'), 'correct');
  }
});

test('格式冒充完整备份的部分包及含链接归档均不提供删除凭证', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-partial-coverage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = createConfig(root);
  initializeDatabase(config).close();
  const now = new Date('2026-10-17T04:00:00Z');
  const target = await writeUpload(config, 'old.webp', 'correct', new Date('2026-10-10T04:00:00Z'));
  const payload = path.join(root, 'payload');
  await fs.mkdir(path.join(payload, 'uploads'), { recursive: true });
  await fs.mkdir(config.backupDir, { recursive: true });
  await fs.writeFile(path.join(payload, 'uploads', 'old.webp'), 'correct');
  await fs.writeFile(path.join(payload, 'manifest.json'), JSON.stringify({ formatVersion: 2, excluded: [],
    files: [{ path: 'uploads/old.webp', size: 7, sha256: crypto.createHash('sha256').update('correct').digest('hex') }] }));
  const archive = path.join(config.backupDir, 'backup-20261017T040000000Z.tar.gz');
  await tar.c({ cwd: payload, file: archive, gzip: true }, ['manifest.json', 'uploads/old.webp']);
  const partial = await cleanupOrphanUploads(config, { delete: true, now });
  assert.equal(partial.deleted.length, 0);
  assert.equal(partial.uncovered.length, 1);
  assert.match(partial.coverageErrors[0].error, /complete backup/);
  // A hard-link tar entry is portable to Windows and must be rejected before
  // extraction, just like symlinks; do not require symlink privileges in tests.
  const entry = new tar.Header({ path: 'uploads/old.webp', type: 'Link', linkpath: 'outside', mode: 0o600, size: 0 });
  entry.encode();
  await fs.writeFile(archive, require('node:zlib').gzipSync(Buffer.concat([entry.block, Buffer.alloc(1024)])));
  const linked = await cleanupOrphanUploads(config, { delete: true, now });
  assert.equal(linked.deleted.length, 0);
  assert.equal(linked.uncovered.length, 1);
  assert.match(linked.coverageErrors[0].error, /unsafe or duplicate/);
  assert.equal(await fs.readFile(target, 'utf8'), 'correct');
});

test('镜像中的较早成功加密归档可覆盖；较新坏包不算覆盖、不阻断继续核验', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-mirror-coverage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { ...createConfig(root), backupEncryptionPassword: 'test-only-coverage-password',
    backupMirrorDir: path.join(root, 'mirror') };
  initializeDatabase(config).close();
  const now = new Date('2026-10-17T04:00:00Z');
  const target = await writeUpload(config, 'old.webp', 'covered', new Date('2026-10-10T04:00:00Z'));
  const backup = await createBackup(config, { now: new Date('2026-10-16T04:00:00Z') });
  await fs.unlink(backup.archivePath);
  await fs.writeFile(path.join(config.backupDir, 'backup-20261017T040000000Z.tar.gz'), 'broken gzip');
  const result = await cleanupOrphanUploads(config, { delete: true, now });
  assert.equal(result.deleted.length, 1);
  assert.equal(result.uncovered.length, 0);
  assert.equal(result.coverageErrors.length, 1);
  assert.equal(result.deleted[0].coveredBy, path.basename(backup.archivePath));
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

test('归档实体存在但与现有孤儿SHA-256不同则保留，不把文件名当覆盖', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-mismatch-coverage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = createConfig(root);
  initializeDatabase(config).close();
  const now = new Date('2026-10-17T04:00:00Z');
  const old = new Date('2026-10-10T04:00:00Z');
  const target = await writeUpload(config, 'old.webp', 'aaaa', old);
  await createBackup(config, { now });
  await writeUpload(config, 'old.webp', 'bbbb', old);
  const result = await cleanupOrphanUploads(config, { delete: true, now });
  assert.equal(result.deleted.length, 0);
  assert.equal(result.uncovered.length, 1);
  assert.equal(await fs.readFile(target, 'utf8'), 'bbbb');
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
