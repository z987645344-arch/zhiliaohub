// Writes content beside its target and exposes a test hook before the atomic rename boundary.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

async function atomicWriteFile(targetPath, content, options = {}) {
  const directory = path.dirname(targetPath);
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  let handle;

  await fs.mkdir(directory, { recursive: true });

  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(content, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = undefined;

    if (options.beforeRename) await options.beforeRename(temporaryPath, targetPath);
    await fs.rename(temporaryPath, targetPath);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporaryPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

module.exports = { atomicWriteFile };
