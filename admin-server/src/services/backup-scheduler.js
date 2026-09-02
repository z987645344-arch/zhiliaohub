// In-process daily backup trigger.
//
// Deliberately not an OS-level cron entry: the service is meant to run containerised, and a
// cron job living outside the container would not ship with the image. The trigger uses an
// explicit fixed UTC+8 offset instead of the process timezone, because production containers
// may run in UTC and China Standard Time has no daylight-saving transitions.
//
// "When did the scheduler last back up?" is answered by reading the newest
// scheduled-backup-<timestamp> archive already sitting in the backup directory, rather
// than by keeping a separate state file. Manual and pre-restore archives deliberately do
// not satisfy the scheduled boundary.
// That makes restarts safe for free: the answer survives process death, a restart shortly
// after a backup will not trigger a duplicate, and a restart after a long outage notices the
// scheduled boundary has passed and takes one immediately.
const fs = require('node:fs/promises');
const { SCHEDULED_BACKUP_PREFIX, createBackup } = require('./backup-service');

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const UTC_PLUS_8_OFFSET_MS = 8 * 60 * 60 * 1000;
const DEFAULT_LOCAL_TIME = '00:00';

// Matches the archiveTimestamp() format: YYYYMMDD 'T' HHMMSSmmm 'Z'.
const ARCHIVE_PATTERN = new RegExp(`^${SCHEDULED_BACKUP_PREFIX}-(\\d{8})T(\\d{9})Z\\.tar\\.gz(?:\\.enc)?$`);

function parseLocalTime(value = DEFAULT_LOCAL_TIME) {
  const match = /^(?:([01]\d|2[0-3])):([0-5]\d)$/.exec(String(value));
  if (!match) throw new Error('Backup schedule local time must use 24-hour HH:MM format.');
  return (Number(match[1]) * 60) + Number(match[2]);
}

// Returns the most recent configured wall-clock boundary in an explicit UTC+8 timeline.
// It never calls getHours()/getDate(), so the host or container timezone cannot move the
// trigger to 08:00 China time by mistake.
function scheduledBoundaryAtOrBefore(now, localTime = DEFAULT_LOCAL_TIME) {
  const shiftedNow = now.getTime() + UTC_PLUS_8_OFFSET_MS;
  const shiftedDayStart = Math.floor(shiftedNow / DAY_MS) * DAY_MS;
  let shiftedBoundary = shiftedDayStart + (parseLocalTime(localTime) * MINUTE_MS);
  if (shiftedBoundary > shiftedNow) shiftedBoundary -= DAY_MS;
  return new Date(shiftedBoundary - UTC_PLUS_8_OFFSET_MS);
}

function nextScheduledAt(now, localTime = DEFAULT_LOCAL_TIME) {
  return new Date(scheduledBoundaryAtOrBefore(now, localTime).getTime() + DAY_MS);
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
    this.localTime = config.backupScheduleLocalTime ?? DEFAULT_LOCAL_TIME;
    parseLocalTime(this.localTime);
    this.createBackup = options.createBackup || createBackup;
    this.now = options.now || (() => new Date());
    this.logger = options.logger || console;
    this.setTimeout = options.setTimeout || setTimeout;
    this.clearTimeout = options.clearTimeout || clearTimeout;
    this.timer = null;
    this.stopped = false;
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
      const scheduledBoundaryAt = scheduledBoundaryAtOrBefore(now, this.localTime);
      if (last && last >= scheduledBoundaryAt) {
        return {
          skipped: true,
          reason: 'already backed up since scheduled boundary',
          lastBackupAt: last,
          scheduledBoundaryAt,
        };
      }
      const result = await this.createBackup(this.config, {
        now,
        namePrefix: SCHEDULED_BACKUP_PREFIX,
      });
      this.createdCount += 1;
      this.logger.log(`[backup] 定时备份已创建：${result.archivePath}`);
      if (result.replication?.ok) {
        this.logger.log(`[backup] 已同步到${result.replication.destination}：${result.replication.location}`);
      } else if (result.replication && !result.replication.skipped) {
        this.logger.error(`[backup] 定时备份的异地同步失败：${result.replication.error}（本地备份仍然有效）`);
      }
      return { created: true, result, lastBackupAt: last, scheduledBoundaryAt };
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
    this.stopped = false;
    // Check once at boot: an empty directory gets protection immediately, and a process
    // returning after a missed boundary catches up without waiting for tomorrow.
    this.tick();
    this.scheduleNext();
    this.logger.log(
      `[backup] 定时备份已启用：每日 UTC+8 ${this.localTime}；`
      + '启动时会读取现有归档并补做缺失的当日备份。',
    );
    return this;
  }

  scheduleNext() {
    const now = this.now();
    const scheduledAt = nextScheduledAt(now, this.localTime);
    const delay = Math.max(0, scheduledAt.getTime() - now.getTime());
    this.timer = this.setTimeout(async () => {
      this.timer = null;
      await this.tick();
      if (!this.stopped) this.scheduleNext();
    }, delay);
    if (typeof this.timer?.unref === 'function') this.timer.unref();
    return scheduledAt;
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.clearTimeout(this.timer);
    this.timer = null;
    return this;
  }
}

module.exports = {
  BackupScheduler,
  UTC_PLUS_8_OFFSET_MS,
  lastBackupAt,
  nextScheduledAt,
  parseArchiveTimestamp,
  scheduledBoundaryAtOrBefore,
};
