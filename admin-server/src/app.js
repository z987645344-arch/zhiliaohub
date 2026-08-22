// Assembles the isolated Express application, authentication flow, content APIs and admin forms.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const bcrypt = require('bcrypt');
const session = require('express-session');
const helmet = require('helmet');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const QRCode = require('qrcode');
const speakeasy = require('speakeasy');

const { loadConfig } = require('./config');
const { initializeDatabase } = require('./db');
const { encryptTotpSecret, decryptTotpSecret } = require('./lib/totp-secret');
const { labManagementScript, workFormScript } = require('./lib/html');
const { SQLiteSessionStore } = require('./lib/sqlite-session-store');
const {
  UploadPolicyError,
  multerFileFilter,
  zipFileFilter,
  validateAndFinalizeUpload,
} = require('./lib/upload-policy');
const { ContentService, ContentValidationError } = require('./services/content-service');
const { DeviceAuthError, DeviceAuthService } = require('./services/device-auth-service');
const { FeedbackService, FeedbackValidationError } = require('./services/feedback-service');
const { LabService, LabValidationError } = require('./services/lab-service');
const { PublishError, PublishService } = require('./services/publish-service');
const {
  loginPage,
  totpSetupPage,
  totpVerifyPage,
  dashboardPage,
  feedbackManagementPage,
  labManagementPage,
  deviceManagementPage,
  workFormPage,
  contentFormPage,
  errorPage,
} = require('./views');

function csrfToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function safeTokenEqual(left, right) {
  const first = Buffer.from(String(left || ''));
  const second = Buffer.from(String(right || ''));
  return first.length === second.length && first.length > 0 && crypto.timingSafeEqual(first, second);
}

function saveSession(request) {
  return new Promise((resolve, reject) => {
    request.session.save((error) => (error ? reject(error) : resolve()));
  });
}

function regenerateSession(request, values) {
  return new Promise((resolve, reject) => {
    request.session.regenerate((error) => {
      if (error) return reject(error);
      Object.assign(request.session, values, { csrfToken: csrfToken() });
      request.session.save((saveError) => (saveError ? reject(saveError) : resolve()));
    });
  });
}

function destroySession(request) {
  return new Promise((resolve, reject) => {
    request.session.destroy((error) => (error ? reject(error) : resolve()));
  });
}

function verifyTotpStep(secret, token) {
  if (!/^\d{6}$/.test(String(token || ''))) return null;
  const delta = speakeasy.totp.verifyDelta({
    secret,
    encoding: 'base32',
    token: String(token),
    step: 30,
    window: 1,
  });
  if (!delta) return null;
  return Math.floor(Date.now() / 1000 / 30) + delta.delta;
}

function createApp(overrides = {}) {
  const config = loadConfig(overrides);
  const database = initializeDatabase(config);
  const contentService = new ContentService(database, config);
  const publishService = new PublishService(database, config);
  const deviceAuthService = new DeviceAuthService(database, config);
  const feedbackService = new FeedbackService(database);
  const labService = new LabService(database, config);
  const sessionStore = new SQLiteSessionStore({
    database,
    defaultTtlMs: config.sessionMaxAgeMs,
    cleanupIntervalMs: config.sessionCleanupIntervalMs,
  });
  const app = express();

  if (config.trustProxyHops > 0) app.set('trust proxy', config.trustProxyHops);
  app.disable('x-powered-by');
  app.use('/lab', (request, response, next) => {
    response.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    next();
  }, express.static(config.labStorageDir, {
    dotfiles: 'deny',
    index: 'index.html',
    redirect: true,
  }));
  app.use('/lab', (_request, response) => {
    response.status(404).type('text/plain').send('小作坊项目或文件不存在。');
  });
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
      },
    },
  }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(session({
    name: 'zhiliaohub.admin.sid',
    store: sessionStore,
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'strict',
      maxAge: config.sessionMaxAgeMs,
    },
  }));

  app.use((request, response, next) => {
    const publicApiRequest = request.path.startsWith('/api/device-auth/')
      || request.path.startsWith('/api/feedback/');
    if (!publicApiRequest && !request.session.csrfToken) request.session.csrfToken = csrfToken();
    response.locals.csrfToken = request.session.csrfToken || '';
    next();
  });

  function requireCsrf(request, response, next) {
    const supplied = request.get('x-csrf-token') || request.body?._csrf;
    if (!safeTokenEqual(request.session.csrfToken, supplied)) {
      if (request.file?.path) fs.unlink(request.file.path, () => {});
      if (request.path.startsWith('/api/')) return response.status(403).json({ error: 'CSRF令牌无效。' });
      return response.status(403).send(errorPage({
        statusCode: 403,
        message: '页面令牌已失效，请返回后重试。',
        csrfToken: response.locals.csrfToken,
        authenticated: Boolean(request.session.adminAuthenticated),
      }));
    }
    next();
  }

  function requireAdmin(request, response, next) {
    const deviceSessionIsActive = request.session.authMethod !== 'device'
      || deviceAuthService.isDeviceActive(request.session.deviceId);
    if (request.session.adminAuthenticated && deviceSessionIsActive) return next();
    if (request.path.startsWith('/api/')) return response.status(401).json({ error: '需要管理员登录。' });
    return response.redirect('/admin/login');
  }

  function requirePasswordTotpAdmin(request, response, next) {
    if (!request.session.adminAuthenticated) {
      if (request.path.startsWith('/api/')) return response.status(401).json({ error: '需要管理员登录。' });
      return response.redirect('/admin/login');
    }
    if (request.session.adminAuthenticated && request.session.authMethod === 'password-totp') return next();
    const message = '该操作要求当前会话通过密码和TOTP登录。';
    if (request.path.startsWith('/api/')) return response.status(403).json({ error: message });
    return response.status(403).send(errorPage({
      statusCode: 403,
      message,
      csrfToken: response.locals.csrfToken,
      authenticated: Boolean(request.session.adminAuthenticated),
    }));
  }

  function requirePasswordStep(request, response, next) {
    if (request.session.passwordVerified) return next();
    return response.redirect('/admin/login');
  }

  function authRecord() {
    return database.prepare('SELECT * FROM auth_settings WHERE id = 1').get();
  }

  function totpIsBound() {
    return Boolean(authRecord()?.totp_ciphertext);
  }

  function persistedTotpSecret() {
    const record = authRecord();
    if (!record?.totp_ciphertext) throw new Error('TOTP has not been bound.');
    return { record, secret: decryptTotpSecret(record, config.totpEncryptionKey) };
  }

  function persistBoundTotp(secret, step) {
    const encrypted = encryptTotpSecret(secret, config.totpEncryptionKey);
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO auth_settings (
        id, totp_ciphertext, totp_iv, totp_auth_tag, totp_bound_at, last_used_step, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        totp_ciphertext = excluded.totp_ciphertext,
        totp_iv = excluded.totp_iv,
        totp_auth_tag = excluded.totp_auth_tag,
        totp_bound_at = excluded.totp_bound_at,
        last_used_step = excluded.last_used_step,
        updated_at = excluded.updated_at
    `).run(encrypted.ciphertext, encrypted.iv, encrypted.authTag, now, step, now);
  }

  const limiterOptions = {
    windowMs: config.authRateLimitWindowMs,
    limit: config.authRateLimitMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (request, response) => {
      const message = '该IP的认证尝试过于频繁，请稍后再试；账号本身没有被锁定。';
      if (request.path.startsWith('/api/')) return response.status(429).json({ error: message });
      return response.status(429).send(loginPage({ csrfToken: response.locals.csrfToken, error: message }));
    },
  };
  const passwordLimiter = rateLimit(limiterOptions);
  const totpLimiter = rateLimit(limiterOptions);
  const deviceAuthLimiter = rateLimit({
    windowMs: config.deviceAuthRateLimitWindowMs,
    limit: config.deviceAuthRateLimitMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_request, response) => response.status(429).json({
      error: '该IP的设备认证请求过于频繁，请稍后再试。',
    }),
  });
  const feedbackLimiter = rateLimit({
    windowMs: config.feedbackRateLimitWindowMs,
    limit: config.feedbackRateLimitMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_request, response) => response.status(429).json({
      error: '该IP提交留言过于频繁，请稍后再试。',
    }),
  });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_request, _file, callback) => callback(null, config.uploadsDir),
      filename: (_request, file, callback) => {
        const extension = path.extname(file.originalname || '').toLowerCase();
        callback(null, `pending-${crypto.randomUUID()}${extension}`);
      },
    }),
    limits: { fileSize: config.uploadMaxBytes, files: 1 },
    fileFilter: multerFileFilter,
  });
  const labUpload = multer({
    storage: multer.diskStorage({
      destination: (_request, _file, callback) => callback(null, config.uploadsDir),
      filename: (_request, _file, callback) => callback(null, `pending-lab-${crypto.randomUUID()}.zip`),
    }),
    limits: { fileSize: config.uploadMaxBytes, files: 1 },
    fileFilter: zipFileFilter,
  });

  app.get('/admin/work-form.js', requireAdmin, (_request, response) => {
    response.set('Cache-Control', 'no-store');
    response.type('application/javascript').send(workFormScript());
  });
  app.get('/admin/lab.js', requireAdmin, (_request, response) => {
    response.set('Cache-Control', 'no-store');
    response.type('application/javascript').send(labManagementScript());
  });
  app.use('/uploads', requireAdmin, express.static(config.uploadsDir, {
    dotfiles: 'deny',
    index: false,
    redirect: false,
  }));

  app.get('/health', (_request, response) => {
    response.json({
      status: 'ok',
      storage: 'sqlite+markdown',
      deployment: config.isProduction ? 'production' : 'local-only',
    });
  });

  app.post('/api/feedback/comments', feedbackLimiter, (request, response, next) => {
    const accepted = {
      accepted: true,
      status: 'pending',
      message: '留言已提交审核。',
    };
    if (String(request.body?.website || '').trim()) return response.status(202).json(accepted);
    try {
      feedbackService.createComment(request.body, request.ip);
      return response.status(202).json(accepted);
    } catch (error) {
      return next(error);
    }
  });

  app.get('/admin/login', (request, response) => {
    if (request.session.adminAuthenticated) return response.redirect('/admin');
    response.send(loginPage({ csrfToken: response.locals.csrfToken }));
  });

  app.post('/admin/login', passwordLimiter, requireCsrf, async (request, response, next) => {
    try {
      const valid = await bcrypt.compare(String(request.body.password || ''), config.adminPasswordHash);
      if (!valid) {
        return response.status(401).send(loginPage({
          csrfToken: response.locals.csrfToken,
          error: '密码不正确。',
        }));
      }

      request.session.passwordVerified = true;
      request.session.adminAuthenticated = false;
      request.session.pendingTotpSecret = undefined;
      request.session.csrfToken = csrfToken();
      await saveSession(request);
      return response.redirect(totpIsBound() ? '/admin/totp/verify' : '/admin/totp/setup');
    } catch (error) {
      return next(error);
    }
  });

  app.get('/admin/totp/setup', requirePasswordStep, async (request, response, next) => {
    try {
      if (totpIsBound()) return response.redirect('/admin/totp/verify');
      if (!request.session.pendingTotpSecret) {
        const generated = speakeasy.generateSecret({
          length: 20,
          name: `知了hub (${config.adminUsername})`,
          issuer: '知了hub 管理后台',
        });
        request.session.pendingTotpSecret = generated.base32;
        request.session.pendingTotpUrl = generated.otpauth_url;
        await saveSession(request);
      }
      const qrDataUrl = await QRCode.toDataURL(request.session.pendingTotpUrl, { margin: 1, width: 300 });
      return response.send(totpSetupPage({
        csrfToken: request.session.csrfToken,
        qrDataUrl,
        secret: request.session.pendingTotpSecret,
      }));
    } catch (error) {
      return next(error);
    }
  });

  app.post('/admin/totp/setup', totpLimiter, requirePasswordStep, requireCsrf, async (request, response, next) => {
    try {
      if (totpIsBound()) return response.redirect('/admin/totp/verify');
      const secret = request.session.pendingTotpSecret;
      const step = secret ? verifyTotpStep(secret, request.body.token) : null;
      if (step === null) {
        const qrDataUrl = secret
          ? await QRCode.toDataURL(request.session.pendingTotpUrl, { margin: 1, width: 300 })
          : '';
        return response.status(401).send(totpSetupPage({
          csrfToken: response.locals.csrfToken,
          qrDataUrl,
          secret: secret || '',
          error: '动态验证码不正确或已经过期。',
        }));
      }

      persistBoundTotp(secret, step);
      await regenerateSession(request, { adminAuthenticated: true, authMethod: 'password-totp' });
      return response.redirect('/admin');
    } catch (error) {
      return next(error);
    }
  });

  app.get('/admin/totp/verify', requirePasswordStep, (request, response) => {
    if (!totpIsBound()) return response.redirect('/admin/totp/setup');
    response.send(totpVerifyPage({ csrfToken: response.locals.csrfToken }));
  });

  app.post('/admin/totp/verify', totpLimiter, requirePasswordStep, requireCsrf, async (request, response, next) => {
    try {
      const { record, secret } = persistedTotpSecret();
      const step = verifyTotpStep(secret, request.body.token);
      if (step === null || (record.last_used_step !== null && step <= record.last_used_step)) {
        return response.status(401).send(totpVerifyPage({
          csrfToken: response.locals.csrfToken,
          error: '动态验证码不正确、已经过期或已使用。',
        }));
      }

      database.prepare('UPDATE auth_settings SET last_used_step = ?, updated_at = ? WHERE id = 1')
        .run(step, new Date().toISOString());
      await regenerateSession(request, { adminAuthenticated: true, authMethod: 'password-totp' });
      return response.redirect('/admin');
    } catch (error) {
      return next(error);
    }
  });

  app.post('/admin/logout', requireAdmin, requireCsrf, async (request, response, next) => {
    try {
      await destroySession(request);
      response.clearCookie('zhiliaohub.admin.sid');
      return response.redirect('/admin/login');
    } catch (error) {
      return next(error);
    }
  });

  app.get('/admin', requireAdmin, (request, response) => {
    response.send(dashboardPage({
      csrfToken: response.locals.csrfToken,
      works: contentService.listWorks(),
      notes: contentService.listNotes(),
      publishStatus: publishService.getStatus(),
      pendingFeedbackCount: feedbackService.countPending(),
      notice: request.query.notice || '',
    }));
  });

  function feedbackFilter(value) {
    return value === 'all' ? 'all' : 'pending';
  }

  app.get('/admin/feedback', requireAdmin, (request, response) => {
    const filter = feedbackFilter(request.query.filter);
    const allTopics = feedbackService.listTopics();
    response.send(feedbackManagementPage({
      csrfToken: response.locals.csrfToken,
      topics: filter === 'pending' ? allTopics.filter((topic) => topic.hasPending) : allTopics,
      filter,
      pendingCount: feedbackService.countPending(),
      totalTopics: allTopics.length,
      notice: request.query.notice || '',
    }));
  });

  app.get('/admin/lab', requireAdmin, (request, response) => {
    response.send(labManagementPage({
      csrfToken: response.locals.csrfToken,
      projects: labService.listProjects(),
      notice: request.query.notice || '',
    }));
  });

  async function createLabProject(request, response, next, asJson) {
    try {
      if (!request.file) throw new LabValidationError('请选择一个ZIP文件。');
      const project = await labService.createProject(request.file, {
        title: request.body.title,
        description: request.body.description,
        isVisible: request.body.isVisible === '1' || request.body.isVisible === true,
      });
      const publication = await publishService.publishAll();
      if (asJson) return response.status(201).json({ project, publication });
      return response.redirect(`/admin/lab?notice=${encodeURIComponent(`项目已创建：${project.accessUrl}`)}`);
    } catch (error) {
      if (request.file?.path) fs.unlink(request.file.path, () => {});
      return next(error);
    }
  }

  app.post('/admin/lab/upload', requireAdmin, labUpload.single('file'), requireCsrf, (request, response, next) => {
    createLabProject(request, response, next, false);
  });

  app.post('/api/admin/lab/upload', requireAdmin, labUpload.single('file'), requireCsrf, (request, response, next) => {
    createLabProject(request, response, next, true);
  });

  app.post('/admin/lab/:id/visibility', requireAdmin, requireCsrf, async (request, response, next) => {
    try {
      const project = labService.toggleVisibility(request.params.id);
      await publishService.publishAll();
      response.redirect(`/admin/lab?notice=${encodeURIComponent(project.isVisible ? '项目已展示在作品页。' : '项目已从作品页隐藏。')}`);
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/lab/:id/delete', requireAdmin, requireCsrf, async (request, response, next) => {
    try {
      await labService.deleteProject(request.params.id);
      await publishService.publishAll();
      response.redirect('/admin/lab?notice=项目及解压目录已删除。');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/feedback/:id/approve', requireAdmin, requireCsrf, (request, response, next) => {
    try {
      feedbackService.approveComment(request.params.id);
      response.redirect(`/admin/feedback?filter=${feedbackFilter(request.body.filter)}&notice=留言已通过审核。`);
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/feedback/:id/reject', requireAdmin, requireCsrf, (request, response, next) => {
    try {
      feedbackService.rejectComment(request.params.id);
      response.redirect(`/admin/feedback?filter=${feedbackFilter(request.body.filter)}&notice=留言已隐藏。`);
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/feedback/:id/reply', requireAdmin, requireCsrf, (request, response, next) => {
    try {
      feedbackService.createAdminReply(request.params.id, request.body.body, request.ip);
      response.redirect(`/admin/feedback?filter=${feedbackFilter(request.body.filter)}&notice=站长回复已发布。`);
    } catch (error) {
      next(error);
    }
  });

  app.get('/admin/device', requireAdmin, (request, response) => {
    response.send(deviceManagementPage({
      csrfToken: response.locals.csrfToken,
      device: deviceAuthService.currentDevice(),
      notice: request.query.notice || '',
      canGeneratePairingCode: request.session.authMethod === 'password-totp',
    }));
  });

  app.post('/admin/device/pairing-code', requirePasswordTotpAdmin, requireCsrf, (request, response) => {
    const generated = deviceAuthService.generatePairingCode();
    response.send(deviceManagementPage({
      csrfToken: response.locals.csrfToken,
      device: deviceAuthService.currentDevice(),
      pairingCode: generated.pairingCode,
      pairingExpiresAt: generated.expiresAt,
      canGeneratePairingCode: true,
    }));
  });

  app.post('/admin/device/revoke', requireAdmin, requireCsrf, (request, response, next) => {
    try {
      deviceAuthService.revokeCurrentDevice();
      response.redirect('/admin/device?notice=当前设备已吊销。');
    } catch (error) {
      next(error);
    }
  });

  app.get('/admin/works/new', requireAdmin, (_request, response) => {
    response.send(workFormPage({ csrfToken: response.locals.csrfToken }));
  });

  app.get('/admin/notes/new', requireAdmin, (_request, response) => {
    response.send(contentFormPage({ csrfToken: response.locals.csrfToken, type: 'note' }));
  });

  app.get('/admin/works/:id/edit', requireAdmin, async (request, response, next) => {
    try {
      const record = await contentService.getWork(request.params.id);
      response.send(workFormPage({ csrfToken: response.locals.csrfToken, record }));
    } catch (error) {
      next(error);
    }
  });

  app.get('/admin/notes/:id/edit', requireAdmin, async (request, response, next) => {
    try {
      const record = await contentService.getNote(request.params.id);
      response.send(contentFormPage({ csrfToken: response.locals.csrfToken, type: 'note', record }));
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/works', requireAdmin, requireCsrf, async (request, response, next) => {
    try {
      await contentService.createWork(request.body);
      await publishService.publishAll();
      response.redirect('/admin?notice=作品已保存并发布。');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/notes', requireAdmin, requireCsrf, async (request, response, next) => {
    try {
      await contentService.createNote(request.body);
      await publishService.publishAll();
      response.redirect('/admin?notice=日记已保存并发布。');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/works/:id', requireAdmin, requireCsrf, async (request, response, next) => {
    try {
      await contentService.updateWork(request.params.id, request.body);
      await publishService.publishAll();
      response.redirect('/admin?notice=作品已更新并发布。');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/notes/:id', requireAdmin, requireCsrf, async (request, response, next) => {
    try {
      await contentService.updateNote(request.params.id, request.body);
      await publishService.publishAll();
      response.redirect('/admin?notice=日记已更新并发布。');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/works/:id/delete', requireAdmin, requireCsrf, async (request, response, next) => {
    try {
      await contentService.deleteWork(request.params.id);
      await publishService.publishAll();
      response.redirect('/admin?notice=作品已删除，静态页面已同步清理。');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/notes/:id/delete', requireAdmin, requireCsrf, async (request, response, next) => {
    try {
      await contentService.deleteNote(request.params.id);
      await publishService.publishAll();
      response.redirect('/admin?notice=日记已删除，静态页面已同步清理。');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/publish', requireAdmin, requireCsrf, async (_request, response, next) => {
    try {
      await publishService.publishAll();
      response.redirect('/admin?notice=静态前台已完成全量重新发布。');
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/admin/works', requireAdmin, (_request, response) => {
    response.json({ items: contentService.listWorks() });
  });

  app.get('/api/admin/notes', requireAdmin, (_request, response) => {
    response.json({ items: contentService.listNotes() });
  });

  app.get('/api/admin/lab', requireAdmin, (_request, response) => {
    response.json({ items: labService.listProjects() });
  });

  app.post('/api/admin/lab/:id/visibility', requireAdmin, requireCsrf, async (request, response, next) => {
    try {
      const project = labService.toggleVisibility(request.params.id);
      const publication = await publishService.publishAll();
      response.json({ project, publication });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/admin/lab/:id', requireAdmin, requireCsrf, async (request, response, next) => {
    try {
      const project = await labService.deleteProject(request.params.id);
      const publication = await publishService.publishAll();
      response.json({ project, publication });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/admin/device', requireAdmin, (_request, response) => {
    response.json({ device: deviceAuthService.currentDevice() });
  });

  app.post('/api/admin/device/pairing-code', requirePasswordTotpAdmin, requireCsrf, (_request, response) => {
    response.status(201).json(deviceAuthService.generatePairingCode());
  });

  app.post('/api/admin/device/revoke', requireAdmin, requireCsrf, (_request, response, next) => {
    try {
      response.json({ device: deviceAuthService.revokeCurrentDevice() });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/device-auth/pair', deviceAuthLimiter, (request, response, next) => {
    try {
      response.status(201).json({ device: deviceAuthService.pairDevice(request.body) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/device-auth/challenge', deviceAuthLimiter, (_request, response, next) => {
    try {
      response.status(201).json(deviceAuthService.createChallenge());
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/device-auth/login', deviceAuthLimiter, async (request, response, next) => {
    try {
      const device = deviceAuthService.verifyChallenge(request.body);
      await regenerateSession(request, {
        adminAuthenticated: true,
        authMethod: 'device',
        deviceId: device.id,
      });
      response.json({ authenticated: true, device });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/admin/works', requireAdmin, requireCsrf, async (request, response, next) => {
    try {
      const item = await contentService.createWork(request.body);
      const publication = await publishService.publishAll();
      response.status(201).json({ ...item, publication });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/admin/notes', requireAdmin, requireCsrf, async (request, response, next) => {
    try {
      const item = await contentService.createNote(request.body);
      const publication = await publishService.publishAll();
      response.status(201).json({ ...item, publication });
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/admin/works/:id', requireAdmin, requireCsrf, async (request, response, next) => {
    try {
      const item = await contentService.updateWork(request.params.id, request.body);
      const publication = await publishService.publishAll();
      response.json({ ...item, publication });
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/admin/notes/:id', requireAdmin, requireCsrf, async (request, response, next) => {
    try {
      const item = await contentService.updateNote(request.params.id, request.body);
      const publication = await publishService.publishAll();
      response.json({ ...item, publication });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/admin/works/:id', requireAdmin, requireCsrf, async (request, response, next) => {
    try {
      const item = await contentService.deleteWork(request.params.id);
      const publication = await publishService.publishAll();
      response.json({ item, publication });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/admin/notes/:id', requireAdmin, requireCsrf, async (request, response, next) => {
    try {
      const item = await contentService.deleteNote(request.params.id);
      const publication = await publishService.publishAll();
      response.json({ item, publication });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/admin/publish', requireAdmin, requireCsrf, async (_request, response, next) => {
    try {
      response.json(await publishService.publishAll());
    } catch (error) {
      next(error);
    }
  });

  async function finishUpload(request, response, next, asJson) {
    try {
      if (!request.file) throw new UploadPolicyError('请选择一个文件。', 400);
      const stored = await validateAndFinalizeUpload(request.file, config);
      if (asJson) return response.status(201).json(stored);
      return response.redirect(`/admin?notice=${encodeURIComponent(`文件已保存：${stored.storedName}`)}`);
    } catch (error) {
      if (request.file?.path) fs.unlink(request.file.path, () => {});
      return next(error);
    }
  }

  app.post('/api/admin/uploads', requireAdmin, upload.single('file'), requireCsrf, (request, response, next) => {
    finishUpload(request, response, next, true);
  });

  app.use((request, response) => {
    if (request.path.startsWith('/api/')) return response.status(404).json({ error: '接口不存在。' });
    return response.status(404).send(errorPage({
      statusCode: 404,
      message: '页面不存在。',
      csrfToken: response.locals.csrfToken,
      authenticated: Boolean(request.session?.adminAuthenticated),
    }));
  });

  app.use((error, request, response, _next) => {
    let statusCode = error.statusCode || 500;
    let message = error.message || '服务器内部错误。';

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      statusCode = 413;
      message = `文件超过 ${config.uploadMaxBytes} 字节上限。`;
    } else if (error instanceof multer.MulterError) {
      statusCode = 400;
      message = '上传请求无效。';
    } else if (!(error instanceof UploadPolicyError)
      && !(error instanceof ContentValidationError)
      && !(error instanceof DeviceAuthError)
      && !(error instanceof FeedbackValidationError)
      && !(error instanceof LabValidationError)
      && !(error instanceof PublishError)) {
      console.error(error);
      message = '服务器内部错误。';
    }

    if (request.path.startsWith('/api/')) return response.status(statusCode).json({ error: message });
    return response.status(statusCode).send(errorPage({
      statusCode,
      message,
      csrfToken: response.locals.csrfToken,
      authenticated: Boolean(request.session?.adminAuthenticated),
    }));
  });

  app.locals.database = database;
  app.locals.config = config;
  app.locals.contentService = contentService;
  app.locals.publishService = publishService;
  app.locals.deviceAuthService = deviceAuthService;
  app.locals.feedbackService = feedbackService;
  app.locals.labService = labService;
  app.locals.sessionStore = sessionStore;
  return {
    app,
    config,
    database,
    contentService,
    publishService,
    deviceAuthService,
    feedbackService,
    labService,
    sessionStore,
  };
}

module.exports = { createApp };
