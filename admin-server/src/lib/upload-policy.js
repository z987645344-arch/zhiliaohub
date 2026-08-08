// Defines the explicit upload allowlist and verifies both declared type and file signatures.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

class UploadPolicyError extends Error {
  constructor(message, statusCode = 415) {
    super(message);
    this.name = 'UploadPolicyError';
    this.statusCode = statusCode;
  }
}

const policies = new Map([
  ['.jpg', { mimes: ['image/jpeg'], signature: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff }],
  ['.jpeg', { mimes: ['image/jpeg'], signature: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff }],
  ['.png', { mimes: ['image/png'], signature: (b) => b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) }],
  ['.webp', { mimes: ['image/webp'], signature: (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' }],
  ['.gif', { mimes: ['image/gif'], signature: (b) => ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6)) }],
  ['.avif', { mimes: ['image/avif'], signature: (b) => b.toString('ascii', 4, 12).includes('ftypavif') }],
  ['.pdf', { mimes: ['application/pdf'], signature: (b) => b.toString('ascii', 0, 5) === '%PDF-' }],
  ['.md', { mimes: ['text/markdown', 'text/plain'], signature: (b) => !b.includes(0) }],
  ['.mp3', { mimes: ['audio/mpeg'], signature: (b) => b.toString('ascii', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) }],
  ['.wav', { mimes: ['audio/wav', 'audio/x-wav'], signature: (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE' }],
  ['.ogg', { mimes: ['audio/ogg'], signature: (b) => b.toString('ascii', 0, 4) === 'OggS' }],
  ['.mp4', { mimes: ['video/mp4'], signature: (b) => b.toString('ascii', 4, 8) === 'ftyp' }],
  ['.webm', { mimes: ['video/webm'], signature: (b) => b.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex')) }],
  ['.zip', { mimes: ['application/zip', 'application/x-zip-compressed'], signature: (b) => b[0] === 0x50 && b[1] === 0x4b }],
]);

function inspectDeclaration(file) {
  const extension = path.extname(file.originalname || '').toLowerCase();
  const policy = policies.get(extension);
  if (!policy || !policy.mimes.includes(file.mimetype)) {
    throw new UploadPolicyError('文件类型不在允许的白名单中。');
  }
  return { extension, policy };
}

function multerFileFilter(_request, file, callback) {
  try {
    inspectDeclaration(file);
    callback(null, true);
  } catch (error) {
    callback(error);
  }
}

async function validateAndFinalizeUpload(file, config) {
  const { extension, policy } = inspectDeclaration(file);
  const handle = await fs.open(file.path, 'r');
  const header = Buffer.alloc(4096);
  let bytesRead;
  try {
    ({ bytesRead } = await handle.read(header, 0, header.length, 0));
  } finally {
    await handle.close();
  }

  if (!policy.signature(header.subarray(0, bytesRead))) {
    await fs.unlink(file.path).catch(() => {});
    throw new UploadPolicyError('文件内容与声明的文件类型不一致。');
  }

  const finalName = `${Date.now()}-${randomUUID()}${extension}`;
  const finalPath = path.join(config.uploadsDir, finalName);
  await fs.rename(file.path, finalPath);

  return {
    originalName: file.originalname,
    storedName: finalName,
    mimeType: file.mimetype,
    size: file.size,
    relativePath: `uploads/${finalName}`,
  };
}

module.exports = {
  UploadPolicyError,
  multerFileFilter,
  validateAndFinalizeUpload,
};
