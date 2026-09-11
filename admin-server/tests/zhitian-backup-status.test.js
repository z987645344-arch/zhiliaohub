// Exercises the real HTTP boundary for the first runtime dependency on Zhitian.
const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const {
  CONNECT_TIMEOUT_MS,
  TOTAL_TIMEOUT_MS,
  ZhitianBackupStatusClient,
} = require('../src/services/zhitian-backup-status-client');
const { dashboardPage } = require('../src/views');

async function withServer(handler, run) {
  const server = http.createServer(handler);
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  try {
    return await run(`http://127.0.0.1:${port}/ops/backup-status`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function client(url, overrides = {}) {
  return new ZhitianBackupStatusClient({ zhitianOpsToken: 'test-ops-token' }, {
    url,
    connectTimeoutMs: overrides.connectTimeoutMs ?? 100,
    totalTimeoutMs: overrides.totalTimeoutMs ?? 200,
  });
}

function renderZhitianCard(status) {
  return dashboardPage({
    csrfToken: 'test-csrf',
    works: [],
    notes: [],
    publishStatus: null,
    pendingFeedbackCount: 0,
    backupStatus: {
      zhiliaohub: { status: 'ok', label: '正常', hint: '知了hub正常。' },
      zhitian: status,
    },
  });
}

test('知天状态拉取使用2秒连接与3秒总上界，并区分HTTP与业务状态', async (t) => {
  assert.equal(CONNECT_TIMEOUT_MS, 2000);
  assert.equal(TOTAL_TIMEOUT_MS, 3000);

  await t.test('200正常响应透传diagnostic但剔除文件、路径与数量字段', async () => {
    await withServer((request, response) => {
      assert.equal(request.headers['x-ops-token'], 'test-ops-token');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        status: 'ok',
        reason: 'current_window_archived',
        hint: '知天调度备份正常。',
        diagnostic: { probe: 'fake-upstream' },
        filename: 'must-not-pass.tar.gz',
        backupPath: '/must/not/pass',
        archiveCount: 9,
      }));
    }, async (url) => {
      const result = await client(url).getStatus();
      assert.equal(result.status, 'ok');
      assert.deepEqual(result.diagnostic, { probe: 'fake-upstream' });
      assert.equal(result.filename, undefined);
      assert.equal(result.backupPath, undefined);
      assert.equal(result.archiveCount, undefined);
      const html = renderZhitianCard(result);
      assert.match(html, /data-backup-project="zhitian" data-backup-status="ok"/);
      assert.doesNotMatch(html, /fake-upstream/, 'diagnostic只透传给认证API，不在页面渲染。');
    });
  });

  await t.test('401与404都降级为不可达但提示原因不同', async () => {
    for (const [statusCode, reason] of [[401, 'authentication_failed'], [404, 'endpoint_not_configured']]) {
      await withServer((_request, response) => {
        response.writeHead(statusCode);
        response.end();
      }, async (url) => {
        const result = await client(url).getStatus();
        assert.equal(result.status, 'unreachable');
        assert.equal(result.reason, reason);
        assert.match(renderZhitianCard(result), new RegExp(result.hint));
      });
    }
  });

  await t.test('5xx是不可达而不是stale', async () => {
    await withServer((_request, response) => {
      response.writeHead(503);
      response.end();
    }, async (url) => {
      const result = await client(url).getStatus();
      assert.equal(result.status, 'unreachable');
      assert.equal(result.reason, 'upstream_error');
      assert.match(renderZhitianCard(result), /HTTP 503/);
    });
  });

  await t.test('总超时是不可达而不是stale且不会无限等待', async () => {
    await withServer(() => {}, async (url) => {
      const startedAt = Date.now();
      const result = await client(url, { connectTimeoutMs: 25, totalTimeoutMs: 40 }).getStatus();
      assert.equal(result.status, 'unreachable');
      assert.equal(result.reason, 'request_timeout');
      assert.ok(Date.now() - startedAt < 500, '测试夹具的总超时必须形成硬上界。');
      assert.match(renderZhitianCard(result), /请求超时/);
    });
  });

  await t.test('200但status=unknown保持未知而不是不可达或stale', async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        status: 'unknown',
        reason: 'backup_dir_unreadable',
        hint: '知天备份目录不可读。',
      }));
    }, async (url) => {
      const result = await client(url).getStatus();
      assert.equal(result.status, 'unknown');
      assert.equal(result.reason, 'backup_dir_unreadable');
      assert.match(renderZhitianCard(result), /data-backup-project="zhitian" data-backup-status="unknown"/);
      assert.match(renderZhitianCard(result), /知天备份目录不可读/);
    });
  });
});
