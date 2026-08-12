// Starts the local admin HTTP service; deployment topology is intentionally not defined here.
const { createApp } = require('./app');
const { loadBackupConfig } = require('./backup-config');
const { startupNetworkMessages } = require('./network-addresses');
const { BackupScheduler } = require('./services/backup-scheduler');

const { app, config, database, sessionStore } = createApp();
const backupScheduler = new BackupScheduler(loadBackupConfig()).start();
const server = app.listen(config.port, config.host, () => {
  console.log(`知了hub 管理后台已启动：监听 ${config.host}:${config.port}`);
  for (const message of startupNetworkMessages(config)) console.log(message);
});

function shutdown(signal) {
  console.log(`收到 ${signal}，正在关闭管理后台。`);
  backupScheduler.stop();
  server.close(() => {
    sessionStore.close();
    database.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
