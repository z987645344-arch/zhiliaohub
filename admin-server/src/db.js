// Initializes the local SQLite metadata store from the committed schema definition.
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function initializeDatabase(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(path.join(config.contentDir, 'works'), { recursive: true });
  fs.mkdirSync(path.join(config.contentDir, 'notes'), { recursive: true });
  fs.mkdirSync(config.uploadsDir, { recursive: true });

  const database = new Database(config.databasePath);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');

  const schemaPath = config.schemaPath || path.join(config.serverRoot, 'data', 'schema.sql');
  database.exec(fs.readFileSync(schemaPath, 'utf8'));
  return database;
}

module.exports = { initializeDatabase };
