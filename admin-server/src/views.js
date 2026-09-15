// Renders the practical server-side forms used by the local-only management interface.
const { escapeHtml, formatDateTime, layout } = require('./lib/html');
const { safeParseGallery } = require('./services/content-service');

function noticeBlock(message, type = 'notice') {
  return message ? `<p class="${type}">${escapeHtml(message)}</p>` : '';
}

function loginPage({ csrfToken, error = '' }) {
  return layout({
    title: '登录',
    content: `<section class="panel narrow"><p class="admin-kicker">01 / 回到编辑室</p><h1>管理员登录</h1><p>继续整理你的作品与心得。先输入管理员密码，下一步用手机验证器确认身份。这里仅供站长使用，不开放注册。</p>${noticeBlock(error, 'notice error')}<form method="post" action="/admin/login"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="512"><button type="submit">继续</button></form></section>`,
  });
}

function totpSetupPage({ csrfToken, qrDataUrl, secret, error = '' }) {
  return layout({
    title: '绑定TOTP',
    content: `<section class="panel narrow"><p class="admin-kicker">02 / 保护你的账号</p><h1>绑定手机验证器</h1><p>用手机验证器扫描下方二维码，再填写它生成的 6 位动态码。绑定只需做一次；密钥仅在这次设置中显示，请妥善保管。</p>${noticeBlock(error, 'notice error')}<img class="qr" src="${escapeHtml(qrDataUrl)}" alt="用于绑定知了hub管理后台TOTP的二维码"><p>无法扫码？在验证器中手动输入此密钥：<code data-totp-secret>${escapeHtml(secret)}</code></p><form method="post" action="/admin/totp/setup"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><label for="token">6位动态验证码</label><input id="token" name="token" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required><button type="submit">确认绑定并登录</button></form></section>`,
  });
}

function totpVerifyPage({ csrfToken, error = '' }) {
  return layout({
    title: 'TOTP验证',
    content: `<section class="panel narrow"><p class="admin-kicker">02 / 确认是你</p><h1>动态验证码</h1><p>密码已通过。打开手机验证器，输入知了hub 当前的 6 位动态码；若即将到期，可以等下一组。</p>${noticeBlock(error, 'notice error')}<form method="post" action="/admin/totp/verify"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><label for="token">6位动态验证码</label><input id="token" name="token" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required autofocus><button type="submit">登录</button></form></section>`,
  });
}

function rows(records, type) {
  if (records.length === 0) return '<tr><td colspan="5">这里还没有内容。用上方的新增按钮，留下第一条记录。</td></tr>';
  const dateKey = type === 'work' ? 'work_date' : 'note_date';
  return records.map((record) => {
    const detail = type === 'work' ? record.category : record.summary;
    return `<tr><td>${escapeHtml(record[dateKey])}</td><td>${escapeHtml(record.title)}</td><td>${escapeHtml(detail)}</td><td>已发布</td><td><a href="/admin/${type === 'work' ? 'works' : 'notes'}/${record.id}/edit">编辑</a></td></tr>`;
  }).join('');
}

function dashboardPage({
  csrfToken,
  works,
  notes,
  publishStatus,
  backupStatus,
  pendingFeedbackCount = 0,
  notice = '',
}) {
  const publication = publishStatus
    ? `<p class="notice"><strong>已发布</strong> · 最近发布时间：${escapeHtml(formatDateTime(publishStatus.last_published_at))} · ${publishStatus.works_count} 个作品 / ${publishStatus.notes_count} 篇日记</p>`
    : '<p class="notice warning"><strong>尚未发布</strong> · 还没有生成公开页面。保存第一条内容，或点击“更新公开页面”生成当前内容的页面。</p>';
  const backupCard = (project, title, status = {}) => {
    const state = status.status || 'unknown';
    const danger = ['stale', 'unknown', 'unreachable'].includes(state)
      ? ' backup-status-danger'
      : '';
    const fallbackLabel = {
      ok: '正常',
      stale: '已超期',
      disabled: '已停用',
      unknown: '未知',
      unreachable: '不可达',
    }[state] || '未知';
    return `<section class="panel backup-status backup-status-${escapeHtml(state)}${danger}" data-backup-project="${escapeHtml(project)}" data-backup-status="${escapeHtml(state)}"><div><p class="backup-status-kicker">${escapeHtml(title)} · 调度备份</p><h2>${escapeHtml(status.label || fallbackLabel)}</h2><p>${escapeHtml(status.hint || '当前无法判断备份状态。')}</p></div></section>`;
  };
  const backup = `<div class="backup-status-grid">${backupCard('zhiliaohub', '知了hub', backupStatus?.zhiliaohub)}${backupCard('zhitian', '知天', backupStatus?.zhitian)}</div>`;
  return layout({
    title: '管理面板',
    authenticated: true,
    csrfToken,
    content: `${noticeBlock(notice)}<section class="panel dashboard-intro"><p class="admin-kicker">01 / 编辑室</p><h1>内容管理</h1><p>继续写一篇心得，或整理一件作品。保存会立即更新公开页面，没有单独的草稿步骤。</p>${publication}<form method="post" action="/admin/publish"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button type="submit" class="button-secondary">更新公开页面</button></form><p class="dashboard-actions"><a class="button button-secondary" href="/admin/categories">管理作品分组</a> <a class="button button-secondary" href="/admin/feedback">审核反馈${pendingFeedbackCount ? `（${pendingFeedbackCount} 条待审核）` : ''}</a> <a class="button button-secondary" href="/admin/lab">管理小作坊</a> <a class="button button-secondary" href="/admin/device">管理手机登录</a></p></section><div class="grid"><section class="panel"><p class="admin-kicker">作品 / WORKS</p><h2>作品</h2><a class="button" href="/admin/works/new">新增作品</a><table><thead><tr><th>日期</th><th>标题</th><th>分类</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows(works, 'work')}</tbody></table></section><section class="panel"><h2>日记</h2><a class="button button-secondary" href="/admin/notes/new">新增日记</a><table><thead><tr><th>日期</th><th>标题</th><th>摘要</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows(notes, 'note')}</tbody></table></section></div><p class="admin-kicker">存放与备份 / 打开此页时检查</p>${backup}`,
  });
}

const feedbackStatus = Object.freeze({
  pending: { label: '待审核', className: 'pending' },
  approved: { label: '已通过', className: 'approved' },
  rejected: { label: '已隐藏', className: 'rejected' },
});

function feedbackMessage(comment, csrfToken, { reply = false, filter = 'pending' } = {}) {
  const status = feedbackStatus[comment.status] || feedbackStatus.pending;
  const actions = [];
  if (comment.status === 'pending') {
    actions.push(`<form method="post" action="/admin/feedback/${comment.id}/approve"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="filter" value="${escapeHtml(filter)}"><button type="submit">通过</button></form>`);
    actions.push(`<form method="post" action="/admin/feedback/${comment.id}/reject"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="filter" value="${escapeHtml(filter)}"><button type="submit" class="button-danger">拒绝</button></form>`);
  } else if (comment.status === 'approved') {
    actions.push(`<form method="post" action="/admin/feedback/${comment.id}/reject"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="filter" value="${escapeHtml(filter)}"><button type="submit" class="button-danger">隐藏</button></form>`);
  }
  const replyForm = !reply && comment.status === 'approved'
    ? `<form class="admin-reply-form" method="post" action="/admin/feedback/${comment.id}/reply"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="filter" value="${escapeHtml(filter)}"><label for="reply-${comment.id}">站长回复</label><textarea id="reply-${comment.id}" name="body" required minlength="2" maxlength="2000"></textarea><button type="submit">保存回复</button></form>`
    : '';
  const secondary = [comment.author_email ? `邮箱：${escapeHtml(comment.author_email)}` : '', `IP：${escapeHtml(comment.ip_address)}`]
    .filter(Boolean).join(' · ');
  return `<article class="feedback-message${reply ? ' feedback-reply' : ''} is-${status.className}" data-comment-id="${comment.id}"><div class="feedback-message-head"><strong>${escapeHtml(comment.author_name)}</strong><span class="status-badge status-${status.className}">${status.label}</span>${comment.is_admin_reply ? '<span class="status-badge admin-badge">管理员回复</span>' : ''}<time datetime="${escapeHtml(comment.created_at)}">${escapeHtml(formatDateTime(comment.created_at))}</time></div><p class="feedback-body">${escapeHtml(comment.body)}</p><details class="feedback-source"><summary>联系与来源信息</summary><p>${secondary}</p></details>${actions.length ? `<div class="feedback-actions">${actions.join('')}</div>` : ''}${replyForm}</article>`;
}

function feedbackManagementPage({
  csrfToken,
  topics,
  filter = 'pending',
  pendingCount = 0,
  totalTopics = 0,
  notice = '',
}) {
  const topicMarkup = topics.length
    ? topics.map((topic) => `<section class="panel feedback-topic"><header><strong>主题 #${topic.id}</strong><span>${topic.replies.length} 条回复</span></header>${feedbackMessage(topic, csrfToken, { filter })}${topic.replies.map((reply) => feedbackMessage(reply, csrfToken, { reply: true, filter })).join('')}</section>`).join('')
    : `<section class="panel"><p class="empty-state">${filter === 'pending' ? '待审核的留言已处理完。新的留言提交后会出现在这里，也可以切换到全部主题回看。' : '这里会收集访客的留言和你的回复，目前还没有人留言。'}</p></section>`;
  return layout({
    title: '反馈审核',
    authenticated: true,
    csrfToken,
    content: `${noticeBlock(notice)}<section class="panel"><div class="feedback-toolbar"><div><p class="admin-kicker">02 / 与访客对话</p><h1>反馈审核</h1><p>先看留言，再决定是否公开。审核和回复保存后，请到管理面板点击“更新公开页面”，访客才会看到变化。</p></div><div class="feedback-filters"><a class="button button-secondary${filter === 'pending' ? ' is-active' : ''}" href="/admin/feedback?filter=pending">待审核主题（${pendingCount} 条内容）</a><a class="button button-secondary${filter === 'all' ? ' is-active' : ''}" href="/admin/feedback?filter=all">全部主题（${totalTopics}）</a></div></div></section>${topicMarkup}`,
  });
}

function labManagementPage({ csrfToken, projects = [], notice = '' }) {
  const projectsMarkup = projects.length
    ? `<div class="lab-list">${projects.map((project) => {
      const linkId = `lab-link-${project.id}`;
      const visibilityLabel = project.isVisible ? '已展示在作品页' : '仅通过链接访问';
      return `<section class="panel lab-project"><div class="lab-project-head"><div><h2>${escapeHtml(project.title)}</h2><p class="lab-project-meta">${escapeHtml(project.original_filename)} · ${visibilityLabel} · 更新于 ${escapeHtml(formatDateTime(project.updated_at))}</p></div><span class="status-badge ${project.isVisible ? 'status-approved' : 'status-rejected'}">${project.isVisible ? '展示中' : '已隐藏'}</span></div><p>${escapeHtml(project.description)}</p><div class="lab-link-row"><div><label for="${linkId}">访问链接</label><input id="${linkId}" value="${escapeHtml(project.accessUrl)}" readonly></div><button type="button" class="button-secondary" data-copy-lab-link="${linkId}">复制链接</button><a class="button button-secondary" href="${escapeHtml(project.accessUrl)}" target="_blank" rel="noopener noreferrer">打开</a></div><div class="lab-actions"><form method="post" action="/admin/lab/${project.id}/visibility"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button type="submit" class="button-secondary">${project.isVisible ? '从作品页隐藏' : '展示在作品页'}</button></form><form method="post" action="/admin/lab/${project.id}/delete"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button type="submit" class="button-danger">删除项目</button></form></div></section>`;
    }).join('')}</div>`
    : '<section class="panel"><p class="empty-state">还没有小作坊项目。把一个完整的小网页打成 ZIP 上传，就能获得单独的访问链接。</p></section>';
  return layout({
    title: '小作坊管理',
    authenticated: true,
    csrfToken,
    content: `${noticeBlock(notice)}<section class="panel"><p class="admin-kicker">03 / 网页实验</p><h1>小作坊管理</h1><p>进入网页文件夹，选中全部内容压缩；不要压缩文件夹本身。</p><form method="post" action="/admin/lab/upload" enctype="multipart/form-data" data-lab-upload-form data-upload-api="/api/admin/lab/upload" data-csrf-token="${escapeHtml(csrfToken)}"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><label for="labTitle">标题</label><input id="labTitle" name="title" required maxlength="120"><label for="labDescription">简介</label><textarea class="short-textarea" id="labDescription" name="description" required maxlength="1000"></textarea><label for="labFile">ZIP包</label><input id="labFile" name="file" type="file" accept=".zip,application/zip,application/x-zip-compressed" required><label class="choice checkbox-choice"><input type="checkbox" name="isVisible" value="1"> 上传后展示在作品页底部</label><button type="submit" data-lab-upload-button>上传并生成链接</button><p class="upload-status" data-lab-upload-status role="status" aria-live="polite"></p></form></section>${projectsMarkup}<script src="/admin/lab.js" defer></script>`,
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

function currentUtc8DateTimeLocal(now = new Date()) {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

function updateSummary(body) {
  const plain = String(body || '')
    .replace(/[#>*_`~\[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > 180 ? `${plain.slice(0, 180)}…` : plain;
}

function workFormPage({ csrfToken, categories = [], record = {}, error = '', notice = '' }) {
  const isEdit = Boolean(record.id);
  const title = `${isEdit ? '编辑' : '新增'}作品`;
  const action = isEdit ? `/admin/works/${record.id}` : '/admin/works';
  const category = record.category || '';
  const categoryOptions = categories.length
    ? categories.map((item) => `<option value="${escapeHtml(item.name)}"${category === item.name ? ' selected' : ''}>${escapeHtml(item.name)}${item.is_visible ? '' : '（前台隐藏）'}</option>`).join('')
    : '<option value="">请先创建分组</option>';
  const categoryNotice = categories.length
    ? ''
    : '<p class="notice warning">当前没有作品分组，请先到“作品分组管理”创建分组后再新增作品。</p>';
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
  const updates = Array.isArray(record.updates) ? record.updates : [];
  const renderUpdateItem = (update) => `<article class="work-update-admin"><div><time datetime="${escapeHtml(update.recorded_at)}">${escapeHtml(formatDateTime(update.recorded_at))}</time><p>${escapeHtml(updateSummary(update.body))}</p></div><form method="post" action="/admin/works/${record.id}/updates/${update.id}/delete" data-work-update-action data-delete-work-update><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button type="submit" class="button-danger compact-button">删除这条记录</button><p class="upload-status" data-work-update-status role="status" aria-live="polite"></p></form></article>`;
  const visibleUpdates = updates.slice(0, 5);
  const hiddenUpdates = updates.slice(5);
  const hiddenUpdatesMarkup = hiddenUpdates.length
    ? `<details class="work-update-more"><summary>展开更新详情（还有 ${hiddenUpdates.length} 条）</summary>${hiddenUpdates.map(renderUpdateItem).join('')}</details>`
    : '';
  const updateItems = updates.length
    ? `${visibleUpdates.map(renderUpdateItem).join('')}${hiddenUpdatesMarkup}`
    : '<p class="empty-state">还没有更新记录。保存作品后，可以从这里逐条补充进展。</p>';
  const updatesSection = isEdit
    ? `<section class="form-section work-updates-admin" id="work-updates" aria-labelledby="work-updates-title"><h2 id="work-updates-title"><span class="section-number">04</span>更新记录</h2><p class="hint">记录会按时间倒序展示给访客。历史记录可删除；需要修改时，请删除后重新添加。</p><form method="post" action="/admin/works/${record.id}/updates" data-work-update-action><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><div class="form-grid"><div><label for="updateRecordedAt">记录时间</label><input id="updateRecordedAt" name="recordedAt" type="datetime-local" value="${currentUtc8DateTimeLocal()}" required></div></div><label for="updateBody">记录正文</label><textarea id="updateBody" name="body" required></textarea><button type="submit">添加记录并发布</button><p class="upload-status" data-work-update-status role="status" aria-live="polite"></p></form><div class="work-update-list">${updateItems}</div></section>`
    : '<section class="form-section work-updates-admin" id="work-updates"><h2><span class="section-number">04</span>更新记录</h2><p class="empty-state">先保存作品，再回来逐条添加带时间的更新记录。</p></section>';
  const deleteForm = isEdit
    ? `<form class="danger-zone" method="post" action="/admin/works/${record.id}/delete"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><p class="notice warning">删除会同时移除这件作品、正文、详情页和公开媒体，无法在此撤销。请先确认已保留需要的内容。</p><button type="submit" class="button-danger">删除作品</button></form>`
    : '';

  return layout({
    title,
    authenticated: true,
    csrfToken,
    content: `<section class="panel work-form-panel"><p class="admin-kicker">作品 / 编辑档案</p><h1>${title}</h1><p>先写清作品是什么，再补上图片与访问方式。保存后访客就能看到本次内容；上传图片本身不会发布作品。</p>${noticeBlock(notice)}${noticeBlock(error, 'notice error')}${categoryNotice}<nav class="form-index" aria-label="作品编辑分区"><a href="#work-basics">01 介绍</a><a href="#work-cover">02 媒体</a><a href="#work-access">03 访问与下载</a><a href="#work-updates">04 更新记录</a></nav>
      <form method="post" action="${action}" data-work-form data-upload-api="/api/admin/uploads" data-csrf-token="${escapeHtml(csrfToken)}">
        <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
        <fieldset class="form-section" id="work-basics"><legend><span class="section-number">01</span>介绍这件作品</legend><p class="hint">标题与简介会展示给访客，用几句话说明它解决什么问题。</p>
          <div class="form-grid"><div><label for="title">标题</label><input id="title" name="title" value="${escapeHtml(record.title || '')}" required maxlength="200"></div><div><label for="workDate">日期</label><input id="workDate" name="workDate" type="date" value="${escapeHtml(record.work_date || '')}" required></div></div>
          <label for="category">分类</label><select id="category" name="category" required${categories.length ? '' : ' disabled'}>${categoryOptions}</select>${categories.length ? '' : '<a class="button button-secondary" href="/admin/categories">先创建作品分组</a>'}
          <label for="detailIntro">简介</label><textarea class="short-textarea" id="detailIntro" name="detailIntro" required maxlength="500">${escapeHtml(record.detail_intro || record.summary || '')}</textarea>
        </fieldset>

        <div class="form-media-grid"><fieldset class="form-section" id="work-cover"><legend><span class="section-number">02A</span>列表封面</legend>
          <p class="hint">选择图片后，拖动选区内部调整位置，拖动四角按16:9缩放，再上传裁剪结果。</p>
          <label for="coverFile">选择封面图片</label><input id="coverFile" type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif">
          <div class="cropper" data-cropper hidden><canvas data-cover-canvas></canvas><button type="button" data-upload-crop>上传裁剪封面</button></div>
          <p class="upload-status" data-upload-local-status="cover" role="status" aria-live="polite"></p>
          <input type="hidden" name="coverImage" value="${escapeHtml(coverImage)}" data-cover-value>
          <div class="upload-preview" data-cover-preview>${mediaPreview(coverImage, 'image', '当前作品封面')}${coverImage ? '<button type="button" class="button-danger compact-button" data-clear-cover>移除</button>' : ''}</div>
        </fieldset>

        <fieldset class="form-section"><legend><span class="section-number">02B</span>打开后的展示</legend><p class="hint">主图或视频放在详情页最前，辅图供访客切换查看。</p>
          <div class="choice-row" role="group" aria-label="主媒体类型"><label class="choice"><input type="radio" name="mainMediaType" value="image"${mainType === 'image' ? ' checked' : ''}> 图片</label><label class="choice"><input type="radio" name="mainMediaType" value="video"${mainType === 'video' ? ' checked' : ''}> 视频</label></div>
          <label for="mainMediaFile">主图或主视频</label><input id="mainMediaFile" type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif,video/mp4,video/webm">
          <p class="upload-status" data-upload-local-status="main" role="status" aria-live="polite"></p>
          <input type="hidden" name="mainMediaPath" value="${escapeHtml(mainMediaPath)}" data-main-value>
          <div class="upload-preview" data-main-preview>${mediaPreview(mainMediaPath, mainType, '当前主媒体')}${mainMediaPath ? '<button type="button" class="button-danger compact-button" data-clear-main>移除</button>' : ''}</div>
          <label for="galleryFiles">辅图/辅视频（可多选）</label><input id="galleryFiles" type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,image/avif,video/mp4,video/webm">
          <p class="upload-status" data-upload-local-status="gallery" role="status" aria-live="polite"></p>
          <input type="hidden" name="gallery" value="${escapeHtml(JSON.stringify(gallery))}" data-gallery-value>
          <div class="gallery-grid" data-gallery-list>${galleryItems}</div>
        </fieldset></div>

        <fieldset class="form-section" id="work-access"><legend><span class="section-number">03</span>访问与下载</legend><p class="hint">只开放已经准备好的入口。勾选智能工具展示时，需要填写有效的体验链接。</p>
          <input type="hidden" name="isDownloadable" value="0"><label class="choice checkbox-choice"><input type="checkbox" name="isDownloadable" value="1"${record.is_downloadable ? ' checked' : ''}> 允许访客下载</label>
          <label for="downloadUpload">ZIP压缩包</label><input id="downloadUpload" type="file" accept=".zip,application/zip,application/x-zip-compressed">
          <p class="upload-status" data-upload-local-status="download" role="status" aria-live="polite"></p>
          <input type="hidden" name="downloadFile" value="${escapeHtml(downloadFile)}" data-download-value>
          <div class="upload-preview" data-download-preview>${downloadFile ? `<span class="upload-filename">${escapeHtml(assetFilename(downloadFile))}</span><button type="button" class="button-danger compact-button" data-clear-download>移除</button>` : ''}</div>
          <label for="experienceUrl">体验链接</label><input id="experienceUrl" name="experienceUrl" type="url" value="${escapeHtml(record.experience_url || '')}" maxlength="2000" placeholder="粘贴完整的体验链接">
          <input type="hidden" name="showOnTools" value="0"><label class="choice checkbox-choice"><input type="checkbox" name="showOnTools" value="1"${record.show_on_tools ? ' checked' : ''}> 在智能工具页显示这条作品</label>
        </fieldset>

        <p class="upload-status" data-upload-status role="status" aria-live="polite"></p>
        <div class="save-bar"><button type="submit" data-save-work${categories.length ? '' : ' disabled'}>保存并发布</button><p>保存后会立即更新公开页面。</p></div>
      </form>${updatesSection}${deleteForm}</section><script src="/admin/work-form.js" defer></script>`,
  });
}

function categoryFields(category = {}) {
  return `<div class="form-grid"><div><label for="category-name-${escapeHtml(category.id || 'new')}">分组名</label><input id="category-name-${escapeHtml(category.id || 'new')}" name="name" value="${escapeHtml(category.name || '')}" required maxlength="100"></div><div><label for="category-slug-${escapeHtml(category.id || 'new')}">链接里的短名称</label><input id="category-slug-${escapeHtml(category.id || 'new')}" name="slug" value="${escapeHtml(category.slug || '')}" required maxlength="100" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="software-tools"></div></div><label for="category-kicker-${escapeHtml(category.id || 'new')}">分类页副标题</label><input id="category-kicker-${escapeHtml(category.id || 'new')}" name="kicker" value="${escapeHtml(category.kicker || '')}" required maxlength="120" placeholder="PROGRAM / SOFTWARE"><label for="category-intro-${escapeHtml(category.id || 'new')}">分类页导语</label><textarea id="category-intro-${escapeHtml(category.id || 'new')}" name="intro" required maxlength="500">${escapeHtml(category.intro || '')}</textarea><label for="category-empty-${escapeHtml(category.id || 'new')}">分组还没有作品时，对访客说的话</label><textarea id="category-empty-${escapeHtml(category.id || 'new')}" name="emptyText" required maxlength="500">${escapeHtml(category.empty_text || '')}</textarea><div class="form-grid"><div><label for="category-order-${escapeHtml(category.id || 'new')}">排列顺序（小的在前）</label><input id="category-order-${escapeHtml(category.id || 'new')}" name="displayOrder" type="number" step="1" value="${escapeHtml(category.display_order ?? 0)}" required></div><div><input type="hidden" name="isVisible" value="0"><label class="choice checkbox-choice"><input type="checkbox" name="isVisible" value="1"${category.id && !category.is_visible ? '' : ' checked'}> 在作品页显示该分组</label></div></div>`;
}

function categoryManagementPage({ csrfToken, categories = [], notice = '' }) {
  const categoriesMarkup = categories.length
    ? categories.map((category) => `<section class="panel"><h2>${escapeHtml(category.name)}</h2><p><code>works-category-${escapeHtml(category.slug)}.html</code> · ${category.work_count} 条作品 · ${category.is_visible ? '前台显示' : '前台隐藏'}</p><form method="post" action="/admin/categories/${category.id}"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">${categoryFields(category)}<button type="submit">保存分组并发布</button></form><form class="danger-zone" method="post" action="/admin/categories/${category.id}/delete"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="expectedWorkCount" value="${category.work_count}"><p class="notice warning"><strong>删除分组将连带删除 ${category.work_count} 条作品</strong>，包括正文、详情页和公开媒体。此操作无法在这里撤销，请确认需要保留的内容已另存。</p><label class="choice checkbox-choice"><input type="checkbox" name="confirmDelete" value="1" required> 我确认连带删除 ${category.work_count} 条作品</label><button type="submit" class="button-danger">删除分组及其作品</button></form></section>`).join('')
    : '<section class="panel"><p class="empty-state">目前没有作品分组。创建第一个分组后，作品表单才可保存。</p></section>';
  return layout({
    title: '作品分组管理',
    authenticated: true,
    csrfToken,
    content: `${noticeBlock(notice)}<section class="panel"><p class="admin-kicker">作品 / 整理目录</p><h1>作品分组管理</h1><p>用分组把相关作品放在一起，每个分组都有自己的浏览入口。链接短名称请填小写字母、数字或连字符，发布后尽量保持不变。</p><form method="post" action="/admin/categories"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">${categoryFields()}<button type="submit">创建分组并发布</button></form></section>${categoriesMarkup}`,
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
    ? `<dl><dt>设备名称</dt><dd>${escapeHtml(device.deviceName)}</dd><dt>配对时间</dt><dd>${escapeHtml(formatDateTime(device.createdAt))}</dd><dt>最近使用</dt><dd>${escapeHtml(device.lastUsedAt ? formatDateTime(device.lastUsedAt) : '尚未通过设备登录')}</dd><dt>设备识别码（核对设备时使用）</dt><dd><code>${escapeHtml(device.publicKeyFingerprint)}</code></dd></dl><form class="danger-zone" method="post" action="/admin/device/revoke"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button type="submit" class="button-danger">取消这台设备的登录授权</button></form>`
    : '<p>还没有配对的手机。生成配对码并在安卓 App 中输入后，就能用手机登录管理后台。</p>';
  const pairingContent = pairingCode
    ? `<p class="notice warning">配对码只显示本次，请在 ${escapeHtml(formatDateTime(pairingExpiresAt))} 前手动输入安卓App；使用一次或到期后立即失效。</p><p><code class="pairing-code" data-pairing-code>${escapeHtml(pairingCode)}</code></p>`
    : '';
  const pairingForm = canGeneratePairingCode
    ? `<form method="post" action="/admin/device/pairing-code"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button type="submit" class="button-secondary">生成5分钟配对码</button></form>`
    : '<p class="notice warning">为保护账号，配对新手机前需要用密码和手机动态码登录。当前若通过设备登录，请先退出，再用密码登录后回来。</p>';

  return layout({
    title: '设备管理',
    authenticated: true,
    csrfToken,
    content: `${noticeBlock(notice)}<section class="panel"><p class="admin-kicker">04 / 手机登录</p><h1>设备管理</h1><p>一次只授权一台手机。新手机配对成功后会替换旧手机，旧手机将不能再通过设备认证登录。</p>${deviceContent}</section><section class="panel"><h2>手动配对</h2><p>打开安卓 App 的配对界面，手动输入下面生成的配对码。配对码仅能用一次，5 分钟内有效。</p>${pairingContent}${pairingForm}</section>`,
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
  const deleteForm = isEdit ? `<form class="danger-zone" method="post" action="/admin/${plural}/${record.id}/delete"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><p class="notice warning">删除后正文和公开详情页都会移除，无法在这里撤销。请先另存需要保留的内容。</p><button type="submit" class="button-danger">删除${isWork ? '作品' : '日记'}</button></form>` : '';

  return layout({
    title,
    authenticated: true,
    csrfToken,
    content: `<section class="panel"><p class="admin-kicker">文字 / 编辑档案</p><h1>${title}</h1><p>记下这次的发现。摘要用于列表，正文用于阅读页；保存后即公开。</p>${noticeBlock(error, 'notice error')}<form method="post" action="${action}"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><label for="title">标题</label><input id="title" name="title" value="${escapeHtml(record.title || '')}" required maxlength="200"><label for="date">日期</label><input id="date" name="${dateName}" type="date" value="${escapeHtml(dateValue || '')}" required>${categoryField}<label for="summary">摘要</label><textarea class="short-textarea" id="summary" name="summary" required maxlength="500">${escapeHtml(record.summary || '')}</textarea><label for="body">Markdown正文</label><textarea id="body" name="body" required>${escapeHtml(record.body || '')}</textarea><button type="submit">保存并发布</button></form>${deleteForm}</section>`,
  });
}

function errorPage({ statusCode = 500, message, csrfToken = '', authenticated = false }) {
  return layout({
    title: `错误 ${statusCode}`,
    authenticated,
    csrfToken,
    content: `<section class="panel narrow"><p class="admin-kicker">请求 / ${statusCode}</p><h1>这一步没能完成</h1><p class="notice error">${escapeHtml(message)}</p><p><a href="${authenticated ? '/admin' : '/admin/login'}" class="button">返回${authenticated ? '管理面板' : '登录页'}</a></p></section>`,
  });
}

module.exports = {
  loginPage,
  totpSetupPage,
  totpVerifyPage,
  dashboardPage,
  feedbackManagementPage,
  labManagementPage,
  categoryManagementPage,
  deviceManagementPage,
  workFormPage,
  contentFormPage,
  errorPage,
};
