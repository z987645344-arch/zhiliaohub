// Exercises password-authorized pairing, P-256 challenge login, replay defense, revocation and replacement.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const bcrypt = require('bcrypt');
const speakeasy = require('speakeasy');

const { createApp } = require('../src/app');

function createClient(baseUrl) {
  let cookie = '';
  return {
    async request(url, options = {}) {
      const headers = new Headers(options.headers || {});
      if (cookie) headers.set('cookie', cookie);
      const response = await fetch(`${baseUrl}${url}`, { ...options, headers, redirect: 'manual' });
      const setCookies = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean);
      for (const value of setCookies) {
        if (value.startsWith('zhiliaohub.admin.sid=')) cookie = value.split(';', 1)[0];
      }
      return response;
    },
  };
}

function form(values) {
  return new URLSearchParams(values);
}

function extractCsrf(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, '页面应包含CSRF令牌。');
  return match[1];
}

function extractTotpSecret(html) {
  const match = html.match(/<code data-totp-secret>([A-Z2-7]+)<\/code>/);
  assert.ok(match, 'TOTP绑定页应包含手动密钥。');
  return match[1];
}

async function createRuntime() {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-device-auth-'));
  const password = 'device-auth-test-password';
  const context = createApp({
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 3001,
    sessionSecret: crypto.randomBytes(48).toString('base64url'),
    adminPasswordHash: await bcrypt.hash(password, 4),
    totpEncryptionKey: crypto.randomBytes(32),
    dataDir: path.join(runtimeRoot, 'data'),
    databasePath: path.join(runtimeRoot, 'data', 'test.sqlite3'),
    contentDir: path.join(runtimeRoot, 'content'),
    uploadsDir: path.join(runtimeRoot, 'uploads'),
    authRateLimitWindowMs: 60 * 1000,
    authRateLimitMax: 20,
    pairingCodeTtlMs: 5 * 60 * 1000,
    deviceChallengeTtlMs: 2 * 60 * 1000,
    deviceAuthRateLimitWindowMs: 60 * 1000,
    deviceAuthRateLimitMax: 50,
  });
  const server = await new Promise((resolve) => {
    const instance = context.app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  return {
    ...context,
    password,
    runtimeRoot,
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      context.sessionStore.close();
      context.database.close();
      await fs.rm(runtimeRoot, { recursive: true, force: true });
    },
  };
}

async function passwordTotpLogin(client, runtime) {
  let response = await client.request('/admin/login');
  let csrf = extractCsrf(await response.text());
  response = await client.request('/admin/login', {
    method: 'POST',
    body: form({ _csrf: csrf, password: runtime.password }),
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/admin/totp/setup');
  response = await client.request('/admin/totp/setup');
  const html = await response.text();
  csrf = extractCsrf(html);
  const secret = extractTotpSecret(html);
  response = await client.request('/admin/totp/setup', {
    method: 'POST',
    body: form({ _csrf: csrf, token: speakeasy.totp({ secret, encoding: 'base32' }) }),
  });
  assert.equal(response.status, 302);
  response = await client.request('/admin');
  assert.equal(response.status, 200, '原有密码+TOTP登录应保持可用。');
  return extractCsrf(await response.text());
}

function keyPair() {
  return crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function signature(privateKey, signedPayload) {
  return crypto.sign('sha256', Buffer.from(signedPayload, 'utf8'), privateKey).toString('base64');
}

async function jsonRequest(client, url, body, headers = {}) {
  return client.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('设备配对与挑战应答登录完整流程', async (t) => {
  const runtime = await createRuntime();
  t.after(() => runtime.close());
  const adminClient = createClient(runtime.baseUrl);
  let adminCsrf = await passwordTotpLogin(adminClient, runtime);
  const firstKeys = keyPair();
  const secondKeys = keyPair();
  const thirdKeys = keyPair();
  const rsaKeys = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  let firstDevice;
  let secondDevice;
  let firstDeviceClient;

  await t.test('配对码只能由密码+TOTP管理员会话生成，且过期/重用均被拒绝', async () => {
    const anonymous = createClient(runtime.baseUrl);
    let response = await jsonRequest(anonymous, '/api/admin/device/pairing-code', {});
    assert.equal(response.status, 401);

    response = await jsonRequest(adminClient, '/api/admin/device/pairing-code', {}, { 'x-csrf-token': adminCsrf });
    assert.equal(response.status, 201);
    const expiredCode = await response.json();
    assert.match(expiredCode.pairingCode, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    runtime.database.prepare('UPDATE pairing_codes SET expires_at = 0 WHERE used_at IS NULL').run();
    response = await jsonRequest(anonymous, '/api/device-auth/pair', {
      pairingCode: expiredCode.pairingCode,
      publicKeyPem: firstKeys.publicKey,
      deviceName: '首台安卓设备',
    });
    assert.equal(response.status, 401, '过期配对码必须被拒绝。');

    response = await jsonRequest(adminClient, '/api/admin/device/pairing-code', {}, { 'x-csrf-token': adminCsrf });
    const validCode = await response.json();
    response = await jsonRequest(anonymous, '/api/device-auth/pair', {
      pairingCode: validCode.pairingCode,
      publicKeyPem: rsaKeys.publicKey,
      deviceName: '错误算法设备',
    });
    assert.equal(response.status, 400, '非P-256设备公钥必须被拒绝且不得消费配对码。');
    response = await jsonRequest(anonymous, '/api/device-auth/pair', {
      pairingCode: validCode.pairingCode,
      publicKeyPem: firstKeys.publicKey,
      deviceName: '首台安卓设备',
    });
    assert.equal(response.status, 201);
    firstDevice = (await response.json()).device;
    assert.equal(firstDevice.deviceName, '首台安卓设备');
    const stored = runtime.database.prepare('SELECT * FROM devices WHERE id = ?').get(firstDevice.id);
    assert.match(stored.public_key_pem, /BEGIN PUBLIC KEY/);
    assert.equal(stored.revoked, 0);

    response = await jsonRequest(anonymous, '/api/device-auth/pair', {
      pairingCode: validCode.pairingCode,
      publicKeyPem: secondKeys.publicKey,
      deviceName: '重用配对码',
    });
    assert.equal(response.status, 401, '已经使用的配对码必须立即失效。');
  });

  await t.test('正确签名登录成功，错误签名失败且不会消耗挑战', async () => {
    firstDeviceClient = createClient(runtime.baseUrl);
    let response = await jsonRequest(firstDeviceClient, '/api/device-auth/challenge', {});
    assert.equal(response.status, 201);
    const challenge = await response.json();
    assert.equal(challenge.signatureAlgorithm, 'SHA256withECDSA');
    assert.equal(challenge.signatureEncoding, 'DER_BASE64');

    response = await jsonRequest(firstDeviceClient, '/api/device-auth/login', {
      challengeId: challenge.challengeId,
      signature: signature(secondKeys.privateKey, challenge.signedPayload),
    });
    assert.equal(response.status, 401, '错误私钥签名必须被拒绝。');

    response = await jsonRequest(firstDeviceClient, '/api/device-auth/login', {
      challengeId: challenge.challengeId,
      signature: signature(firstKeys.privateKey, challenge.signedPayload),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).authenticated, true);
    response = await firstDeviceClient.request('/api/admin/works');
    assert.equal(response.status, 200, '设备登录应复用现有管理员session。');

    const dashboard = await firstDeviceClient.request('/admin');
    const deviceCsrf = extractCsrf(await dashboard.text());
    response = await jsonRequest(firstDeviceClient, '/api/admin/device/pairing-code', {}, {
      'x-csrf-token': deviceCsrf,
    });
    assert.equal(response.status, 403, '设备登录会话不得生成新的配对授权。');
  });

  await t.test('同一挑战成功使用后不能重放，过期挑战也会被拒绝', async () => {
    const client = createClient(runtime.baseUrl);
    let response = await jsonRequest(client, '/api/device-auth/challenge', {});
    const replayChallenge = await response.json();
    const replaySignature = signature(firstKeys.privateKey, replayChallenge.signedPayload);
    response = await jsonRequest(client, '/api/device-auth/login', {
      challengeId: replayChallenge.challengeId,
      signature: replaySignature,
    });
    assert.equal(response.status, 200);
    response = await jsonRequest(createClient(runtime.baseUrl), '/api/device-auth/login', {
      challengeId: replayChallenge.challengeId,
      signature: replaySignature,
    });
    assert.equal(response.status, 401, '已经使用的挑战不得重放。');

    response = await jsonRequest(createClient(runtime.baseUrl), '/api/device-auth/challenge', {});
    const expiredChallenge = await response.json();
    runtime.database.prepare('UPDATE device_challenges SET expires_at = 0 WHERE id = ?')
      .run(expiredChallenge.challengeId);
    response = await jsonRequest(createClient(runtime.baseUrl), '/api/device-auth/login', {
      challengeId: expiredChallenge.challengeId,
      signature: signature(firstKeys.privateKey, expiredChallenge.signedPayload),
    });
    assert.equal(response.status, 401, '过期挑战必须被拒绝。');
  });

  await t.test('吊销设备后旧挑战与后续登录立即失效', async () => {
    const challenger = createClient(runtime.baseUrl);
    let response = await jsonRequest(challenger, '/api/device-auth/challenge', {});
    const challengeBeforeRevoke = await response.json();
    response = await jsonRequest(adminClient, '/api/admin/device/revoke', {}, { 'x-csrf-token': adminCsrf });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).device.revoked, true);

    response = await jsonRequest(challenger, '/api/device-auth/login', {
      challengeId: challengeBeforeRevoke.challengeId,
      signature: signature(firstKeys.privateKey, challengeBeforeRevoke.signedPayload),
    });
    assert.equal(response.status, 401);
    response = await jsonRequest(createClient(runtime.baseUrl), '/api/device-auth/challenge', {});
    assert.equal(response.status, 409, '吊销后没有有效设备，不得签发新挑战。');
    response = await firstDeviceClient.request('/api/admin/works');
    assert.equal(response.status, 401, '设备吊销后该设备建立的既有session也不得继续访问。');
  });

  await t.test('重新配对可恢复登录，新配对会自动替换仍有效的旧设备', async () => {
    let response = await jsonRequest(adminClient, '/api/admin/device/pairing-code', {}, {
      'x-csrf-token': adminCsrf,
    });
    let code = await response.json();
    response = await jsonRequest(createClient(runtime.baseUrl), '/api/device-auth/pair', {
      pairingCode: code.pairingCode,
      publicKeyPem: secondKeys.publicKey,
      deviceName: '第二台安卓设备',
    });
    assert.equal(response.status, 201);
    secondDevice = (await response.json()).device;

    response = await jsonRequest(adminClient, '/api/admin/device/pairing-code', {}, {
      'x-csrf-token': adminCsrf,
    });
    code = await response.json();
    response = await jsonRequest(createClient(runtime.baseUrl), '/api/device-auth/pair', {
      pairingCode: code.pairingCode,
      publicKeyPem: thirdKeys.publicKey,
      deviceName: '第三台安卓设备',
    });
    assert.equal(response.status, 201);
    const thirdDevice = (await response.json()).device;
    assert.notEqual(thirdDevice.id, secondDevice.id);
    assert.equal(runtime.database.prepare('SELECT COUNT(*) AS count FROM devices WHERE revoked = 0').get().count, 1);
    assert.equal(runtime.database.prepare('SELECT revoked FROM devices WHERE id = ?').get(secondDevice.id).revoked, 1);

    response = await jsonRequest(createClient(runtime.baseUrl), '/api/device-auth/challenge', {});
    const challenge = await response.json();
    response = await jsonRequest(createClient(runtime.baseUrl), '/api/device-auth/login', {
      challengeId: challenge.challengeId,
      signature: signature(secondKeys.privateKey, challenge.signedPayload),
    });
    assert.equal(response.status, 401, '被新配对替换的旧设备私钥不得登录。');
    response = await jsonRequest(createClient(runtime.baseUrl), '/api/device-auth/login', {
      challengeId: challenge.challengeId,
      signature: signature(thirdKeys.privateKey, challenge.signedPayload),
    });
    assert.equal(response.status, 200, '新设备应能使用同一未消耗挑战完成登录。');

    const managementPage = await adminClient.request('/admin/device');
    assert.equal(managementPage.status, 200);
    assert.match(await managementPage.text(), /第三台安卓设备/);
    const pairingPage = await adminClient.request('/admin/device/pairing-code', {
      method: 'POST',
      body: form({ _csrf: adminCsrf }),
    });
    assert.equal(pairingPage.status, 200);
    assert.match(await pairingPage.text(), /data-pairing-code/, '设备管理页面应能手动生成并显示配对码。');
  });
});
