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

function booleanFlag(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(String(value).trim().toLowerCase());
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
    // Automatic pre-restore snapshots prune against their own count, so a regular backup
    // schedule can never evict the snapshot a restore just created.
    preRestoreRetentionCount: positiveInteger(
      overrides.preRestoreRetentionCount ?? process.env.PRE_RESTORE_RETENTION_COUNT,
      'PRE_RESTORE_RETENTION_COUNT',
      3,
    ),
    // In-process daily backup trigger; see services/backup-scheduler.js.
    backupScheduleEnabled: overrides.backupScheduleEnabled
      ?? booleanFlag(process.env.BACKUP_SCHEDULE_ENABLED, true),
    backupIntervalMs: positiveInteger(
      overrides.backupIntervalMs ?? process.env.BACKUP_INTERVAL_MS,
      'BACKUP_INTERVAL_MS',
      24 * 60 * 60 * 1000,
    ),
    backupScheduleCheckIntervalMs: positiveInteger(
      overrides.backupScheduleCheckIntervalMs ?? process.env.BACKUP_SCHEDULE_CHECK_INTERVAL_MS,
      'BACKUP_SCHEDULE_CHECK_INTERVAL_MS',
      15 * 60 * 1000,
    ),
    // Secondary copy target. Empty disables replication. Today this can only be another
    // local directory, which is a simulation and NOT real off-site protection.
    backupMirrorDir: overrides.backupMirrorDir
      ?? (process.env.BACKUP_MIRROR_DIR ? resolveLocalPath(process.env.BACKUP_MIRROR_DIR, '') : ''),
    backupEncryptionPassword: overrides.backupEncryptionPassword
      ?? process.env.BACKUP_ENCRYPTION_PASSWORD
      ?? '',
  };
}

module.exports = { loadBackupConfig };
