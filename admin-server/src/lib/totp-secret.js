// Encrypts the persisted TOTP seed with authenticated AES-256-GCM encryption.
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');

function encryptTotpSecret(secret, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptTotpSecret(record, key) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.totp_iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.totp_auth_tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(record.totp_ciphertext, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

module.exports = { encryptTotpSecret, decryptTotpSecret };
