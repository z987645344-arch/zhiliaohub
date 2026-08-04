// Loads storage-only configuration for backup and restore commands without requiring login secrets.
const path = require('node:path');
const dotenv = require('dotenv');

const serverRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(serverRoot, '.env'), quiet: true });

function positiveInteger(value, name, fallback) {
  const candidate = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate <= 0) throw new Error(`${name} must be a positive integer.`);
  return candidate;
}

function resolveLocalPath(value, fallback) {
  return path.resolve(serverRoot, value || fallback);
}

function loadBackupConfig(overrides = {}) {
  const dataDir = overrides.dataDir || resolveLocalPath(process.env.DATA_DIR, 'data');
  return {
    serverRoot,
    dataDir,
    databasePath: overrides.databasePath || path.join(dataDir, 'admin.sqlite3'),
    contentDir: overrides.contentDir || resolveLocalPath(process.env.CONTENT_DIR, 'content'),
    uploadsDir: overrides.uploadsDir || resolveLocalPath(process.env.UPLOAD_DIR, 'uploads'),
    backupDir: overrides.backupDir || resolveLocalPath(process.env.BACKUP_DIR, 'backups'),
    backupRetentionCount: positiveInteger(
      overrides.backupRetentionCount ?? process.env.BACKUP_RETENTION_COUNT,
      'BACKUP_RETENTION_COUNT',
      7,
    ),
    backupEncryptionPassword: overrides.backupEncryptionPassword
      ?? process.env.BACKUP_ENCRYPTION_PASSWORD
      ?? '',
  };
}

module.exports = { loadBackupConfig };
