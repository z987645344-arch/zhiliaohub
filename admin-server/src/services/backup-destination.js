// Where a finished backup archive gets copied *in addition to* the local backups/ directory.
//
// ⚠ CURRENT STATUS: the only implementation is LocalMirrorDestination, which copies the
// archive to another directory on the SAME machine. That is a SIMULATION used to prove the
// "generate locally, then replicate" path works. It is NOT off-site disaster recovery: if
// the server itself dies, burns or is wiped, the mirror dies with it. Real protection
// against losing the machine requires a genuine remote store (object storage such as
// Tencent COS, or another host) and has NOT been implemented or tested.
//
// Adding a real remote destination later must not require touching backup-service.js:
// implement the contract below and return it from createBackupDestination().
//
// Destination contract
// --------------------
//   name                      short identifier used in logs
//   describe()                human-readable target, used in operator-facing messages
//   send(archivePath)         copy/upload the finished archive; resolve with { location },
//                             reject on failure. MUST NOT modify, move or delete the local
//                             archive it is given — the local copy is already the primary.
//   prune(prefix, policy, now) OPTIONAL. Apply age expiry with a minimum count, using the
//                             same filename-only policy as the primary. Omit it if the remote
//                             service manages its own lifecycle rules.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pruneBackups } = require('./backup-retention');

class LocalMirrorDestination {
  constructor(directory) {
    this.name = 'local-mirror';
    this.directory = directory;
  }

  describe() {
    return `本地模拟异地目录 ${this.directory}`;
  }

  async send(archivePath) {
    await fs.mkdir(this.directory, { recursive: true });
    const target = path.join(this.directory, path.basename(archivePath));
    // Copy to a temporary name and rename into place, so an interrupted copy can never
    // leave a truncated file that looks like a usable archive.
    const staging = path.join(this.directory, `.partial-${crypto.randomUUID()}`);
    try {
      await fs.copyFile(archivePath, staging);
      await fs.rename(staging, target);
    } catch (error) {
      await fs.unlink(staging).catch(() => {});
      throw error;
    }
    return { location: target };
  }

  async prune(namePrefix, policy, now) {
    return pruneBackups(this.directory, policy, namePrefix, now);
  }
}

function createBackupDestination(config) {
  if (!config.backupMirrorDir) return null;
  return new LocalMirrorDestination(config.backupMirrorDir);
}

module.exports = { LocalMirrorDestination, createBackupDestination };
