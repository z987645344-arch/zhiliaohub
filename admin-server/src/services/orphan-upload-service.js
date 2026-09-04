// Inventories and explicitly removes old upload-pool files that no live data references.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const Database = require('better-sqlite3');
const { createBackup } = require('./backup-service');

const MINIMUM_ORPHAN_UPLOAD_AGE_MS = 24 * 60 * 60 * 1000;

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

async function cleanupOrphanUploads(config, options = {}) {
  const initial = await inventoryOrphanUploads(config, options);
  if (options.delete !== true || initial.orphans.length === 0) {
    return { ...initial, deleteEnabled: options.delete === true, deleted: [], backup: null, changed: [] };
  }

  // This manual backup is the rollback point. Force ZIP inclusion even when routine
  // archives omit ZIP contents; otherwise deleting an orphan ZIP would not be reversible.
  const backup = await createBackup({ ...config, backupExcludeZip: false }, options.backupOptions);
  const afterBackup = await inventoryOrphanUploads(config, options);
  const initialByPath = new Map(initial.orphans.map((file) => [file.relativePath, file]));
  const unchanged = afterBackup.orphans.filter((file) => {
    const previous = initialByPath.get(file.relativePath);
    return previous && previous.size === file.size && previous.mtimeMs === file.mtimeMs;
  });
  const unchangedPaths = new Set(unchanged.map((file) => file.relativePath));
  const changed = initial.orphans.filter((file) => !unchangedPaths.has(file.relativePath));
  const manifestFiles = new Map(backup.manifest.files.map((file) => [file.path, file]));
  const verified = [];
  for (const file of unchanged) {
    const manifestFile = manifestFiles.get(file.archivePath);
    if (!manifestFile || manifestFile.size !== file.size) {
      throw new Error(`Cleanup backup does not contain orphan upload: ${file.archivePath}`);
    }
    const absolutePath = path.join(config.uploadsDir, ...file.relativePath.split('/'));
    const currentHash = await sha256(absolutePath);
    if (currentHash !== manifestFile.sha256) {
      throw new Error(`Orphan upload changed after backup and will not be deleted: ${file.archivePath}`);
    }
    verified.push({ ...file, sha256: currentHash });
  }

  const deleted = [];
  for (const file of verified) {
    const absolutePath = path.join(config.uploadsDir, ...file.relativePath.split('/'));
    const stat = await fs.stat(absolutePath);
    if (stat.size !== file.size || stat.mtimeMs !== file.mtimeMs) {
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
    backup: { archivePath: backup.archivePath, manifest: backup.manifest },
  };
}

module.exports = { MINIMUM_ORPHAN_UPLOAD_AGE_MS, cleanupOrphanUploads, inventoryOrphanUploads };
