// Loads and validates local admin-server configuration without providing unsafe secret defaults.
const path = require('node:path');
const dotenv = require('dotenv');

const serverRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(serverRoot, '.env'), quiet: true });

function positiveInteger(value, name, fallback) {
  const candidate = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return candidate;
}

function nonNegativeInteger(value, name, fallback) {
  const candidate = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return candidate;
}

function resolveLocalPath(value, fallback) {
  return path.resolve(serverRoot, value || fallback);
}

function parseEncryptionKey(value) {
  if (Buffer.isBuffer(value)) return value;
  if (!value) throw new Error('TOTP_ENCRYPTION_KEY is required.');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) {
    throw new Error('TOTP_ENCRYPTION_KEY must decode to exactly 32 bytes.');
  }
  return key;
}

function loadConfig(overrides = {}) {
  const nodeEnv = overrides.nodeEnv || process.env.NODE_ENV || 'development';
  const sessionSecret = overrides.sessionSecret || process.env.SESSION_SECRET;
  const adminPasswordHash = overrides.adminPasswordHash || process.env.ADMIN_PASSWORD_HASH;

  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 characters.');
  }
  if (!/^\$2[aby]\$\d{2}\$/.test(adminPasswordHash || '')) {
    throw new Error('ADMIN_PASSWORD_HASH must be a bcrypt hash.');
  }

  const dataDir = overrides.dataDir || resolveLocalPath(process.env.DATA_DIR, 'data');
  const contentDir = overrides.contentDir || resolveLocalPath(process.env.CONTENT_DIR, 'content');
  const uploadsDir = overrides.uploadsDir || resolveLocalPath(process.env.UPLOAD_DIR, 'uploads');

  return {
    serverRoot,
    nodeEnv,
    isProduction: nodeEnv === 'production',
    host: overrides.host || process.env.HOST || '127.0.0.1',
    port: positiveInteger(overrides.port ?? process.env.PORT, 'PORT', 3001),
    trustProxyHops: nonNegativeInteger(
      overrides.trustProxyHops ?? process.env.TRUST_PROXY_HOPS,
      'TRUST_PROXY_HOPS',
      0,
    ),
    sessionSecret,
    adminUsername: overrides.adminUsername || process.env.ADMIN_USERNAME || 'admin',
    adminPasswordHash,
    totpEncryptionKey: parseEncryptionKey(
      overrides.totpEncryptionKey || process.env.TOTP_ENCRYPTION_KEY,
    ),
    authRateLimitWindowMs: positiveInteger(
      overrides.authRateLimitWindowMs ?? process.env.AUTH_RATE_LIMIT_WINDOW_MS,
      'AUTH_RATE_LIMIT_WINDOW_MS',
      15 * 60 * 1000,
    ),
    authRateLimitMax: positiveInteger(
      overrides.authRateLimitMax ?? process.env.AUTH_RATE_LIMIT_MAX,
      'AUTH_RATE_LIMIT_MAX',
      8,
    ),
    uploadMaxBytes: positiveInteger(
      overrides.uploadMaxBytes ?? process.env.UPLOAD_MAX_BYTES,
      'UPLOAD_MAX_BYTES',
      25 * 1024 * 1024,
    ),
    contentMaxBytes: positiveInteger(
      overrides.contentMaxBytes ?? process.env.CONTENT_MAX_BYTES,
      'CONTENT_MAX_BYTES',
      1024 * 1024,
    ),
    dataDir,
    databasePath: overrides.databasePath || path.join(dataDir, 'admin.sqlite3'),
    contentDir,
    uploadsDir,
  };
}

module.exports = { loadConfig };
