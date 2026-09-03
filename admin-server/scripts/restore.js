// CLI entry point for explicitly restoring a complete local backup archive while the service is stopped.
const path = require('node:path');
const { loadBackupConfig } = require('../src/backup-config');
const { restoreBackup } = require('../src/services/backup-service');

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function positiveIntegerOption(name) {
  if (!process.argv.includes(name)) return undefined;
  const raw = option(name);
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

const archive = option('--archive');
const force = process.argv.includes('--force');
const confirmServiceStopped = process.argv.includes('--confirm-service-stopped');
const skipPreRestoreSnapshot = process.argv.includes('--skip-pre-restore-snapshot');
const confirmNoPreRestoreSnapshot = process.argv.includes('--confirm-no-pre-restore-snapshot');
const snapshotConfirmationMismatch = skipPreRestoreSnapshot !== confirmNoPreRestoreSnapshot;
const restoreProbeTimeoutMs = positiveIntegerOption('--probe-timeout-ms');
const invalidProbeTimeout = restoreProbeTimeoutMs === null;

if (!archive || !force || !confirmServiceStopped || snapshotConfirmationMismatch || invalidProbeTimeout) {
  console.error(
    '用法：node scripts/restore.js --archive <备份归档路径> --force '
    + '--confirm-service-stopped [--skip-pre-restore-snapshot '
    + '--confirm-no-pre-restore-snapshot] [--probe-timeout-ms <正整数毫秒>]',
  );
  if (!confirmServiceStopped) {
    console.error(
      '恢复被拒绝：缺少 --confirm-service-stopped。请先停止后台服务，再用该参数声明已停服；'
      + '恢复器仍会继续执行本机 Nginx 健康地址、SQLite -shm 与独占锁三道探测。',
    );
  }
  if (skipPreRestoreSnapshot && !confirmNoPreRestoreSnapshot) {
    console.error(
      '恢复被拒绝：--skip-pre-restore-snapshot 必须与 '
      + '--confirm-no-pre-restore-snapshot 同时给出。',
    );
  }
  if (confirmNoPreRestoreSnapshot && !skipPreRestoreSnapshot) {
    console.error(
      '恢复被拒绝：--confirm-no-pre-restore-snapshot 只能与 '
      + '--skip-pre-restore-snapshot 同时使用。',
    );
  }
  if (invalidProbeTimeout) {
    console.error('恢复被拒绝：--probe-timeout-ms 必须提供一个严格大于 0 的安全整数毫秒值。');
  }
  process.exitCode = 1;
} else {
  restoreBackup(loadBackupConfig(), path.resolve(archive), {
    force: true,
    confirmServiceStopped: true,
    skipPreRestoreSnapshot,
    confirmNoPreRestoreSnapshot,
    restoreProbeTimeoutMs,
  })
    .then(({ manifest, preRestoreSnapshot, excludedFiles, warnings }) => {
      if (preRestoreSnapshot.explicitlySkipped) {
        console.warn('⚠️ 严重警告：本次恢复已按独立双重确认跳过恢复前快照。');
        console.warn('本次恢复没有回退点；如果恢复失败或选错归档，无法通过恢复前快照回滚。');
      } else if (preRestoreSnapshot.skipped) {
        console.warn(`未创建恢复前快照（${preRestoreSnapshot.reason}）；本次恢复没有回退点。`);
      } else {
        console.log(`恢复前快照已创建：${preRestoreSnapshot.archivePath}`);
        console.log('如果本次恢复选错了归档，可用上面这份快照退回恢复前的状态。');
      }
      console.log(`恢复完成；备份创建时间：${manifest.createdAt}`);
      console.log(`已校验文件数：${manifest.files.length}`);
      for (const warning of warnings) console.warn(`注意：${warning}`);
      for (const file of excludedFiles) {
        console.warn(`待补齐：${file.path}（${file.size} 字节，SHA-256 ${file.sha256}）`);
      }
    })
    .catch((error) => {
      console.error(`恢复失败：${error.message}`);
      process.exitCode = 1;
    });
}
