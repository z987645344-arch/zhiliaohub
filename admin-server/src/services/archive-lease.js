// Cooperative cross-process archive leases. Never expire a lease by age: a slow
// copy/verification is still using its archive. A crashed owner fails closed and
// needs operator confirmation before its leftover lease can be removed.
const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const sessions = new AsyncLocalStorage();

async function canonicalArchive(archivePath) {
  const absolute = path.resolve(archivePath);
  const resolved = await fs.realpath(absolute).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return absolute;
  });
  const directory = await fs.realpath(path.dirname(resolved));
  let name = path.basename(resolved);
  if (process.platform === 'win32') name = name.toLowerCase();
  return { directory, name, key: path.join(directory, name) };
}

async function acquireArchiveLease(archivePath, purpose) {
  const { directory, name, key } = await canonicalArchive(archivePath);
  const leaseDir = path.join(directory, '.archive-leases');
  await fs.mkdir(leaseDir, { recursive: true, mode: 0o700 });
  const leaseDirStat = await fs.lstat(leaseDir);
  if (!leaseDirStat.isDirectory() || leaseDirStat.isSymbolicLink()) throw new Error('Archive lease directory must not be a link.');
  const leasePath = path.join(leaseDir, `${crypto.createHash('sha256').update(name).digest('hex')}.json`);
  const token = crypto.randomUUID();
  let handle;
  try {
    handle = await fs.open(leasePath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw Object.assign(new Error(`Archive is in use; retained for a later sweep: ${name}`), { code: 'ARCHIVE_BUSY' });
    }
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ token, pid: process.pid, host: os.hostname(), purpose, archive: name }));
  } catch (error) {
    await handle.close();
    await fs.unlink(leasePath);
    throw error;
  }
  await handle.close();
  return { key, async release() {
    const owner = JSON.parse(await fs.readFile(leasePath, 'utf8'));
    if (owner.token !== token) throw new Error('Archive lease owner changed; refusing to remove another owner.');
    await fs.unlink(leasePath);
  } };
}

async function withArchiveSession(action) {
  if (sessions.getStore() && !sessions.getStore().closed) return action();
  const session = { held: new Map(), closed: false };
  try {
    return await sessions.run(session, action);
  } finally {
    session.closed = true;
    for (const lease of [...session.held.values()].reverse()) {
      try { await lease.release(); } catch (error) {
        console.error(`[backup] 归档占用标记释放失败，后续清扫会保守暂缓：${error.message}`);
      }
    }
    session.held.clear();
  }
}

async function withArchiveUse(archivePath, purpose, action) {
  return withArchiveSession(async () => {
    const { key } = await canonicalArchive(archivePath);
    const session = sessions.getStore();
    if (!session.held.has(key)) {
      const lease = await acquireArchiveLease(archivePath, purpose);
      if (session.closed) {
        await lease.release();
        throw new Error('Archive operation outlived its awaited session.');
      }
      session.held.set(key, lease);
    }
    return action();
  });
}

// Deletion MUST acquire its own lease, even inside a creation/read session.
// Reentrant use is allowed; reentrant deletion of a protected archive is not.
async function deleteUnusedArchive(archivePath) {
  let lease;
  try { lease = await acquireArchiveLease(archivePath, 'retention-delete'); } catch (error) {
    if (error.code === 'ARCHIVE_BUSY') return false;
    throw error;
  }
  let deleted = false;
  try {
    await fs.unlink(archivePath);
    deleted = true;
    return true;
  } finally {
    try { await lease.release(); } catch (error) {
      error.archiveDeleted = deleted;
      throw error;
    }
  }
}

module.exports = { withArchiveSession, withArchiveUse, deleteUnusedArchive };
