// Creates, verifies and restores complete local snapshots of SQLite, Markdown and uploads.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const Database = require('better-sqlite3');
const tar = require('tar');
const { atomicWriteFile } = require('../lib/atomic-file');

const FORMAT_VERSION = 1;
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

async function collectFiles(directory, relativeRoot = '') {
  const collected = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relativePath = path.posix.join(relativeRoot, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Backup refuses symbolic link: ${relativePath}`);
    if (entry.isDirectory()) collected.push(...await collectFiles(absolutePath, relativePath));
    if (entry.isFile() && entry.name !== '.gitkeep' && !entry.name.includes('.tmp-')) {
      collected.push({ absolutePath, relativePath });
    }
  }
  return collected;
}

async function copyBackupDirectory(source, destination, archiveRoot) {
  await fs.mkdir(destination, { recursive: true });
  const sourceExists = await fs.stat(source).then((value) => value.isDirectory()).catch(() => false);
  if (!sourceExists) return [];
  const files = await collectFiles(source);
  for (const file of files) {
    const destinationPath = path.join(destination, ...file.relativePath.split('/'));
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(file.absolutePath, destinationPath);
  }
  return files.map((file) => path.posix.join(archiveRoot, file.relativePath));
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

async function pruneBackups(backupDir, retentionCount) {
  const candidates = (await fs.readdir(backupDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^backup-\d{8}T\d{9}Z\.tar\.gz(?:\.enc)?$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const removed = candidates.slice(retentionCount);
  await Promise.all(removed.map((name) => fs.unlink(path.join(backupDir, name))));
  return removed;
}

async function createBackup(config, options = {}) {
  const now = options.now || new Date();
  const retentionCount = options.retentionCount ?? config.backupRetentionCount ?? 7;
  const password = options.encryptionPassword ?? config.backupEncryptionPassword ?? '';
  if (!Number.isSafeInteger(retentionCount) || retentionCount <= 0) {
    throw new Error('Backup retention count must be a positive integer.');
  }
  await fs.mkdir(config.backupDir, { recursive: true });
  const baseName = `backup-${archiveTimestamp(now)}.tar.gz`;
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
    archivePaths.push(...await copyBackupDirectory(
      path.join(config.contentDir, 'works'),
      path.join(stagingRoot, 'content', 'works'),
      'content/works',
    ));
    archivePaths.push(...await copyBackupDirectory(
      path.join(config.contentDir, 'notes'),
      path.join(stagingRoot, 'content', 'notes'),
      'content/notes',
    ));
    archivePaths.push(...await copyBackupDirectory(
      config.uploadsDir,
      path.join(stagingRoot, 'uploads'),
      'uploads',
    ));

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
    };
    await fs.writeFile(path.join(stagingRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await tar.c({
      cwd: stagingRoot,
      file: temporaryArchive,
      gzip: true,
      portable: true,
    }, ['manifest.json', 'data', 'content', 'uploads']);

    if (password) {
      const encryptedTemporary = `${temporaryArchive}.enc`;
      await encryptArchive(temporaryArchive, encryptedTemporary, password);
      await fs.unlink(temporaryArchive);
      await fs.rename(encryptedTemporary, finalPath);
    } else {
      await fs.rename(temporaryArchive, finalPath);
    }
    const removed = await pruneBackups(config.backupDir, retentionCount);
    return { archivePath: finalPath, manifest, removed };
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
  if (manifest.formatVersion !== FORMAT_VERSION || !Array.isArray(manifest.files)) {
    throw new Error('Backup manifest format is unsupported.');
  }
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
  const actualFiles = (await collectFiles(root))
    .map((file) => file.relativePath)
    .filter((relativePath) => relativePath !== 'manifest.json');
  if (actualFiles.length !== expected.size || actualFiles.some((file) => !expected.has(file))) {
    throw new Error('Backup archive contains files not declared by its manifest.');
  }
  return manifest;
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

    const databaseBytes = await fs.readFile(path.join(unpackedRoot, 'data', 'admin.sqlite3'));
    await atomicWriteFile(config.databasePath, databaseBytes);
    await fs.unlink(`${config.databasePath}-wal`).catch(() => {});
    await fs.unlink(`${config.databasePath}-shm`).catch(() => {});
    await replaceDirectory(path.join(unpackedRoot, 'content', 'works'), path.join(config.contentDir, 'works'));
    await replaceDirectory(path.join(unpackedRoot, 'content', 'notes'), path.join(config.contentDir, 'notes'));
    await replaceDirectory(path.join(unpackedRoot, 'uploads'), config.uploadsDir);
    return { manifest };
  } finally {
    await fs.rm(extractionRoot, { recursive: true, force: true });
  }
}

module.exports = {
  archiveTimestamp,
  createBackup,
  decryptArchive,
  encryptArchive,
  pruneBackups,
  restoreBackup,
  verifyExtractedBackup,
};
