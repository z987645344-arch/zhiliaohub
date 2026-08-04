// Renders the practical server-side forms used by the local-only management interface.
const { escapeHtml, layout } = require('./lib/html');

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
  if (records.length === 0) return '<tr><td colspan="4">暂无内容。</td></tr>';
  const dateKey = type === 'work' ? 'work_date' : 'note_date';
  return records.map((record) => `<tr><td>${escapeHtml(record[dateKey])}</td><td>${escapeHtml(record.title)}</td><td>${escapeHtml(record.summary)}</td><td><a href="/admin/${type === 'work' ? 'works' : 'notes'}/${record.id}/edit">编辑</a></td></tr>`).join('');
}

function dashboardPage({ csrfToken, works, notes, notice = '' }) {
  return layout({
    title: '管理面板',
    authenticated: true,
    csrfToken,
    content: `${noticeBlock(notice)}<section class="panel"><h1>内容管理</h1><p>元数据保存在SQLite，正文保存在Markdown文件。当前前台页面尚未接入这些数据。</p></section><div class="grid"><section class="panel"><h2>作品</h2><a class="button" href="/admin/works/new">新增作品</a><table><thead><tr><th>日期</th><th>标题</th><th>摘要</th><th>操作</th></tr></thead><tbody>${rows(works, 'work')}</tbody></table></section><section class="panel"><h2>日记</h2><a class="button" href="/admin/notes/new">新增日记</a><table><thead><tr><th>日期</th><th>标题</th><th>摘要</th><th>操作</th></tr></thead><tbody>${rows(notes, 'note')}</tbody></table></section></div><section class="panel"><h2>文件上传</h2><p>仅允许白名单中的图片、PDF、Markdown、MP3/WAV/OGG、MP4/WebM文件；服务端同时检查扩展名、MIME和文件签名。</p><form method="post" action="/admin/uploads" enctype="multipart/form-data"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><label for="file">选择文件</label><input id="file" name="file" type="file" required><button type="submit">上传</button></form></section>`,
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
  const categoryField = isWork ? `<label for="category">分类</label><input id="category" name="category" value="${escapeHtml(record.category || '')}" required maxlength="100">` : '';

  return layout({
    title,
    authenticated: true,
    csrfToken,
    content: `<section class="panel"><h1>${title}</h1>${noticeBlock(error, 'notice error')}<form method="post" action="${action}"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><label for="title">标题</label><input id="title" name="title" value="${escapeHtml(record.title || '')}" required maxlength="200"><label for="date">日期</label><input id="date" name="${dateName}" type="date" value="${escapeHtml(dateValue || '')}" required>${categoryField}<label for="summary">摘要</label><textarea id="summary" name="summary" required maxlength="500">${escapeHtml(record.summary || '')}</textarea><label for="body">Markdown正文</label><textarea id="body" name="body" required>${escapeHtml(record.body || '')}</textarea><button type="submit">保存</button></form></section>`,
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
  contentFormPage,
  errorPage,
};
