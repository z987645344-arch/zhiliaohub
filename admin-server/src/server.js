// Starts the local admin HTTP service; deployment topology is intentionally not defined here.
const { createApp } = require('./app');

const { app, config, database, sessionStore } = createApp();
const server = app.listen(config.port, config.host, () => {
  console.log(`知了hub 管理后台已启动：http://${config.host}:${config.port}/admin/login`);
});

function shutdown(signal) {
  console.log(`收到 ${signal}，正在关闭管理后台。`);
  server.close(() => {
    sessionStore.close();
    database.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
