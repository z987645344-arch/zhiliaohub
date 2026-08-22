// CLI entry point for explicitly restoring a complete local backup archive while the service is stopped.
const path = require('node:path');
const { loadBackupConfig } = require('../src/backup-config');
const { restoreBackup } = require('../src/services/backup-service');

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

const archive = option('--archive');
const force = process.argv.includes('--force');
const skipPreRestoreSnapshot = process.argv.includes('--skip-pre-restore-snapshot');

if (!archive || !force) {
  console.error('用法：node scripts/restore.js --archive <备份归档路径> --force [--skip-pre-restore-snapshot]');
  process.exitCode = 1;
} else {
  restoreBackup(loadBackupConfig(), path.resolve(archive), { force: true, skipPreRestoreSnapshot })
    .then(({ manifest, preRestoreSnapshot, excludedFiles, warnings }) => {
      if (preRestoreSnapshot.skipped) {
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
