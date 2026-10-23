const { sweepArchiveRetention } = require('./backup-retention');
const { nextScheduledAt, scheduledBoundaryAtOrBefore } = require('./backup-schedule-clock');

const RETENTION_LOCAL_TIME = '00:30';
const RETENTION_RETRY_MS = 5 * 60 * 1000;

// Own timer, promise and in-flight gate: never waits for the backup cycle.
class ArchiveRetentionScheduler {
  constructor(config, options = {}) {
    this.config = config;
    this.sweep = options.sweepArchiveRetention || sweepArchiveRetention;
    this.now = options.now || (() => new Date());
    this.logger = options.logger || console;
    this.setTimeout = options.setTimeout || setTimeout;
    this.clearTimeout = options.clearTimeout || clearTimeout;
    this.timer = null;
    this.generation = 0;
    this.inFlight = false;
    this.stopped = false;
    this.started = false;
    this.runPromise = null;
    this.activeSweep = null;
  }

  start() {
    if (this.started) return this;
    this.started = true;
    this.stopped = false;
    this.scheduleNext(); // Arm BEFORE boot catch-up can block on I/O.
    this.runPromise = this.runAndSchedule();
    this.runPromise.catch((error) => this.logger.error(`[backup] 归档清扫调度异常：${error.message}`));
    this.logger.log('[backup] 归档清扫独立启用：每日 UTC+8 00:30；启动检查最近已到边界。');
    return this;
  }

  async runAndSchedule() {
    if (this.stopped) return { skipped: true, reason: 'retention stopped' };
    if (this.inFlight) {
      this.logger.error('[backup] 上次归档清扫尚未完成，本次暂缓，5分钟后再检查。');
      this.scheduleNext({ retry: true });
      return { status: 'deferred', reason: 'previous sweep still running' };
    }
    const now = this.now();
    const boundary = scheduledBoundaryAtOrBefore(now, RETENTION_LOCAL_TIME);
    this.inFlight = true;
    let result;
    try {
      this.activeSweep = Promise.resolve().then(() => this.sweep(this.config, { now, boundary }));
      result = await this.activeSweep;
      if (!result.skipped) {
        const removed = (result.results || []).reduce((total, pool) => total + (pool.removed?.length || 0), 0);
        this.logger[result.status === 'ok' ? 'log' : 'error'](
          `[backup] 00:30归档清扫：${result.status}，删除 ${removed} 份；占用/失败不记为全部成功。`,
        );
        for (const pool of (result.results || []).filter((entry) => entry.status !== 'ok')) {
          this.logger.error(`[backup] 清扫未完成：${pool.destination}/${pool.prefix}：`
            + (pool.error || `占用暂缓 ${(pool.deferred || []).length} 份`));
        }
      }
    } catch (error) {
      result = { status: 'error', error: String(error.message) };
      this.logger.error(`[backup] 归档清扫或状态持久化失败，5分钟后重试：${error.message}`);
    } finally {
      this.activeSweep = null;
      this.inFlight = false;
      if (!this.stopped) {
        const crossedBoundary = scheduledBoundaryAtOrBefore(this.now(), RETENTION_LOCAL_TIME) > boundary;
        this.scheduleNext({ immediate: crossedBoundary,
          retry: !result?.skipped && result?.status !== 'ok' });
      }
    }
    return result;
  }

  scheduleNext({ retry = false, immediate = false } = {}) {
    if (this.stopped) return null;
    if (this.timer !== null) this.clearTimeout(this.timer);
    const now = this.now();
    const daily = nextScheduledAt(now, RETENTION_LOCAL_TIME);
    const at = immediate ? now : new Date(Math.min(daily.getTime(),
      retry ? now.getTime() + RETENTION_RETRY_MS : daily.getTime()));
    const generation = ++this.generation;
    this.timer = this.setTimeout(() => {
      if (this.stopped || generation !== this.generation) return;
      this.timer = null;
      this.runPromise = this.runAndSchedule();
      this.runPromise.catch((error) => this.logger.error(`[backup] 归档清扫调度异常：${error.message}`));
      return this.runPromise;
    }, Math.max(0, at.getTime() - now.getTime()));
    this.timer?.unref?.();
    return at;
  }

  stop() {
    this.stopped = true;
    this.started = false;
    this.generation++;
    if (this.timer !== null) this.clearTimeout(this.timer);
    this.timer = null;
    return this;
  }

  async waitForIdle() {
    await Promise.allSettled([this.activeSweep]);
  }
}

module.exports = { ArchiveRetentionScheduler, RETENTION_LOCAL_TIME, RETENTION_RETRY_MS };
