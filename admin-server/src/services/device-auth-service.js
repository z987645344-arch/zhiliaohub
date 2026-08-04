// Manages one active P-256 device, short-lived pairing codes and replay-safe login challenges.
const crypto = require('node:crypto');

const PAIRING_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const SIGNATURE_CONTEXT = 'zhiliaohub-device-login:v1';

class DeviceAuthError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'DeviceAuthError';
    this.statusCode = statusCode;
  }
}

function pairingCode() {
  const characters = Array.from({ length: 10 }, () => (
    PAIRING_ALPHABET[crypto.randomInt(0, PAIRING_ALPHABET.length)]
  ));
  return `${characters.slice(0, 5).join('')}-${characters.slice(5).join('')}`;
}

function normalizePairingCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function pairingCodeHash(value) {
  return crypto.createHash('sha256').update(normalizePairingCode(value), 'utf8').digest('hex');
}

function normalizePublicKey(value) {
  const supplied = String(value || '').trim();
  if (!supplied || supplied.length > 4096) throw new DeviceAuthError('设备公钥无效。');
  let key;
  try {
    key = crypto.createPublicKey(supplied);
  } catch {
    throw new DeviceAuthError('设备公钥无效。');
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new DeviceAuthError('设备公钥必须使用ECDSA P-256。');
  }
  const der = key.export({ type: 'spki', format: 'der' });
  return {
    pem: key.export({ type: 'spki', format: 'pem' }).toString(),
    fingerprint: crypto.createHash('sha256').update(der).digest('hex'),
  };
}

function publicDevice(record) {
  if (!record) return null;
  return {
    id: record.id,
    deviceName: record.device_name,
    publicKeyFingerprint: record.public_key_fingerprint,
    createdAt: record.created_at,
    lastUsedAt: record.last_used_at,
    revoked: Boolean(record.revoked),
    revokedAt: record.revoked_at,
  };
}

class DeviceAuthService {
  constructor(database, config) {
    this.database = database;
    this.config = config;
    this.pairTransaction = database.transaction((codeHash, deviceName, publicKey) => {
      const now = Date.now();
      const code = database.prepare(`
        SELECT * FROM pairing_codes
        WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
      `).get(codeHash, now);
      if (!code) throw new DeviceAuthError('配对码无效、已使用或已经过期。', 401);
      const usedAt = new Date(now).toISOString();
      const claimed = database.prepare(`
        UPDATE pairing_codes SET used_at = ?
        WHERE id = ? AND used_at IS NULL AND expires_at > ?
      `).run(usedAt, code.id, now);
      if (claimed.changes !== 1) throw new DeviceAuthError('配对码无效、已使用或已经过期。', 401);

      database.prepare(`
        UPDATE devices SET revoked = 1, revoked_at = ? WHERE revoked = 0
      `).run(usedAt);
      database.prepare(`
        UPDATE device_challenges SET used_at = ? WHERE used_at IS NULL
      `).run(usedAt);

      const id = crypto.randomUUID();
      database.prepare(`
        INSERT INTO devices (
          id, device_name, public_key_pem, public_key_fingerprint,
          created_at, last_used_at, revoked, revoked_at
        ) VALUES (?, ?, ?, ?, ?, NULL, 0, NULL)
      `).run(id, deviceName, publicKey.pem, publicKey.fingerprint, usedAt);
      return database.prepare('SELECT * FROM devices WHERE id = ?').get(id);
    });
    this.consumeChallengeTransaction = database.transaction((challengeId, now) => {
      const usedAt = new Date(now).toISOString();
      const claimed = database.prepare(`
        UPDATE device_challenges SET used_at = ?
        WHERE id = ? AND used_at IS NULL AND expires_at > ?
      `).run(usedAt, challengeId, now);
      if (claimed.changes !== 1) return false;
      database.prepare(`
        UPDATE devices SET last_used_at = ?
        WHERE id = (SELECT device_id FROM device_challenges WHERE id = ?) AND revoked = 0
      `).run(usedAt, challengeId);
      return true;
    });
  }

  currentDevice() {
    return publicDevice(this.database.prepare(
      'SELECT * FROM devices WHERE revoked = 0 ORDER BY created_at DESC LIMIT 1',
    ).get());
  }

  isDeviceActive(deviceId) {
    if (!deviceId) return false;
    return Boolean(this.database.prepare(
      'SELECT 1 FROM devices WHERE id = ? AND revoked = 0',
    ).get(String(deviceId)));
  }

  generatePairingCode() {
    const now = Date.now();
    const code = pairingCode();
    const createdAt = new Date(now).toISOString();
    const expiresAt = now + this.config.pairingCodeTtlMs;
    this.database.prepare('DELETE FROM pairing_codes WHERE expires_at <= ? OR used_at IS NOT NULL').run(now);
    this.database.prepare('UPDATE pairing_codes SET used_at = ? WHERE used_at IS NULL').run(createdAt);
    this.database.prepare(`
      INSERT INTO pairing_codes (id, code_hash, created_at, expires_at, used_at)
      VALUES (?, ?, ?, ?, NULL)
    `).run(crypto.randomUUID(), pairingCodeHash(code), createdAt, expiresAt);
    return { pairingCode: code, expiresAt: new Date(expiresAt).toISOString() };
  }

  pairDevice({ pairingCode: suppliedCode, publicKeyPem, deviceName }) {
    const normalizedCode = normalizePairingCode(suppliedCode);
    if (normalizedCode.length !== 10) {
      throw new DeviceAuthError('配对码无效、已使用或已经过期。', 401);
    }
    const normalizedName = String(deviceName || 'Android设备').trim();
    if (!normalizedName || normalizedName.length > 100) throw new DeviceAuthError('设备名称无效。');
    const publicKey = normalizePublicKey(publicKeyPem);
    return publicDevice(this.pairTransaction(pairingCodeHash(normalizedCode), normalizedName, publicKey));
  }

  createChallenge() {
    const device = this.database.prepare(
      'SELECT * FROM devices WHERE revoked = 0 ORDER BY created_at DESC LIMIT 1',
    ).get();
    if (!device) throw new DeviceAuthError('当前没有已授权设备。', 409);
    const now = Date.now();
    const id = crypto.randomUUID();
    const challenge = crypto.randomBytes(32).toString('base64url');
    const expiresAt = now + this.config.deviceChallengeTtlMs;
    const signedPayload = `${SIGNATURE_CONTEXT}:${id}:${challenge}`;
    this.database.prepare('DELETE FROM device_challenges WHERE expires_at <= ? OR used_at IS NOT NULL').run(now);
    this.database.prepare(`
      INSERT INTO device_challenges (id, device_id, challenge, created_at, expires_at, used_at)
      VALUES (?, ?, ?, ?, ?, NULL)
    `).run(id, device.id, challenge, new Date(now).toISOString(), expiresAt);
    return {
      challengeId: id,
      challenge,
      signedPayload,
      expiresAt: new Date(expiresAt).toISOString(),
      signatureAlgorithm: 'SHA256withECDSA',
      signatureEncoding: 'DER_BASE64',
    };
  }

  verifyChallenge({ challengeId, signature }) {
    const id = String(challengeId || '');
    const row = this.database.prepare(`
      SELECT c.*, d.public_key_pem, d.revoked
      FROM device_challenges c
      JOIN devices d ON d.id = c.device_id
      WHERE c.id = ?
    `).get(id);
    const now = Date.now();
    if (!row || row.used_at || row.expires_at <= now || row.revoked) {
      throw new DeviceAuthError('挑战无效、已使用、已过期或设备已吊销。', 401);
    }
    let signatureBytes;
    try {
      signatureBytes = Buffer.from(String(signature || ''), 'base64');
    } catch {
      throw new DeviceAuthError('设备签名无效。', 401);
    }
    if (signatureBytes.length === 0 || signatureBytes.length > 256) {
      throw new DeviceAuthError('设备签名无效。', 401);
    }
    const payload = `${SIGNATURE_CONTEXT}:${row.id}:${row.challenge}`;
    let valid = false;
    try {
      valid = crypto.verify('sha256', Buffer.from(payload, 'utf8'), row.public_key_pem, signatureBytes);
    } catch {
      valid = false;
    }
    if (!valid) throw new DeviceAuthError('设备签名无效。', 401);
    if (!this.consumeChallengeTransaction(row.id, now)) {
      throw new DeviceAuthError('挑战无效、已使用、已过期或设备已吊销。', 401);
    }
    return publicDevice(this.database.prepare('SELECT * FROM devices WHERE id = ?').get(row.device_id));
  }

  revokeCurrentDevice() {
    const device = this.database.prepare('SELECT * FROM devices WHERE revoked = 0 LIMIT 1').get();
    if (!device) throw new DeviceAuthError('当前没有可吊销的设备。', 404);
    const revokedAt = new Date().toISOString();
    const revoke = this.database.transaction(() => {
      this.database.prepare('UPDATE devices SET revoked = 1, revoked_at = ? WHERE id = ? AND revoked = 0')
        .run(revokedAt, device.id);
      this.database.prepare('UPDATE device_challenges SET used_at = ? WHERE device_id = ? AND used_at IS NULL')
        .run(revokedAt, device.id);
    });
    revoke();
    return publicDevice(this.database.prepare('SELECT * FROM devices WHERE id = ?').get(device.id));
  }
}

module.exports = {
  DeviceAuthError,
  DeviceAuthService,
  SIGNATURE_CONTEXT,
  normalizePublicKey,
  pairingCodeHash,
};
