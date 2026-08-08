// Renders the practical server-side forms used by the local-only management interface.
const { escapeHtml, layout } = require('./lib/html');
const { safeParseGallery } = require('./services/content-service');

function noticeBlock(message, type = 'notice') {
  return message ? `<p class="${type}">${escapeHtml(message)}</p>` : '';
}

function loginPage({ csrfToken, error = '' }) {
  return layout({
    title: '登录',
    content: `<section class="panel narrow"><h1>管理员登录</h1><p>本站只有一个管理员账号，没有注册入口。密码通过后还需要TOTP动态验证码。</p>${noticeBlock(error, 'notice error')}<form method="post" action="/admin/login"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="512"><button type="submit">继续</button></form></section>`,
  });
}

function totpSetupPage({ csrfToken, qrDataUrl, secret, error = '' }) {
  return layout({
    title: '绑定TOTP',
    content: `<section class="panel narrow"><h1>首次绑定TOTP</h1><p>使用手机验证器App扫描二维码，然后输入当前6位验证码完成一次性绑定。密钥只在本次绑定流程中展示。</p>${noticeBlock(error, 'notice error')}<img class="qr" src="${escapeHtml(qrDataUrl)}" alt="用于绑定知了hub管理后台TOTP的二维码"><p>无法扫码时手动输入：<code data-totp-secret>${escapeHtml(secret)}</code></p><form method="post" action="/admin/totp/setup"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><label for="token">6位动态验证码</label><input id="token" name="token" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required><button type="submit">确认绑定并登录</button></form></section>`,
  });
}

function totpVerifyPage({ csrfToken, error = '' }) {
  return layout({
    title: 'TOTP验证',
    content: `<section class="panel narrow"><h1>动态验证码</h1><p>密码已通过，请输入验证器App中的当前6位验证码。</p>${noticeBlock(error, 'notice error')}<form method="post" action="/admin/totp/verify"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><label for="token">6位动态验证码</label><input id="token" name="token" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required autofocus><button type="submit">登录</button></form></section>`,
  });
}

function rows(records, type) {
  if (records.length === 0) return '<tr><td colspan="5">暂无内容。</td></tr>';
  const dateKey = type === 'work' ? 'work_date' : 'note_date';
  return records.map((record) => {
    const detail = type === 'work' ? record.category : record.summary;
    return `<tr><td>${escapeHtml(record[dateKey])}</td><td>${escapeHtml(record.title)}</td><td>${escapeHtml(detail)}</td><td>已发布</td><td><a href="/admin/${type === 'work' ? 'works' : 'notes'}/${record.id}/edit">编辑</a></td></tr>`;
  }).join('');
}

function dashboardPage({ csrfToken, works, notes, publishStatus, notice = '' }) {
  const publication = publishStatus
    ? `<p class="notice"><strong>已发布</strong> · 最近发布时间：${escapeHtml(publishStatus.last_published_at)} · ${publishStatus.works_count} 个作品 / ${publishStatus.notes_count} 篇日记</p>`
    : '<p class="notice warning"><strong>尚未发布</strong> · 保存第一条内容或手动执行全量发布后，静态前台才会由数据库生成。</p>';
  return layout({
    title: '管理面板',
    authenticated: true,
    csrfToken,
    content: `${noticeBlock(notice)}<section class="panel"><h1>内容管理</h1><p>元数据保存在SQLite，正文保存在Markdown文件；保存后立即全量生成静态前台页面。</p>${publication}<form method="post" action="/admin/publish"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button type="submit">重新全量发布</button></form><p><a class="button button-secondary" href="/admin/device">管理安卓App配对设备</a></p></section><div class="grid"><section class="panel"><h2>作品</h2><a class="button button-secondary" href="/admin/works/new">新增作品</a><table><thead><tr><th>日期</th><th>标题</th><th>分类</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows(works, 'work')}</tbody></table></section><section class="panel"><h2>日记</h2><a class="button button-secondary" href="/admin/notes/new">新增日记</a><table><thead><tr><th>日期</th><th>标题</th><th>摘要</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows(notes, 'note')}</tbody></table></section></div><section class="panel"><h2>文件上传</h2><p>仅允许白名单中的图片、PDF、Markdown、MP3/WAV/OGG、MP4/WebM和ZIP文件；服务端同时检查扩展名、MIME和文件签名。</p><form method="post" action="/admin/uploads" enctype="multipart/form-data"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><label for="file">选择文件</label><input id="file" name="file" type="file" required><button type="submit">上传</button></form></section>`,
  });
}

function assetFilename(value) {
  return String(value || '').split('/').at(-1) || '';
}

function uploadPreviewUrl(value) {
  const filename = assetFilename(value);
  return filename ? `/uploads/${encodeURIComponent(filename)}` : '';
}

function mediaPreview(value, type, label) {
  if (!value) return '';
  const source = escapeHtml(uploadPreviewUrl(value));
  const filename = escapeHtml(assetFilename(value));
  const media = type === 'video'
    ? `<video src="${source}" controls preload="metadata" aria-label="${escapeHtml(label)}"></video>`
    : `<img src="${source}" alt="${escapeHtml(label)}">`;
  return `${media}<span class="upload-filename">${filename}</span>`;
}

function workFormPage({ csrfToken, record = {}, error = '' }) {
  const isEdit = Boolean(record.id);
  const title = `${isEdit ? '编辑' : '新增'}作品`;
  const action = isEdit ? `/admin/works/${record.id}` : '/admin/works';
  const category = record.category || '程序';
  const mainType = record.main_media_type || 'image';
  const coverImage = record.cover_image || '';
  const mainMediaPath = record.main_media_path || '';
  const downloadFile = record.download_file || '';
  const gallery = safeParseGallery(record.gallery);
  const galleryItems = gallery.map((item) => {
    const filename = assetFilename(item);
    const isVideo = /\.(?:mp4|webm)$/i.test(filename);
    const preview = isVideo
      ? `<video src="${escapeHtml(uploadPreviewUrl(item))}" muted preload="metadata" aria-label="辅图视频 ${escapeHtml(filename)}"></video>`
      : `<img src="${escapeHtml(uploadPreviewUrl(item))}" alt="辅图 ${escapeHtml(filename)}">`;
    return `<div class="gallery-item" data-gallery-item data-gallery-path="${escapeHtml(item)}">${preview}<span>${escapeHtml(filename)}</span><button type="button" class="button-danger compact-button" data-remove-gallery>移除</button></div>`;
  }).join('');
  const deleteForm = isEdit
    ? `<form method="post" action="/admin/works/${record.id}/delete"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><p class="notice warning">删除后会同时清理Markdown正文、自动生成详情页和前台已发布媒体文件。</p><button type="submit" class="button-danger">删除作品</button></form>`
    : '';

  return layout({
    title,
    authenticated: true,
    csrfToken,
    content: `<section class="panel work-form-panel"><h1>${title}</h1><p>保存后立即发布。媒体本阶段会复制到静态前台目录，下一阶段才接入前台展示模板。</p>${noticeBlock(error, 'notice error')}
      <form method="post" action="${action}" data-work-form data-upload-api="/api/admin/uploads" data-csrf-token="${escapeHtml(csrfToken)}">
        <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
        <fieldset class="form-section"><legend>基础信息</legend>
          <div class="form-grid"><div><label for="title">标题</label><input id="title" name="title" value="${escapeHtml(record.title || '')}" required maxlength="200"></div><div><label for="workDate">日期</label><input id="workDate" name="workDate" type="date" value="${escapeHtml(record.work_date || '')}" required></div></div>
          <label for="category">分类</label><select id="category" name="category" required><option value="程序"${category === '程序' ? ' selected' : ''}>程序</option><option value="影视"${category === '影视' ? ' selected' : ''}>影视</option><option value="生活"${category === '生活' ? ' selected' : ''}>生活</option></select>
          <label for="detailIntro">简介</label><textarea class="short-textarea" id="detailIntro" name="detailIntro" required maxlength="500">${escapeHtml(record.detail_intro || record.summary || '')}</textarea>
        </fieldset>

        <fieldset class="form-section"><legend>封面</legend>
          <p class="hint">选择图片后，拖动选区内部调整位置，拖动四角按16:9缩放，再上传裁剪结果。</p>
          <input id="coverFile" type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif">
          <div class="cropper" data-cropper hidden><canvas data-cover-canvas></canvas><button type="button" data-upload-crop>上传裁剪封面</button></div>
          <input type="hidden" name="coverImage" value="${escapeHtml(coverImage)}" data-cover-value>
          <div class="upload-preview" data-cover-preview>${mediaPreview(coverImage, 'image', '当前作品封面')}${coverImage ? '<button type="button" class="button-danger compact-button" data-clear-cover>移除</button>' : ''}</div>
        </fieldset>

        <fieldset class="form-section"><legend>展示媒体</legend>
          <div class="choice-row" role="group" aria-label="主媒体类型"><label class="choice"><input type="radio" name="mainMediaType" value="image"${mainType === 'image' ? ' checked' : ''}> 图片</label><label class="choice"><input type="radio" name="mainMediaType" value="video"${mainType === 'video' ? ' checked' : ''}> 视频</label></div>
          <label for="mainMediaFile">主图或主视频</label><input id="mainMediaFile" type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif,video/mp4,video/webm">
          <input type="hidden" name="mainMediaPath" value="${escapeHtml(mainMediaPath)}" data-main-value>
          <div class="upload-preview" data-main-preview>${mediaPreview(mainMediaPath, mainType, '当前主媒体')}${mainMediaPath ? '<button type="button" class="button-danger compact-button" data-clear-main>移除</button>' : ''}</div>
          <label for="galleryFiles">辅图/辅视频（可多选）</label><input id="galleryFiles" type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,image/avif,video/mp4,video/webm">
          <input type="hidden" name="gallery" value="${escapeHtml(JSON.stringify(gallery))}" data-gallery-value>
          <div class="gallery-grid" data-gallery-list>${galleryItems}</div>
        </fieldset>

        <fieldset class="form-section"><legend>下载设置</legend>
          <input type="hidden" name="isDownloadable" value="0"><label class="choice checkbox-choice"><input type="checkbox" name="isDownloadable" value="1"${record.is_downloadable ? ' checked' : ''}> 允许访客下载</label>
          <label for="downloadUpload">ZIP压缩包</label><input id="downloadUpload" type="file" accept=".zip,application/zip,application/x-zip-compressed">
          <input type="hidden" name="downloadFile" value="${escapeHtml(downloadFile)}" data-download-value>
          <div class="upload-preview" data-download-preview>${downloadFile ? `<span class="upload-filename">${escapeHtml(assetFilename(downloadFile))}</span><button type="button" class="button-danger compact-button" data-clear-download>移除</button>` : ''}</div>
          <label for="experienceUrl">体验链接</label><input id="experienceUrl" name="experienceUrl" type="url" value="${escapeHtml(record.experience_url || '')}" maxlength="2000" placeholder="https://example.com">
        </fieldset>

        <fieldset class="form-section"><legend>版本日志</legend><label for="versionLog">Markdown内容</label><textarea id="versionLog" name="versionLog" required>${escapeHtml(record.versionLog || record.version_log || record.body || '')}</textarea></fieldset>
        <p class="upload-status" data-upload-status role="status" aria-live="polite"></p>
        <button type="submit" data-save-work>保存并发布</button>
      </form>${deleteForm}</section><script src="/admin/work-form.js" defer></script>`,
  });
}

function deviceManagementPage({
  csrfToken,
  device,
  pairingCode = '',
  pairingExpiresAt = '',
  notice = '',
  canGeneratePairingCode = false,
}) {
  const deviceContent = device
    ? `<dl><dt>设备名称</dt><dd>${escapeHtml(device.deviceName)}</dd><dt>配对时间</dt><dd>${escapeHtml(device.createdAt)}</dd><dt>最近使用</dt><dd>${escapeHtml(device.lastUsedAt || '尚未通过设备登录')}</dd><dt>公钥指纹（SHA-256）</dt><dd><code>${escapeHtml(device.publicKeyFingerprint)}</code></dd></dl><form method="post" action="/admin/device/revoke"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button type="submit" class="button-danger">吊销当前设备</button></form>`
    : '<p>当前没有已授权设备。</p>';
  const pairingContent = pairingCode
    ? `<p class="notice warning">配对码只显示本次，请在 ${escapeHtml(pairingExpiresAt)} 前手动输入安卓App；使用一次或到期后立即失效。</p><p><code class="pairing-code" data-pairing-code>${escapeHtml(pairingCode)}</code></p>`
    : '';
  const pairingForm = canGeneratePairingCode
    ? `<form method="post" action="/admin/device/pairing-code"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button type="submit" class="button-secondary">生成5分钟配对码</button></form>`
    : '<p class="notice warning">只有本次会话通过密码+TOTP登录后才能生成配对码；设备登录会话不能生成新的配对授权。</p>';

  return layout({
    title: '设备管理',
    authenticated: true,
    csrfToken,
    content: `${noticeBlock(notice)}<section class="panel"><h1>设备管理</h1><p>当前只允许一个有效设备。新设备使用有效配对码成功配对时，会自动吊销并替换旧设备。</p>${deviceContent}</section><section class="panel"><h2>手动配对</h2><p>本轮不提供二维码；配对码需手动输入独立安卓App。</p>${pairingContent}${pairingForm}</section>`,
  });
}

function contentFormPage({ csrfToken, type, record = {}, error = '' }) {
  const isWork = type === 'work';
  const isEdit = Boolean(record.id);
  const plural = isWork ? 'works' : 'notes';
  const dateName = isWork ? 'workDate' : 'noteDate';
  const dateValue = isWork ? record.work_date : record.note_date;
  const title = `${isEdit ? '编辑' : '新增'}${isWork ? '作品' : '日记'}`;
  const action = isEdit ? `/admin/${plural}/${record.id}` : `/admin/${plural}`;
  const categoryField = isWork ? `<label for="category">分类</label><input id="category" name="category" value="${escapeHtml(record.category || '')}" required maxlength="100"><label for="detailIntro">详情页简介</label><textarea id="detailIntro" name="detailIntro" maxlength="500">${escapeHtml(record.detail_intro || record.summary || '')}</textarea>` : '';
  const deleteForm = isEdit ? `<form method="post" action="/admin/${plural}/${record.id}/delete"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><p class="notice warning">删除后会同时清理对应的Markdown正文和自动生成详情页。</p><button type="submit" class="button-danger">删除${isWork ? '作品' : '日记'}</button></form>` : '';

  return layout({
    title,
    authenticated: true,
    csrfToken,
    content: `<section class="panel"><h1>${title}</h1>${noticeBlock(error, 'notice error')}<form method="post" action="${action}"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><label for="title">标题</label><input id="title" name="title" value="${escapeHtml(record.title || '')}" required maxlength="200"><label for="date">日期</label><input id="date" name="${dateName}" type="date" value="${escapeHtml(dateValue || '')}" required>${categoryField}<label for="summary">摘要</label><textarea id="summary" name="summary" required maxlength="500">${escapeHtml(record.summary || '')}</textarea><label for="body">Markdown正文</label><textarea id="body" name="body" required>${escapeHtml(record.body || '')}</textarea><button type="submit">保存并发布</button></form>${deleteForm}</section>`,
  });
}

function errorPage({ statusCode = 500, message, csrfToken = '', authenticated = false }) {
  return layout({
    title: `错误 ${statusCode}`,
    authenticated,
    csrfToken,
    content: `<section class="panel narrow"><h1>请求未完成</h1><p class="notice error">${escapeHtml(message)}</p><p><a href="${authenticated ? '/admin' : '/admin/login'}">返回</a></p></section>`,
  });
}

module.exports = {
  loginPage,
  totpSetupPage,
  totpVerifyPage,
  dashboardPage,
  deviceManagementPage,
  workFormPage,
  contentFormPage,
  errorPage,
};
