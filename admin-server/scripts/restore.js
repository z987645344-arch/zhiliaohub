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

if (!archive || !force) {
  console.error('用法：node scripts/restore.js --archive <备份归档路径> --force');
  process.exitCode = 1;
} else {
  restoreBackup(loadBackupConfig(), path.resolve(archive), { force: true })
    .then(({ manifest }) => {
      console.log(`恢复完成；备份创建时间：${manifest.createdAt}`);
      console.log(`已校验文件数：${manifest.files.length}`);
    })
    .catch((error) => {
      console.error(`恢复失败：${error.message}`);
      process.exitCode = 1;
    });
}
