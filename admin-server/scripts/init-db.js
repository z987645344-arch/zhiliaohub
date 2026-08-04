// Initializes the ignored local SQLite database without starting the HTTP server.
const { loadConfig } = require('../src/config');
const { initializeDatabase } = require('../src/db');

const config = loadConfig();
const database = initializeDatabase(config);
database.close();
console.log(`数据库结构已初始化：${config.databasePath}`);
