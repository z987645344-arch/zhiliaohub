// Deletion proof comes from verified archive payloads, never manifest.excluded.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const tar = require('tar');
const { decryptArchive, verifyExtractedBackup } = require('./backup-service');
const { withArchiveUse } = require('./archive-lease');

async function verifiedManifest(config, archivePath, root) {
  let tarPath = archivePath;
  if (archivePath.endsWith('.enc')) {
    tarPath = path.join(root, 'decrypted.tar.gz');
    await decryptArchive(archivePath, tarPath, config.backupEncryptionPassword);
  }
  // Preflight before extraction: no links, duplicate entries or path rewriting.
  const entries = new Map();
  let unsafe = false;
  await tar.t({ file: tarPath, strict: true, onReadEntry(entry) {
    const name = entry.path.replace(/\/$/, '');
    if (!name || /[\\:]/.test(name) || name.split('/').some((part) => !part || part === '.' || part === '..')
        || path.posix.isAbsolute(name) || !['File', 'Directory'].includes(entry.type) || entries.has(name)) {
      unsafe = true;
    }
    entries.set(name, entry.type);
  } });
  if (unsafe) throw new Error('Backup coverage archive contains unsafe or duplicate entries.');
  if (entries.get('manifest.json') !== 'File') throw new Error('Backup coverage manifest is missing.');
  const unpacked = path.join(root, 'unpacked');
  await fs.mkdir(unpacked);
  await tar.x({ file: tarPath, cwd: unpacked, strict: true, preservePaths: false,
    filter: (name, entry) => entries.get(name.replace(/\/$/, '')) === entry.type });
  // Existing verifier rehashes ALL included files and rejects missing/undeclared
  // payloads. excluded remains metadata only and is never indexed as coverage.
  const manifest = await verifyExtractedBackup(unpacked);
  if (!manifest.files.some((file) => file.path === 'data/admin.sqlite3')) {
    throw new Error('Backup coverage requires a complete backup, including its database payload.');
  }
  return manifest;
}

async function findBackupCoverage(config, candidates) {
  const coverage = new Map();
  const errors = [];
  const archives = [];
  for (const directory of [...new Set([config.backupDir, config.backupMirrorDir].filter(Boolean))]) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error.code !== 'ENOENT') errors.push({ archive: null, error: error.message });
      return [];
    });
    for (const entry of entries) {
      // Only completed full backups qualify. Do not open old orphan-rollback
      // archives, partial uploads, symlinks or temporary archive files.
      if (entry.isFile() && /^(?:scheduled-backup|pre-restore|backup)-\d{8}T\d{9}Z\.tar\.gz(?:\.enc)?$/.test(entry.name)) {
        archives.push(path.join(directory, entry.name));
      }
    }
  }
  archives.sort((a, b) => path.basename(b).replace(/^[a-z-]+-(?=\d)/, '')
    .localeCompare(path.basename(a).replace(/^[a-z-]+-(?=\d)/, '')));
  for (const archivePath of archives) {
    if (coverage.size === candidates.length) break;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-backup-coverage-'));
    try {
      const manifest = await withArchiveUse(archivePath, 'orphan-coverage-read',
        () => verifiedManifest(config, archivePath, root));
      const files = new Map(manifest.files.map((file) => [file.path, file]));
      for (const candidate of candidates) {
        const file = files.get(candidate.archivePath);
        if (file?.size === candidate.size && file.sha256 === candidate.sha256) {
          coverage.set(candidate.archivePath, { archive: path.basename(archivePath), sha256: file.sha256 });
        }
      }
    } catch (error) {
      // An unreadable/corrupt/wrong-password backup proves nothing. Keep searching
      // older good archives; otherwise retain the upload and report the failure.
      errors.push({ archive: path.basename(archivePath), error: error.message });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
  return { coverage, errors };
}

module.exports = { findBackupCoverage };
