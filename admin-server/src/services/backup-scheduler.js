// In-process daily backup trigger.
//
// Deliberately not an OS-level cron entry: the service is meant to run containerised, and a
// cron job living outside the container would not ship with the image. A plain interval
// inside the long-running process behaves identically everywhere.
//
// "When did we last back up?" is answered by reading the newest backup-<timestamp> archive
// already sitting in the backup directory, rather than by keeping a separate state file.
// That makes restarts safe for free: the answer survives process death, a restart shortly
// after a backup will not trigger a duplicate, and a restart after a long outage notices the
// backup is overdue and takes one immediately.
const fs = require('node:fs/promises');
const { BACKUP_PREFIX, createBackup } = require('./backup-service');

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CHECK_INTERVAL_MS = 15 * 60 * 1000;

// Matches the archiveTimestamp() format: YYYYMMDD 'T' HHMMSSmmm 'Z'.
const ARCHIVE_PATTERN = new RegExp(`^${BACKUP_PREFIX}-(\\d{8})T(\\d{9})Z\\.tar\\.gz(?:\\.enc)?$`);

// Picks a unit that stays readable at both the 24-hour default and the short intervals used
// in tests; a fixed "hours" unit prints a meaningless "every 0 hours" for anything smaller.
function formatDuration(milliseconds) {
  if (milliseconds >= 3600000) return `${Math.round(milliseconds / 3600000)} 小时`;
  if (milliseconds >= 60000) return `${Math.round(milliseconds / 60000)} 分钟`;
  if (milliseconds >= 1000) return `${Math.round(milliseconds / 1000)} 秒`;
  return `${milliseconds} 毫秒`;
}

function parseArchiveTimestamp(name) {
  const match = ARCHIVE_PATTERN.exec(name);
  if (!match) return null;
  const [, date, time] = match;
  const value = new Date(
    `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
    + `T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}.${time.slice(6, 9)}Z`,
  );
  return Number.isNaN(value.getTime()) ? null : value;
}

async function lastBackupAt(backupDir) {
  const entries = await fs.readdir(backupDir).catch(() => []);
  let newest = null;
  for (const name of entries) {
    const at = parseArchiveTimestamp(name);
    if (at && (!newest || at > newest)) newest = at;
  }
  return newest;
}

class BackupScheduler {
  constructor(config, options = {}) {
    this.config = config;
    this.intervalMs = config.backupIntervalMs ?? DEFAULT_INTERVAL_MS;
    this.checkIntervalMs = config.backupScheduleCheckIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.createBackup = options.createBackup || createBackup;
    this.now = options.now || (() => new Date());
    this.logger = options.logger || console;
    this.timer = null;
    this.inFlight = false;
    this.createdCount = 0;
    this.failureCount = 0;
  }

  // Runs one due-check. Never rejects: a scheduled job that throws into an interval handler
  // would be an unhandled rejection, and a silent one at that.
  async tick() {
    if (this.inFlight) return { skipped: true, reason: 'previous backup still running' };
    this.inFlight = true;
    try {
      const now = this.now();
      const last = await lastBackupAt(this.config.backupDir);
      if (last && now.getTime() - last.getTime() < this.intervalMs) {
        return { skipped: true, reason: 'not due yet', lastBackupAt: last };
      }
      const result = await this.createBackup(this.config, { now });
      this.createdCount += 1;
      this.logger.log(`[backup] 定时备份已创建：${result.archivePath}`);
      if (result.replication?.ok) {
        this.logger.log(`[backup] 已同步到${result.replication.destination}：${result.replication.location}`);
      } else if (result.replication && !result.replication.skipped) {
        this.logger.error(`[backup] 定时备份的异地同步失败：${result.replication.error}（本地备份仍然有效）`);
      }
      return { created: true, result, lastBackupAt: last };
    } catch (error) {
      // Loud on purpose. A backup system that fails quietly is worse than none, because it
      // produces confidence without protection.
      this.failureCount += 1;
      this.logger.error(
        `[backup] 定时备份失败（连续第${this.failureCount}次）：${error.message}\n`
        + '[backup] 现在没有产生新的备份。请检查磁盘空间与备份目录权限；'
        + '在修复之前，可恢复的最新数据仍然停留在上一次成功备份的时间点。',
      );
      return { failed: true, error };
    } finally {
      this.inFlight = false;
    }
  }

  start() {
    if (this.config.backupScheduleEnabled === false) {
      this.logger.log('[backup] 定时备份已通过 BACKUP_SCHEDULE_ENABLED=false 关闭；只能手动运行 npm run backup。');
      return this;
    }
    // Check once at boot so a restart cannot make an overdue backup wait a whole interval.
    this.tick();
    this.timer = setInterval(() => { this.tick(); }, this.checkIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.logger.log(
      `[backup] 定时备份已启用：每 ${formatDuration(this.intervalMs)}一次，`
      + `每 ${formatDuration(this.checkIntervalMs)}检查一次是否到期。`,
    );
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this;
  }
}

module.exports = { BackupScheduler, lastBackupAt, parseArchiveTimestamp };
