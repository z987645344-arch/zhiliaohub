// Filename-only retention: never open an archive or confuse a floor with a hard cap.
const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWriteFile } = require('../lib/atomic-file');
const { deleteUnusedArchive, withArchiveUse } = require('./archive-lease');

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_STATE_FILE = '.archive-retention-state.json';
const RETENTION_SCHEDULE_VERSION = 'utc8-0030-v1';
const RETENTION_POOLS = Object.freeze([
  { prefix: 'scheduled-backup', key: 'scheduledBackup', env: 'SCHEDULED_BACKUP', minCount: 3 },
  { prefix: 'orphan-rollback', key: 'orphanRollback', env: 'ORPHAN_ROLLBACK', minCount: 0 },
  { prefix: 'pre-restore', key: 'preRestore', env: 'PRE_RESTORE', minCount: 0 },
  { prefix: 'backup', key: 'backup', env: 'BACKUP', minCount: 0 },
].map(Object.freeze));

function retentionInteger(value, name, fallback, minimum) {
  const candidate = typeof value === 'string' ? value.trim() : value;
  const parsed = candidate === undefined || candidate === '' ? fallback : Number(candidate);
  if (!Number.isSafeInteger(parsed) || parsed < minimum
      || (minimum === 1 && !Number.isSafeInteger(parsed * DAY_MS))) {
    throw new Error(`${name} must be ${minimum === 0 ? 'a non-negative' : 'a positive'} integer.`);
  }
  return parsed;
}

function loadRetentionConfig(overrides, environment) {
  return Object.fromEntries(RETENTION_POOLS.flatMap((pool) => [
    [`${pool.key}RetentionDays`, retentionInteger(overrides[`${pool.key}RetentionDays`]
      ?? environment[`${pool.env}_RETENTION_DAYS`], `${pool.env}_RETENTION_DAYS`, 3, 1)],
    [`${pool.key}MinCount`, retentionInteger(overrides[`${pool.key}MinCount`]
      ?? environment[`${pool.env}_MIN_COUNT`], `${pool.env}_MIN_COUNT`, pool.minCount, 0)],
  ]));
}

function retentionForPool(config, prefix) {
  const pool = RETENTION_POOLS.find((entry) => entry.prefix === prefix);
  if (!pool) throw new Error('Unknown backup retention pool.');
  return validatePolicy({
    retentionDays: config[`${pool.key}RetentionDays`] ?? 3,
    minCount: config[`${pool.key}MinCount`] ?? pool.minCount,
  });
}

function validatePolicy(policy) {
  return {
    retentionDays: retentionInteger(policy?.retentionDays, 'retentionDays', undefined, 1),
    minCount: retentionInteger(policy?.minCount, 'minCount', undefined, 0),
  };
}

function archiveCreatedAt(name, prefix) {
  const match = new RegExp(`^${prefix}-(\\d{8})T(\\d{9})Z\\.tar\\.gz(?:\\.enc)?$`).exec(name);
  if (!match) return null;
  const [, date, time] = match;
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
    + `T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}.${time.slice(6, 9)}Z`;
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === iso ? timestamp : null;
}

async function pruneBackups(directory, policy, prefix = 'backup', now = new Date()) {
  if (!RETENTION_POOLS.some((pool) => pool.prefix === prefix)) throw new Error('Unknown backup retention pool.');
  const { retentionDays, minCount } = validatePolicy(policy);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Invalid retention clock.');
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const candidates = entries.filter((entry) => entry.isFile())
    .map((entry) => ({ name: entry.name, createdAt: archiveCreatedAt(entry.name, prefix) }))
    .filter((entry) => entry.createdAt !== null)
    .sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name));
  const cutoff = now.getTime() - retentionDays * DAY_MS;
  // Both conditions must hold: outside the newest floor AND strictly older than N days.
  const expired = candidates.slice(minCount).filter((entry) => entry.createdAt < cutoff)
    .map((entry) => entry.name);
  const removed = [];
  const deferred = [];
  // Preserve the public array contract for callers and older restore tooling.
  Object.defineProperty(removed, 'deferred', { value: deferred });
  for (const name of expired) {
    try {
      if (await deleteUnusedArchive(path.join(directory, name))) removed.push(name);
      else {
        deferred.push(name);
        console.warn(`[backup] 归档轮转因占用暂缓，独立清扫将重试：${name}`);
      }
    } catch (error) {
      // Preserve successful deletions in the durable result even if a later unlink fails.
      if (error.archiveDeleted) removed.push(name);
      error.removed = [...removed];
      error.deferred = [...deferred];
      throw error;
    }
  }
  return removed;
}

async function sweepArchiveRetention(config, { now, boundary }) {
  await fs.mkdir(config.backupDir, { recursive: true });
  try {
    return await withArchiveUse(path.join(config.backupDir, RETENTION_STATE_FILE), 'retention-sweep',
      () => sweepUnlocked(config, { now, boundary }));
  } catch (error) {
    if (error.code !== 'ARCHIVE_BUSY') throw error;
    return { status: 'deferred', reason: 'another sweep is running', results: [] };
  }
}

async function sweepUnlocked(config, { now, boundary }) {
  const statePath = path.join(config.backupDir, RETENTION_STATE_FILE);
  const boundaryIso = boundary.toISOString();
  let previous;
  try {
    previous = JSON.parse(await fs.readFile(statePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  if (previous?.scheduleVersion === RETENTION_SCHEDULE_VERSION
      && previous.status === 'ok' && previous.boundary === boundaryIso) {
    return { skipped: true, reason: 'already swept this daily boundary' };
  }
  // Resolve all policies before deleting anything; a malformed policy must fail closed.
  const policies = RETENTION_POOLS.map((pool) => ({ ...pool, policy: retentionForPool(config, pool.prefix) }));
  const directories = [{ name: 'local', directory: config.backupDir }];
  if (config.backupMirrorDir) directories.push({ name: 'local-mirror', directory: config.backupMirrorDir });
  const results = [];
  for (const { name, directory } of directories) {
    for (const { prefix, policy } of policies) {
      try {
        const removed = await pruneBackups(directory, policy, prefix, now);
        results.push({ destination: name, prefix, ...policy,
          status: removed.deferred.length ? 'deferred' : 'ok', removed, deferred: removed.deferred });
      } catch (error) {
        results.push({ destination: name, prefix, ...policy, status: 'error',
          removed: error.removed || [], deferred: error.deferred || [], error: String(error.message) });
      }
    }
  }
  const state = { scheduleVersion: RETENTION_SCHEDULE_VERSION, lastRunAt: now.toISOString(), boundary: boundaryIso,
    status: results.some((result) => result.status === 'error') ? 'error'
      : results.some((result) => result.status === 'deferred') ? 'deferred' : 'ok', results };
  await atomicWriteFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

module.exports = { RETENTION_POOLS, RETENTION_STATE_FILE, RETENTION_SCHEDULE_VERSION, loadRetentionConfig, pruneBackups,
  retentionForPool, sweepArchiveRetention, validatePolicy };
