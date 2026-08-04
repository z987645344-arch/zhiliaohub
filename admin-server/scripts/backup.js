// CLI entry point for creating a complete local backup archive.
const { loadBackupConfig } = require('../src/backup-config');
const { createBackup } = require('../src/services/backup-service');

createBackup(loadBackupConfig())
  .then(({ archivePath, manifest, removed }) => {
    console.log(`备份已创建：${archivePath}`);
    console.log(`清单文件数：${manifest.files.length}`);
    console.log(`保留策略清理：${removed.length} 份`);
  })
  .catch((error) => {
    console.error(`备份失败：${error.message}`);
    process.exitCode = 1;
  });
