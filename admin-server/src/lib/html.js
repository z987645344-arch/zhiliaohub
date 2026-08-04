// Provides minimal escaping and page framing for the server-rendered admin UI.
function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function layout({ title, content, authenticated = false, csrfToken = '' }) {
  const navigation = authenticated
    ? `<nav><a href="/admin">管理面板</a><a href="/admin/device">设备管理</a><form method="post" action="/admin/logout"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button type="submit" class="link-button">退出登录</button></form></nav>`
    : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}｜知了hub 管理后台</title>
  <style>
    :root { color-scheme: light; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #17202a; background: #f2f4f6; }
    header { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: 1rem max(1rem, calc((100% - 1100px) / 2)); background: #17202a; color: white; }
    header a { color: white; }
    nav { display: flex; gap: 1rem; align-items: center; }
    nav form { margin: 0; }
    main { width: min(1100px, calc(100% - 2rem)); margin: 2rem auto; }
    .panel { padding: 1.25rem; margin-bottom: 1.25rem; border: 1px solid #d7dce1; border-radius: .55rem; background: white; }
    .narrow { max-width: 520px; margin-inline: auto; }
    .notice { padding: .8rem 1rem; border-left: 4px solid #526b7a; background: #e9eff3; }
    .error { border-left-color: #9f2f2f; background: #f8eaea; color: #6d1f1f; }
    .warning { border-left-color: #9a681c; background: #fff5df; color: #63430f; }
    label { display: block; margin-top: 1rem; font-weight: 650; }
    input, textarea, select { width: 100%; padding: .7rem; margin-top: .35rem; border: 1px solid #aeb7bf; border-radius: .35rem; font: inherit; }
    textarea { min-height: 13rem; resize: vertical; }
    button, .button { display: inline-block; width: auto; padding: .65rem 1rem; margin-top: 1rem; border: 0; border-radius: .35rem; color: white; background: #2d5268; font: inherit; cursor: pointer; text-decoration: none; }
    .link-button { padding: 0; margin: 0; background: transparent; text-decoration: underline; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: .65rem; border-bottom: 1px solid #d7dce1; text-align: left; vertical-align: top; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.25rem; }
    code { overflow-wrap: anywhere; }
    .pairing-code { display: inline-block; padding: .55rem .75rem; font-size: 1.35rem; letter-spacing: .12em; background: #edf2f5; }
    img.qr { display: block; width: min(260px, 100%); height: auto; margin: 1rem 0; border: 1px solid #d7dce1; }
    @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } table { font-size: .9rem; } header { align-items: flex-start; } }
  </style>
</head>
<body>
  <header><strong>知了hub 管理后台</strong>${navigation}</header>
  <main>${content}</main>
</body>
</html>`;
}

module.exports = { escapeHtml, layout };
