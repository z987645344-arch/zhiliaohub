// CLI entry point for creating a complete local backup archive.
const { loadBackupConfig } = require('../src/backup-config');
const { createBackup } = require('../src/services/backup-service');

createBackup(loadBackupConfig())
  .then(({ archivePath, manifest, removed, replication }) => {
    console.log(`备份已创建：${archivePath}`);
    console.log(`清单文件数：${manifest.files.length}`);
    console.log(`未入包 ZIP 数：${manifest.excluded.length}`);
    for (const file of manifest.excluded) {
      console.warn(`未入包：${file.path}（${file.size} 字节，SHA-256 ${file.sha256}）`);
    }
    if (manifest.excluded.length) {
      console.warn('备份不含 .zip；恢复后需由用户从本地补齐，清单见 manifest.excluded。');
    }
    console.log(`保留策略清理：${removed.length} 份`);
    if (replication?.ok) {
      console.log(`已同步副本：${replication.location}`);
      console.log('提醒：该副本目前仍在本机，只是模拟异地，不能防服务器整体损毁。');
    } else if (replication && !replication.skipped) {
      console.warn(`副本同步失败：${replication.error}；本地备份本身有效。`);
    }
  })
  .catch((error) => {
    console.error(`备份失败：${error.message}`);
    process.exitCode = 1;
  });
