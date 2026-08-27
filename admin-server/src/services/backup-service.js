// Creates, verifies and restores local snapshots of SQLite, Markdown, uploads and lab projects.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const Database = require('better-sqlite3');
const tar = require('tar');
const { atomicWriteFile } = require('../lib/atomic-file');
const { createBackupDestination } = require('./backup-destination');

const FORMAT_VERSION = 2;
const SUPPORTED_FORMAT_VERSIONS = new Set([1, FORMAT_VERSION]);
// Regular backups and automatic pre-restore snapshots share one directory but use
// different filename prefixes, so each prunes against its own retention count and a
// fresh pre-restore snapshot can never be evicted by the regular "latest N" policy.
const BACKUP_PREFIX = 'backup';
const PRE_RESTORE_PREFIX = 'pre-restore';
const DEFAULT_PRE_RESTORE_RETENTION = 3;
const ENCRYPTION_MAGIC = Buffer.from('ZHBACKUP1');
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = ENCRYPTION_MAGIC.length + SALT_BYTES + IV_BYTES;

function validateEncryptionPassword(password) {
  if (password && password.length < 16) {
    throw new Error('Backup encryption password must contain at least 16 characters.');
  }
}

function archiveTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, (value) => `${value.slice(1, 4)}Z`);
}

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fsSync.createReadStream(filePath), hash);
  return hash.digest('hex');
}

function isAtomicContentTemporaryFile(relativePath) {
  const filename = path.posix.basename(relativePath);
  return /^[^/]+\.tmp-\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(filename);
}

async function collectFiles(directory, relativeRoot = '') {
  const collected = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relativePath = path.posix.join(relativeRoot, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Backup refuses symbolic link: ${relativePath}`);
    if (entry.isDirectory()) collected.push(...await collectFiles(absolutePath, relativePath));
    if (entry.isFile() && entry.name !== '.gitkeep') {
      collected.push({ absolutePath, relativePath });
    }
  }
  return collected;
}

async function copyBackupDirectory(source, destination, archiveRoot, options = {}) {
  await fs.mkdir(destination, { recursive: true });
  const sourceExists = await fs.stat(source).then((value) => value.isDirectory()).catch(() => false);
  if (!sourceExists) return { files: [], excluded: [] };
  const files = await collectFiles(source);
  const copied = [];
  const excluded = [];
  for (const file of files) {
    const archivePath = path.posix.join(archiveRoot, file.relativePath);
    if (options.exclude?.(file.relativePath)) {
      if (options.recordExcluded !== false) {
        const stat = await fs.stat(file.absolutePath);
        excluded.push({ path: archivePath, size: stat.size, sha256: await sha256(file.absolutePath) });
      }
      continue;
    }
    const destinationPath = path.join(destination, ...file.relativePath.split('/'));
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(file.absolutePath, destinationPath);
    copied.push(archivePath);
  }
  return { files: copied, excluded };
}

async function encryptArchive(source, destination, password) {
  validateEncryptionPassword(password);
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = crypto.scryptSync(password, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  await fs.writeFile(destination, Buffer.concat([ENCRYPTION_MAGIC, salt, iv]), { flag: 'wx' });
  await pipeline(
    fsSync.createReadStream(source),
    cipher,
    fsSync.createWriteStream(destination, { flags: 'a' }),
  );
  await fs.appendFile(destination, cipher.getAuthTag());
}

async function decryptArchive(source, destination, password) {
  if (!password) throw new Error('BACKUP_ENCRYPTION_PASSWORD is required for this encrypted backup.');
  validateEncryptionPassword(password);
  const stat = await fs.stat(source);
  if (stat.size <= HEADER_BYTES + TAG_BYTES) throw new Error('Encrypted backup is truncated.');
  const handle = await fs.open(source, 'r');
  const header = Buffer.alloc(HEADER_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    await handle.read(header, 0, header.length, 0);
    await handle.read(tag, 0, tag.length, stat.size - TAG_BYTES);
  } finally {
    await handle.close();
  }
  if (!header.subarray(0, ENCRYPTION_MAGIC.length).equals(ENCRYPTION_MAGIC)) {
    throw new Error('Encrypted backup header is invalid.');
  }
  const saltStart = ENCRYPTION_MAGIC.length;
  const salt = header.subarray(saltStart, saltStart + SALT_BYTES);
  const iv = header.subarray(saltStart + SALT_BYTES);
  const key = crypto.scryptSync(password, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  await pipeline(
    fsSync.createReadStream(source, { start: HEADER_BYTES, end: stat.size - TAG_BYTES - 1 }),
    decipher,
    fsSync.createWriteStream(destination, { flags: 'wx' }),
  );
}

async function pruneBackups(backupDir, retentionCount, namePrefix = BACKUP_PREFIX) {
  const pattern = new RegExp(`^${namePrefix}-\\d{8}T\\d{9}Z\\.tar\\.gz(?:\\.enc)?$`);
  const candidates = (await fs.readdir(backupDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const removed = candidates.slice(retentionCount);
  await Promise.all(removed.map((name) => fs.unlink(path.join(backupDir, name))));
  return removed;
}

// Copies a finished archive to the configured secondary destination. The local archive is
// already complete and is the primary copy, so a replication failure is reported and logged
// but never rethrown: it must not turn a successful backup into a failed one, and it must
// never remove or rewrite the local file.
async function replicateArchive(config, archivePath, options = {}) {
  const destination = options.destination ?? createBackupDestination(config);
  if (!destination) return { skipped: true, reason: 'no secondary backup destination configured' };
  try {
    const { location } = await destination.send(archivePath);
    let removed = [];
    if (typeof destination.prune === 'function') {
      removed = await destination.prune(options.namePrefix, options.retentionCount);
    }
    return { ok: true, destination: destination.name, location, removed };
  } catch (error) {
    console.error(
      `[backup] 本地归档已生成成功：${archivePath}\n`
      + `[backup] 但同步到${destination.describe()}失败：${error.message}\n`
      + '[backup] 本地备份不受影响，仍可正常用于恢复；请检查该目的地后手动补一次同步。',
    );
    return { ok: false, destination: destination.name, error: error.message };
  }
}

async function createBackup(config, options = {}) {
  const now = options.now || new Date();
  const namePrefix = options.namePrefix || BACKUP_PREFIX;
  const retentionCount = options.retentionCount ?? config.backupRetentionCount ?? 3;
  const password = options.encryptionPassword ?? config.backupEncryptionPassword ?? '';
  if (!Number.isSafeInteger(retentionCount) || retentionCount <= 0) {
    throw new Error('Backup retention count must be a positive integer.');
  }
  await fs.mkdir(config.backupDir, { recursive: true });
  const baseName = `${namePrefix}-${archiveTimestamp(now)}.tar.gz`;
  const finalPath = path.join(config.backupDir, password ? `${baseName}.enc` : baseName);
  if (await fs.stat(finalPath).then(() => true).catch(() => false)) {
    throw new Error(`Backup archive already exists: ${path.basename(finalPath)}`);
  }
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-backup-'));
  const temporaryArchive = path.join(config.backupDir, `.backup-${crypto.randomUUID()}.tar.gz.tmp`);

  try {
    const stagedDatabase = path.join(stagingRoot, 'data', 'admin.sqlite3');
    await fs.mkdir(path.dirname(stagedDatabase), { recursive: true });
    const sourceDatabase = new Database(config.databasePath, { readonly: true, fileMustExist: true });
    try {
      await sourceDatabase.backup(stagedDatabase);
    } finally {
      sourceDatabase.close();
    }

    const archivePaths = ['data/admin.sqlite3'];
    const works = await copyBackupDirectory(
      path.join(config.contentDir, 'works'),
      path.join(stagingRoot, 'content', 'works'),
      'content/works',
      {
        exclude: isAtomicContentTemporaryFile,
        recordExcluded: false,
      },
    );
    archivePaths.push(...works.files);
    const notes = await copyBackupDirectory(
      path.join(config.contentDir, 'notes'),
      path.join(stagingRoot, 'content', 'notes'),
      'content/notes',
      {
        exclude: isAtomicContentTemporaryFile,
        recordExcluded: false,
      },
    );
    archivePaths.push(...notes.files);
    const uploads = await copyBackupDirectory(
      config.uploadsDir,
      path.join(stagingRoot, 'uploads'),
      'uploads',
      {
        exclude: config.backupExcludeZip
          ? (relativePath) => relativePath.toLowerCase().endsWith('.zip')
          : undefined,
      },
    );
    archivePaths.push(...uploads.files);
    const labStorage = await copyBackupDirectory(
      config.labStorageDir,
      path.join(stagingRoot, 'lab-storage'),
      'lab-storage',
      {
        exclude: (relativePath) => {
          const rootDirectory = relativePath.split('/')[0];
          return rootDirectory.startsWith('.pending-') || rootDirectory.startsWith('.deleted-');
        },
        // These are incomplete transactional directories, not recoverable source files.
        // Keep manifest.excluded reserved for intentionally omitted uploads ZIP files.
        recordExcluded: false,
      },
    );
    archivePaths.push(...labStorage.files);

    const files = [];
    for (const relativePath of [...new Set(archivePaths)].sort()) {
      const absolutePath = path.join(stagingRoot, ...relativePath.split('/'));
      const stat = await fs.stat(absolutePath);
      files.push({ path: relativePath, size: stat.size, sha256: await sha256(absolutePath) });
    }
    const manifest = {
      formatVersion: FORMAT_VERSION,
      createdAt: now.toISOString(),
      encryption: password ? 'aes-256-gcm+scrypt' : 'none',
      files,
      excluded: uploads.excluded.sort((left, right) => left.path.localeCompare(right.path)),
    };
    await fs.writeFile(path.join(stagingRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await tar.c({
      cwd: stagingRoot,
      file: temporaryArchive,
      gzip: true,
      portable: true,
    }, ['manifest.json', 'data', 'content', 'uploads', 'lab-storage']);

    if (password) {
      const encryptedTemporary = `${temporaryArchive}.enc`;
      await encryptArchive(temporaryArchive, encryptedTemporary, password);
      await fs.unlink(temporaryArchive);
      await fs.rename(encryptedTemporary, finalPath);
    } else {
      await fs.rename(temporaryArchive, finalPath);
    }
    const removed = await pruneBackups(config.backupDir, retentionCount, namePrefix);
    const replication = await replicateArchive(config, finalPath, {
      destination: options.destination,
      namePrefix,
      retentionCount,
    });
    return { archivePath: finalPath, manifest, removed, replication };
  } catch (error) {
    await fs.unlink(temporaryArchive).catch(() => {});
    await fs.unlink(`${temporaryArchive}.enc`).catch(() => {});
    throw error;
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

function safeArchivePath(value) {
  const normalized = path.posix.normalize(String(value).replaceAll('\\', '/'));
  return normalized !== '..'
    && !normalized.startsWith('../')
    && !path.posix.isAbsolute(normalized);
}

async function verifyExtractedBackup(root) {
  const manifestPath = path.join(root, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (!SUPPORTED_FORMAT_VERSIONS.has(manifest.formatVersion) || !Array.isArray(manifest.files)) {
    throw new Error('Backup manifest format is unsupported.');
  }
  if (manifest.formatVersion >= 2 && !Array.isArray(manifest.excluded)) {
    throw new Error('Backup manifest format is unsupported.');
  }
  const excluded = manifest.excluded ?? [];
  if (!Array.isArray(excluded)) throw new Error('Backup manifest format is unsupported.');
  const expected = new Set();
  for (const file of manifest.files) {
    if (!safeArchivePath(file.path) || expected.has(file.path)) throw new Error('Backup manifest contains an unsafe path.');
    expected.add(file.path);
    const absolutePath = path.resolve(root, ...file.path.split('/'));
    if (!absolutePath.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Backup file escaped extraction root.');
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile() || stat.size !== file.size || await sha256(absolutePath) !== file.sha256) {
      throw new Error(`Backup checksum validation failed: ${file.path}`);
    }
  }
  for (const file of excluded) {
    if (!safeArchivePath(file.path) || expected.has(file.path)) {
      throw new Error('Backup manifest contains an unsafe excluded path.');
    }
    if (!String(file.path).startsWith('uploads/') || !String(file.path).toLowerCase().endsWith('.zip')) {
      throw new Error('Backup manifest excluded entries may only describe ZIP files under uploads/.');
    }
    if (!Number.isSafeInteger(file.size) || file.size < 0 || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      throw new Error(`Backup manifest contains invalid excluded metadata: ${file.path}`);
    }
    expected.add(file.path);
  }
  const actualFiles = (await collectFiles(root))
    .map((file) => file.relativePath)
    .filter((relativePath) => relativePath !== 'manifest.json');
  const includedPaths = new Set(manifest.files.map((file) => file.path));
  if (actualFiles.length !== includedPaths.size || actualFiles.some((file) => !includedPaths.has(file))) {
    throw new Error('Backup archive contains files not declared by its manifest.');
  }
  manifest.excluded = excluded;
  return manifest;
}

function excludedRestoreWarnings(excluded) {
  if (!excluded.length) return [];
  return [
    `该备份按策略未包含 ${excluded.length} 个 ZIP 文件；恢复后相关下载记录会暂时缺少文件。`,
    '请从本地按 manifest.excluded 中的相对路径补齐，并逐一核对文件大小与 SHA-256。',
  ];
}

async function replaceDirectory(source, target) {
  const parent = path.dirname(target);
  const token = crypto.randomUUID();
  const replacement = path.join(parent, `.${path.basename(target)}.restore-${token}`);
  const rollback = path.join(parent, `.${path.basename(target)}.rollback-${token}`);
  await fs.mkdir(parent, { recursive: true });
  await fs.cp(source, replacement, { recursive: true, force: false });
  const targetExists = await fs.stat(target).then(() => true).catch(() => false);
  try {
    if (targetExists) await fs.rename(target, rollback);
    await fs.rename(replacement, target);
    if (targetExists) await fs.rm(rollback, { recursive: true, force: true });
  } catch (error) {
    await fs.rm(replacement, { recursive: true, force: true }).catch(() => {});
    if (targetExists && await fs.stat(rollback).then(() => true).catch(() => false)) {
      await fs.rename(rollback, target).catch(() => {});
    }
    throw error;
  }
}

// Captures the data that a restore is about to overwrite, so an operator who picked the
// wrong archive (or hit a failure part-way through) can still get back to this moment.
// Reuses createBackup unchanged, so the snapshot carries the same manifest, SHA-256
// checksums and optional encryption as any regular backup.
// Tells "this machine genuinely has no database yet" apart from "a database is there but
// cannot be inspected". Only the first is a safe reason to restore without a snapshot;
// the second means something is already wrong locally and must reach the operator instead
// of being silently treated as an empty machine.
async function inspectLiveDatabase(databasePath) {
  let stat = null;
  try {
    stat = await fs.stat(databasePath);
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false };
    throw new Error(
      `Restore aborted: the current database at ${databasePath} exists but could not be `
      + `inspected (${error.code || error.message}). This is not treated as an empty machine, `
      + 'because doing so would overwrite data that may still be recoverable. No data was '
      + 'modified. Check the file permissions and the disk, then retry.',
      { cause: error },
    );
  }
  if (!stat.isFile()) {
    throw new Error(
      `Restore aborted: ${databasePath} exists but is not a regular file. No data was modified. `
      + 'Check that the data directory is configured correctly, then retry.',
    );
  }
  return { exists: true };
}

async function createPreRestoreSnapshot(config, options = {}) {
  if (options.skipPreRestoreSnapshot) {
    return { skipped: true, reason: 'explicitly skipped by --skip-pre-restore-snapshot' };
  }
  // A restore onto a machine with no database yet has nothing to protect; that is the
  // only case allowed to proceed without a snapshot.
  const live = await inspectLiveDatabase(config.databasePath);
  if (!live.exists) {
    return { skipped: true, reason: 'no existing database to protect' };
  }
  try {
    return await createBackup(config, {
      namePrefix: PRE_RESTORE_PREFIX,
      now: options.now,
      retentionCount: config.preRestoreRetentionCount ?? DEFAULT_PRE_RESTORE_RETENTION,
    });
  } catch (error) {
    throw new Error(
      `Restore aborted: the pre-restore snapshot could not be created (${error.message}). `
      + 'The backup destination may be full or unwritable, or the current database may itself '
      + 'be damaged and unreadable — that second case needs a human look before overwriting it. '
      + 'No data was modified. Resolve the problem, or re-run with both --force and '
      + '--skip-pre-restore-snapshot to restore without a safety net.',
      { cause: error },
    );
  }
}

async function restoreBackup(config, archivePath, options = {}) {
  if (!options.force) throw new Error('Restore requires explicit force confirmation.');
  const extractionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-restore-'));
  const decryptedArchive = path.join(extractionRoot, 'archive.tar.gz');
  const encrypted = archivePath.endsWith('.enc');
  try {
    const tarPath = encrypted ? decryptedArchive : archivePath;
    if (encrypted) {
      await decryptArchive(
        archivePath,
        decryptedArchive,
        options.encryptionPassword ?? config.backupEncryptionPassword,
      );
    }
    const unpackedRoot = path.join(extractionRoot, 'unpacked');
    await fs.mkdir(unpackedRoot);
    await tar.x({
      cwd: unpackedRoot,
      file: tarPath,
      preservePaths: false,
      strict: true,
      filter: (entryPath) => safeArchivePath(entryPath),
    });
    const manifest = await verifyExtractedBackup(unpackedRoot);

    // Only snapshot once the incoming archive is known to be valid, and always before the
    // first destructive write below. A failure here throws and leaves the live data intact.
    const preRestoreSnapshot = await createPreRestoreSnapshot(config, options);

    const databaseBytes = await fs.readFile(path.join(unpackedRoot, 'data', 'admin.sqlite3'));
    await atomicWriteFile(config.databasePath, databaseBytes);
    await fs.unlink(`${config.databasePath}-wal`).catch(() => {});
    await fs.unlink(`${config.databasePath}-shm`).catch(() => {});
    await replaceDirectory(path.join(unpackedRoot, 'content', 'works'), path.join(config.contentDir, 'works'));
    await replaceDirectory(path.join(unpackedRoot, 'content', 'notes'), path.join(config.contentDir, 'notes'));
    await replaceDirectory(path.join(unpackedRoot, 'uploads'), config.uploadsDir);
    const archivedLabStorage = path.join(unpackedRoot, 'lab-storage');
    const hasArchivedLabStorage = await fs.stat(archivedLabStorage)
      .then((stat) => stat.isDirectory())
      .catch(() => false);
    // Archives created before lab-storage joined the backup set remain readable. They
    // cannot reconstruct lab projects, so preserve the pre-existing directory instead
    // of silently replacing it with an empty one.
    if (hasArchivedLabStorage) await replaceDirectory(archivedLabStorage, config.labStorageDir);
    return {
      manifest,
      preRestoreSnapshot,
      excludedFiles: manifest.excluded,
      warnings: excludedRestoreWarnings(manifest.excluded),
    };
  } finally {
    await fs.rm(extractionRoot, { recursive: true, force: true });
  }
}

module.exports = {
  BACKUP_PREFIX,
  DEFAULT_PRE_RESTORE_RETENTION,
  PRE_RESTORE_PREFIX,
  archiveTimestamp,
  createBackup,
  createPreRestoreSnapshot,
  decryptArchive,
  inspectLiveDatabase,
  replicateArchive,
  encryptArchive,
  excludedRestoreWarnings,
  pruneBackups,
  restoreBackup,
  verifyExtractedBackup,
};
