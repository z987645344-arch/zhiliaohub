// Pulls the authenticated Zhitian backup-status contract over the private ops network.
// This dependency is intentionally one-way and bounded: ZhiliaoHub pulls, never pushes, and
// a slow or unavailable peer degrades only Zhitian's card.
const http = require('node:http');

const ZHITIAN_BACKUP_STATUS_URL = 'http://zhitian-api:8000/ops/backup-status';
const CONNECT_TIMEOUT_MS = 2000;
const TOTAL_TIMEOUT_MS = 3000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REMOTE_STATUSES = new Set(['ok', 'stale', 'disabled', 'unknown']);
const PASSTHROUGH_FIELDS = Object.freeze([
  'status',
  'reason',
  'hint',
  'label',
  'lastSuccessfulAt',
  'activeBoundaryAt',
]);

function failure(reason, hint) {
  return { status: 'unreachable', reason, hint };
}

function sanitizePayload(payload) {
  const result = {};
  for (const field of PASSTHROUGH_FIELDS) {
    if (payload[field] !== undefined) result[field] = payload[field];
  }
  // The peer intentionally owns this diagnostic block. It is passed to authenticated API
  // consumers for troubleshooting, but the dashboard renderer must never display it.
  if (payload.diagnostic && typeof payload.diagnostic === 'object') {
    result.diagnostic = payload.diagnostic;
  }
  return result;
}

function requestStatus(url, token, options = {}) {
  const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let request;
    let settled = false;
    let connectTimer;
    let totalTimer;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
      if (error) reject(error);
      else resolve(value);
    };

    totalTimer = setTimeout(() => {
      const error = Object.assign(new Error('Zhitian status request exceeded total timeout.'), {
        code: 'TOTAL_TIMEOUT',
      });
      request?.destroy(error);
      finish(error);
    }, totalTimeoutMs);

    request = http.request(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Ops-Token': token,
      },
    }, (response) => {
      clearTimeout(connectTimer);
      const chunks = [];
      let received = 0;
      response.on('data', (chunk) => {
        received += chunk.length;
        if (received > MAX_RESPONSE_BYTES) {
          const error = Object.assign(new Error('Zhitian status response is too large.'), {
            code: 'RESPONSE_TOO_LARGE',
          });
          request.destroy(error);
          finish(error);
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish(null, {
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });

    request.on('socket', (socket) => {
      if (!socket.connecting) return;
      connectTimer = setTimeout(() => {
        const error = Object.assign(new Error('Zhitian status connection timed out.'), {
          code: 'CONNECT_TIMEOUT',
        });
        request.destroy(error);
        finish(error);
      }, connectTimeoutMs);
      socket.once('connect', () => clearTimeout(connectTimer));
    });
    request.on('error', (error) => finish(error));
    request.end();
  });
}

class ZhitianBackupStatusClient {
  constructor(config, options = {}) {
    this.token = config.zhitianOpsToken;
    this.url = options.url || ZHITIAN_BACKUP_STATUS_URL;
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.totalTimeoutMs = options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS;
  }

  async getStatus() {
    if (!this.token) {
      return failure('local_token_missing', '知天运维令牌尚未配置，当前无法读取备份状态。');
    }

    let response;
    try {
      response = await requestStatus(this.url, this.token, {
        connectTimeoutMs: this.connectTimeoutMs,
        totalTimeoutMs: this.totalTimeoutMs,
      });
    } catch (error) {
      const timeout = ['CONNECT_TIMEOUT', 'TOTAL_TIMEOUT'].includes(error?.code);
      return failure(
        timeout ? 'request_timeout' : 'connection_failed',
        timeout
          ? '知天备份状态请求超时，当前不可达。'
          : '无法连接知天备份状态服务，当前不可达。',
      );
    }

    if (response.statusCode === 401) {
      return failure('authentication_failed', '知天运维令牌校验失败，请核对两端配置。');
    }
    if (response.statusCode === 404) {
      return failure('endpoint_not_configured', '知天尚未配置备份状态端点。');
    }
    if (response.statusCode !== 200) {
      return failure('upstream_error', `知天备份状态服务返回HTTP ${response.statusCode}，当前不可达。`);
    }

    try {
      const payload = JSON.parse(response.body);
      if (!payload || typeof payload !== 'object' || !REMOTE_STATUSES.has(payload.status)) {
        throw new Error('Invalid status payload.');
      }
      const sanitized = sanitizePayload(payload);
      if (payload.status === 'unknown') {
        return {
          ...sanitized,
          status: 'unknown',
          hint: sanitized.hint || '知天可达，但无法判断其备份状态。',
        };
      }
      return sanitized;
    } catch (_error) {
      return {
        status: 'unknown',
        reason: 'invalid_response',
        hint: '知天可达，但返回的备份状态格式无法识别。',
      };
    }
  }
}

module.exports = {
  CONNECT_TIMEOUT_MS,
  TOTAL_TIMEOUT_MS,
  ZHITIAN_BACKUP_STATUS_URL,
  ZhitianBackupStatusClient,
  requestStatus,
  sanitizePayload,
};
