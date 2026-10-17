// Inventories and explicitly removes old upload-pool files that no live data references.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const Database = require('better-sqlite3');
const tar = require('tar');
const { decryptArchive } = require('./backup-service');
const { findBackupCoverage } = require('./backup-upload-coverage');

const MINIMUM_ORPHAN_UPLOAD_AGE_MS = 24 * 60 * 60 * 1000;
const ORPHAN_ROLLBACK_PREFIX = 'orphan-rollback';
// Deliberately not full-backup format 1/2: a partial upload archive must never be
// accepted by the full restore path that replaces the database and directories.
const ORPHAN_ROLLBACK_FORMAT = 'orphan-rollback-v1';
const STORED_UPLOAD_NAME_PATTERN = /^\d{10,}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]+$/i;

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fsSync.createReadStream(filePath), hash);
  return hash.digest('hex');
}

async function collectRegularFiles(directory, relativeRoot = '') {
  const exists = await fs.stat(directory).then((stat) => stat.isDirectory()).catch(() => false);
  if (!exists) return [];
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relativePath = path.posix.join(relativeRoot, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Orphan upload inventory refuses symbolic link: ${relativePath}`);
    if (entry.isDirectory()) files.push(...await collectRegularFiles(absolutePath, relativePath));
    if (entry.isFile() && entry.name !== '.gitkeep') files.push({ absolutePath, relativePath });
  }
  return files;
}

function markReferencesInValue(value, candidates, reference, references) {
  if (value === null || value === undefined) return;
  const haystack = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  for (const candidate of candidates) {
    if (candidate.tokens.some((token) => haystack.includes(token))) {
      references.get(candidate.relativePath).add(reference);
    }
  }
}

function collectDatabaseReferences(databasePath, candidates, references) {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const tables = database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all();
    for (const table of tables) {
      const rows = database.prepare(`SELECT * FROM ${quoteIdentifier(table.name)}`).iterate();
      let rowNumber = 0;
      for (const row of rows) {
        rowNumber += 1;
        for (const [column, value] of Object.entries(row)) {
          if (typeof value !== 'string' && !Buffer.isBuffer(value)) continue;
          markReferencesInValue(value, candidates, `database:${table.name}.${column}:row-${rowNumber}`, references);
        }
      }
    }
  } finally {
    database.close();
  }
}

async function collectFileReferences(directory, label, candidates, references) {
  const files = await collectRegularFiles(directory);
  if (files.length === 0 || candidates.length === 0) return;
  const maxTokenLength = Math.max(...candidates.flatMap((candidate) => candidate.tokens.map((token) => token.length)));
  for (const file of files) {
    const stream = fsSync.createReadStream(file.absolutePath);
    let overlap = Buffer.alloc(0);
    for await (const chunk of stream) {
      const searchable = overlap.length === 0 ? chunk : Buffer.concat([overlap, chunk]);
      for (const candidate of candidates) {
        if (candidate.tokens.some((token) => searchable.includes(token))) {
          references.get(candidate.relativePath).add(`${label}:${file.relativePath}`);
        }
      }
      overlap = searchable.subarray(Math.max(0, searchable.length - maxTokenLength + 1));
    }
  }
}

function candidateTokens(relativePath) {
  const filename = path.posix.basename(relativePath);
  return [...new Set([filename, relativePath, path.posix.join('uploads', relativePath)])]
    .map((value) => Buffer.from(value, 'utf8'));
}

async function inventoryOrphanUploads(config, options = {}) {
  const minimumAgeMs = options.minimumAgeMs ?? config.orphanUploadMinAgeMs
    ?? MINIMUM_ORPHAN_UPLOAD_AGE_MS;
  if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < MINIMUM_ORPHAN_UPLOAD_AGE_MS) {
    throw new Error(`Orphan upload minimum age must be at least ${MINIMUM_ORPHAN_UPLOAD_AGE_MS} milliseconds.`);
  }
  const nowMs = options.now instanceof Date ? options.now.getTime() : (options.now ?? Date.now());
  if (!Number.isFinite(nowMs)) throw new Error('Orphan upload inventory requires a valid current time.');

  const uploadFiles = await collectRegularFiles(config.uploadsDir);
  const candidates = [];
  for (const file of uploadFiles) {
    const stat = await fs.stat(file.absolutePath);
    candidates.push({
      ...file,
      archivePath: path.posix.join('uploads', file.relativePath),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ageMs: Math.max(0, nowMs - stat.mtimeMs),
      tokens: candidateTokens(file.relativePath),
    });
  }

  const references = new Map(candidates.map((candidate) => [candidate.relativePath, new Set()]));
  if (candidates.length > 0) {
    collectDatabaseReferences(config.databasePath, candidates, references);
    await collectFileReferences(config.contentDir, 'content', candidates, references);
    await collectFileReferences(config.labStorageDir, 'lab-storage', candidates, references);
  }

  const files = candidates.map(({ absolutePath, tokens, ...candidate }) => ({
    ...candidate,
    references: [...references.get(candidate.relativePath)].sort(),
  })).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const referenced = files.filter((file) => file.references.length > 0);
  const recentUnreferenced = files.filter((file) => file.references.length === 0 && file.ageMs < minimumAgeMs);
  const orphans = files.filter((file) => file.references.length === 0 && file.ageMs >= minimumAgeMs);
  return { minimumAgeMs, scannedAt: new Date(nowMs).toISOString(), files, referenced, recentUnreferenced, orphans };
}

function isRollbackUploadPath(value) {
  return typeof value === 'string' && value.startsWith('uploads/')
    && value.split('/').every((part) => part && part !== '.' && part !== '..' && !/[\\:\0]/.test(part));
}

// Resolve only ordinary directories; in particular do not restore through a link
// under uploads/. Existing files are never overwritten by this additive recovery.
async function rollbackUploadTarget(uploadsDir, archivePath) {
  if (!isRollbackUploadPath(archivePath)) throw new Error('Unsafe orphan rollback upload path.');
  const parts = archivePath.slice('uploads/'.length).split('/');
  let parent = path.resolve(uploadsDir);
  for (const part of ['', ...parts.slice(0, -1)]) {
    if (part) parent = path.join(parent, part);
    const stat = await fs.lstat(parent).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new Error('Orphan rollback target parent is not an ordinary directory.');
    }
  }
  return path.join(parent, parts.at(-1));
}

// Explicitly restore ONE new-format rollback archive, never auto-discover or parse
// legacy full archives. Validate the entire payload before writing missing uploads;
// do not touch SQLite/content/lab-storage or overwrite files uploaded since cleanup.
async function restoreOrphanRollback(config, archivePath, options = {}) {
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-orphan-recovery-'));
  try {
    let tarPath = archivePath;
    if (archivePath.endsWith('.enc')) {
      tarPath = path.join(stagingRoot, 'decrypted.tar.gz');
      await decryptArchive(archivePath, tarPath, options.encryptionPassword ?? config.backupEncryptionPassword);
    }
    const entries = [];
    await tar.t({ file: tarPath, strict: true, onReadEntry: (entry) => entries.push({ path: entry.path, type: entry.type }) });
    const paths = new Set();
    for (const entry of entries) {
      if (entry.type !== 'File' || (entry.path !== 'manifest.json' && !isRollbackUploadPath(entry.path))
          || paths.has(entry.path)) throw new Error('Orphan rollback archive contains an unsafe or duplicate entry.');
      paths.add(entry.path);
    }
    const unpacked = path.join(stagingRoot, 'unpacked');
    await fs.mkdir(unpacked);
    await tar.x({ cwd: unpacked, file: tarPath, preservePaths: false, strict: true,
      filter: (entryPath, entry) => entry.type === 'File' && paths.has(entryPath) });
    const manifest = JSON.parse(await fs.readFile(path.join(unpacked, 'manifest.json'), 'utf8'));
    if (manifest.formatVersion !== ORPHAN_ROLLBACK_FORMAT || !Array.isArray(manifest.files) || !manifest.files.length) {
      throw new Error('Not a new-format orphan rollback archive; use the existing full restore workflow for legacy full backups.');
    }
    const expected = new Set(['manifest.json']);
    const targets = [];
    for (const file of manifest.files) {
      if (!isRollbackUploadPath(file.path) || expected.has(file.path)
          || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[0-9a-f]{64}$/.test(file.sha256)) {
        throw new Error('Orphan rollback manifest contains invalid file metadata.');
      }
      expected.add(file.path);
      const source = path.join(unpacked, ...file.path.split('/'));
      const stat = await fs.lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size || await sha256(source) !== file.sha256) {
        throw new Error(`Orphan rollback checksum validation failed: ${file.path}`);
      }
      const target = await rollbackUploadTarget(config.uploadsDir, file.path);
      if (await fs.lstat(target).then(() => true, (error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      })) throw new Error(`Orphan rollback refuses to overwrite an existing upload: ${file.path}`);
      targets.push({ source, target, file });
    }
    if (expected.size !== paths.size || [...paths].some((entryPath) => !expected.has(entryPath))) {
      throw new Error('Orphan rollback archive contains undeclared files.');
    }
    for (const { source, file } of targets) {
      const target = await rollbackUploadTarget(config.uploadsDir, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target, fsSync.constants.COPYFILE_EXCL);
    }
    return { manifest, restored: targets.map(({ file }) => file) };
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

async function cleanupOrphanUploads(config, options = {}) {
  const initial = await inventoryOrphanUploads(config, options);
  if (options.delete !== true || initial.orphans.length === 0) {
    return { ...initial, deleteEnabled: options.delete === true, deleted: [], backup: null, changed: [], uncovered: [], coverageErrors: [] };
  }

  const hashed = [];
  for (const file of initial.orphans) {
    const source = await rollbackUploadTarget(config.uploadsDir, file.archivePath);
    const stat = await fs.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Orphan cleanup source is not a regular file.');
    hashed.push({ ...file, sha256: await sha256(source) });
  }
  const { coverage, errors: coverageErrors } = await findBackupCoverage(config, hashed);
  // Test seam exercises mutation AFTER archive verification, never bypasses it.
  if (options.beforeFinalScan) await options.beforeFinalScan();
  const afterBackup = await inventoryOrphanUploads(config, options);
  const initialByPath = new Map(hashed.map((file) => [file.relativePath, file]));
  const unchanged = afterBackup.orphans.filter((file) => {
    const previous = initialByPath.get(file.relativePath);
    return previous && previous.size === file.size && previous.mtimeMs === file.mtimeMs;
  });
  const unchangedPaths = new Set(unchanged.map((file) => file.relativePath));
  const changed = initial.orphans.filter((file) => !unchangedPaths.has(file.relativePath));
  const verified = [];
  const uncovered = [];
  for (const file of unchanged) {
    const proof = coverage.get(file.archivePath);
    if (!proof) {
      uncovered.push({ ...file, reason: 'no_matching_backup_payload' });
      continue;
    }
    const absolutePath = path.join(config.uploadsDir, ...file.relativePath.split('/'));
    const currentHash = await sha256(absolutePath);
    if (currentHash !== proof.sha256) {
      throw new Error(`Orphan upload changed after backup and will not be deleted: ${file.archivePath}`);
    }
    verified.push({ ...file, sha256: currentHash, coveredBy: proof.archive });
  }

  const deleted = [];
  for (const file of verified) {
    const absolutePath = await rollbackUploadTarget(config.uploadsDir, file.archivePath);
    const stat = await fs.lstat(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size || stat.mtimeMs !== file.mtimeMs) {
      changed.push(file);
      continue;
    }
    await fs.unlink(absolutePath);
    deleted.push(file);
  }

  return {
    ...afterBackup,
    deleteEnabled: true,
    deleted,
    changed,
    backup: null,
    uncovered,
    coverageErrors,
  };
}

async function deleteReplacedUploadIfUnreferenced(config, storedName) {
  const filename = String(storedName || '');
  if (!STORED_UPLOAD_NAME_PATTERN.test(filename) || path.posix.basename(filename) !== filename) {
    return { deleted: false, reason: 'invalid_name' };
  }
  const target = path.resolve(config.uploadsDir, filename);
  if (path.dirname(target) !== path.resolve(config.uploadsDir)) {
    return { deleted: false, reason: 'outside_uploads' };
  }
  const inventory = await inventoryOrphanUploads(config);
  const candidate = inventory.files.find((file) => file.relativePath === filename);
  if (!candidate) return { deleted: false, reason: 'missing' };
  if (candidate.references.length > 0) return { deleted: false, reason: 'referenced' };
  await fs.unlink(target);
  return { deleted: true, reason: 'unreferenced', filename };
}

function persistOrphanCleanupResult(config, result, error = null, now = new Date()) {
  const database = new Database(config.databasePath);
  try {
    const deleted = result?.deleted || [];
    const reclaimedBytes = deleted.reduce((total, file) => total + Number(file.size || 0), 0);
    // The existing optional message column also carries a non-error retention
    // notice when status=ok. No schema migration or lost restart history.
    const message = error ? String(error.message || error)
      : result?.uncovered?.length ? `保留 ${result.uncovered.length} 个孤儿：未获成功备份的归档实体及 SHA-256 覆盖。`
        + (result.coverageErrors?.length ? `另有 ${result.coverageErrors.length} 份归档无法验证，请检查备份。` : '') : null;
    database.prepare(`
      INSERT INTO orphan_cleanup_state (
        id, last_run_at, status, deleted_count, reclaimed_bytes, error_message
      ) VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        last_run_at = excluded.last_run_at,
        status = excluded.status,
        deleted_count = excluded.deleted_count,
        reclaimed_bytes = excluded.reclaimed_bytes,
        error_message = excluded.error_message
    `).run(
      now.toISOString(),
      error ? 'error' : 'ok',
      deleted.length,
      reclaimedBytes,
      message,
    );
    return { lastRunAt: now.toISOString(), status: error ? 'error' : 'ok', deletedCount: deleted.length, reclaimedBytes };
  } finally {
    database.close();
  }
}

function readOrphanCleanupState(database) {
  return database.prepare(`
    SELECT last_run_at AS lastRunAt, status, deleted_count AS deletedCount,
      reclaimed_bytes AS reclaimedBytes, error_message AS errorMessage
    FROM orphan_cleanup_state WHERE id = 1
  `).get() || null;
}

module.exports = {
  MINIMUM_ORPHAN_UPLOAD_AGE_MS,
  ORPHAN_ROLLBACK_PREFIX,
  ORPHAN_ROLLBACK_FORMAT,
  STORED_UPLOAD_NAME_PATTERN,
  cleanupOrphanUploads,
  deleteReplacedUploadIfUnreferenced,
  inventoryOrphanUploads,
  persistOrphanCleanupResult,
  readOrphanCleanupState,
  restoreOrphanRollback,
};
