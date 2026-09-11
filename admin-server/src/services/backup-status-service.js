// Computes one authenticated, presentation-ready view of scheduled-backup freshness.
// The scheduler and this service deliberately share lastBackupAt() and the UTC+8 boundary
// calculation. Status must not grow a second clock model that can drift from actual triggering.
const {
  lastBackupAt,
  scheduledBoundaryAtOrBefore,
} = require('./backup-scheduler');

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const BACKUP_STATUS_GRACE_SECONDS = 7200;
const BACKUP_STATUS_GRACE_MS = BACKUP_STATUS_GRACE_SECONDS * 1000;

function relativeAge(ageMs) {
  const safeAge = Math.max(0, ageMs);
  if (safeAge < MINUTE_MS) return '刚刚';
  if (safeAge < HOUR_MS) return `${Math.floor(safeAge / MINUTE_MS)}分钟前`;
  if (safeAge < 48 * HOUR_MS) return `${Math.floor(safeAge / HOUR_MS)}小时前`;
  return `${Math.floor(safeAge / (24 * HOUR_MS))}天前`;
}

function isUnreadableDirectoryError(error) {
  return ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(error?.code);
}

function statusResult(status, reason, label, hint, details = {}) {
  return { status, reason, label, hint, ...details };
}

class BackupStatusService {
  constructor(config, options = {}) {
    this.backupDir = config.backupDir;
    this.scheduleEnabled = config.backupScheduleEnabled !== false;
    this.localTime = config.backupScheduleLocalTime ?? '00:00';
    this.now = options.now || (() => new Date());
    this.findLastBackupAt = options.lastBackupAt || lastBackupAt;
    this.boundaryAtOrBefore = options.scheduledBoundaryAtOrBefore || scheduledBoundaryAtOrBefore;
    // Validate the shared schedule expression during construction, not on the first UI request.
    this.boundaryAtOrBefore(new Date(0), this.localTime);
  }

  async getStatus() {
    if (!this.scheduleEnabled) {
      return statusResult(
        'disabled',
        'scheduler_disabled',
        '已停用',
        '调度备份已关闭；这是合法配置，不代表备份失败。',
        { lastSuccessfulAt: null, activeBoundaryAt: null },
      );
    }

    const now = this.now();
    let activeBoundary;
    let lastSuccessfulAt;
    try {
      activeBoundary = this.boundaryAtOrBefore(now, this.localTime);
      lastSuccessfulAt = await this.findLastBackupAt(this.backupDir, { strict: true });
    } catch (error) {
      const unreadable = isUnreadableDirectoryError(error);
      return statusResult(
        'unknown',
        unreadable ? 'backup_dir_unreadable' : 'internal_error',
        '未知',
        unreadable
          ? '备份目录无法读取，当前不能判断调度备份是否正常。'
          : '计算备份状态时发生异常，当前不能判断调度备份是否正常。',
        { lastSuccessfulAt: null, activeBoundaryAt: null },
      );
    }

    const boundaryIso = activeBoundary.toISOString();
    if (!lastSuccessfulAt) {
      return statusResult(
        'stale',
        'no_archive_at_all',
        '已超期',
        '尚未发现任何成功的调度备份。',
        { lastSuccessfulAt: null, activeBoundaryAt: boundaryIso },
      );
    }

    const lastIso = lastSuccessfulAt.toISOString();
    const age = relativeAge(now.getTime() - lastSuccessfulAt.getTime());
    if (lastSuccessfulAt >= activeBoundary) {
      return statusResult(
        'ok',
        'current_window_archived',
        '正常',
        `当前调度窗口已有成功备份，最近一次成功于${age}。`,
        { lastSuccessfulAt: lastIso, activeBoundaryAt: boundaryIso },
      );
    }

    if (now.getTime() - activeBoundary.getTime() < BACKUP_STATUS_GRACE_MS) {
      return statusResult(
        'ok',
        'within_grace',
        '宽限期内',
        `当前调度窗口仍在2小时宽限期内，最近一次成功于${age}。`,
        { lastSuccessfulAt: lastIso, activeBoundaryAt: boundaryIso },
      );
    }

    return statusResult(
      'stale',
      'no_archive_in_window',
      '已超期',
      `当前调度窗口尚无成功备份，最近一次成功于${age}。`,
      { lastSuccessfulAt: lastIso, activeBoundaryAt: boundaryIso },
    );
  }
}

module.exports = {
  BACKUP_STATUS_GRACE_SECONDS,
  BackupStatusService,
  relativeAge,
};
