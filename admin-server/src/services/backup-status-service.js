// Computes one authenticated, presentation-ready view of scheduled-backup freshness.
const { lastBackupAt } = require('./backup-scheduler');

const HOUR_MS = 60 * 60 * 1000;

function relativeAge(ageMs) {
  const safeAge = Math.max(0, ageMs);
  if (safeAge < 60 * 1000) return '刚刚';
  if (safeAge < HOUR_MS) return `${Math.floor(safeAge / (60 * 1000))}分钟前`;
  if (safeAge < 48 * HOUR_MS) return `${Math.floor(safeAge / HOUR_MS)}小时前`;
  return `${Math.floor(safeAge / (24 * HOUR_MS))}天前`;
}

class BackupStatusService {
  constructor(config, options = {}) {
    this.backupDir = config.backupDir;
    this.overdueMs = config.backupStatusOverdueMs;
    this.now = options.now || (() => new Date());
    this.findLastBackupAt = options.lastBackupAt || lastBackupAt;
  }

  async getStatus() {
    const now = this.now();
    const lastSuccessfulAt = await this.findLastBackupAt(this.backupDir);
    if (!lastSuccessfulAt) {
      return {
        status: 'never',
        label: '从未成功过',
        description: '尚未发现成功的调度备份。',
        lastSuccessfulAt: null,
      };
    }

    const ageMs = Math.max(0, now.getTime() - lastSuccessfulAt.getTime());
    const overdue = ageMs > this.overdueMs;
    return {
      status: overdue ? 'overdue' : 'normal',
      label: overdue ? '已超期' : '正常',
      description: `最近一次调度备份成功于${relativeAge(ageMs)}。`,
      lastSuccessfulAt: lastSuccessfulAt.toISOString(),
    };
  }
}

module.exports = { BackupStatusService, relativeAge };
