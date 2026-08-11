const { escapeHtml } = require('../lib/html');

const GENERATED_MARKER = '<!-- 此文件由知了hub后台自动生成，请勿手动编辑，编辑请通过管理后台 -->';

function navigation(current) {
  const link = (key, number, href, label) => `<a href="${href}"${current === key ? ' aria-current="page"' : ''}><span>${number}</span>${label}</a>`;
  return `<header class="site-header"><div class="header-inner"><a class="brand" href="index.html" aria-label="知了hub 首页"><span class="brand-mark" aria-hidden="true">知</span><span class="brand-copy"><strong>知了hub</strong><small>PERSONAL ARCHIVE</small></span></a><button class="nav-toggle" type="button" aria-label="打开或关闭导航" aria-controls="site-nav" aria-expanded="false"><span></span><span></span></button><nav class="site-nav" id="site-nav" aria-label="主导航">${link('home', '01', 'index.html', '首页')}${link('works', '02', 'works.html', '作品展示')}${link('notes', '03', 'notes.html', '学习心得')}${link('tools', '04', 'tools.html', '智能工具')}${link('feedback', '05', 'feedback.html', '反馈中心')}</nav></div></header>`;
}

function footer() {
  return '<footer class="site-footer"><div class="footer-inner"><p class="footer-wordmark">知了hub / ZHILIAO</p><p>© <span data-current-year>2026</span> · 持续生长的个人作品集</p></div></footer>';
}

function page({ title, description, current, bodyClass = '', content }) {
  return `${GENERATED_MARKER}
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="${escapeHtml(description)}">
    <meta name="theme-color" content="#d9dde0">
    <title>${escapeHtml(title)}｜知了hub</title>
    <link rel="stylesheet" href="css/style.css">
    <script src="js/site.js" defer></script>
  </head>
  <body${bodyClass ? ` class="${escapeHtml(bodyClass)}"` : ''}>
    <a class="skip-link" href="#main-content">跳到主要内容</a>
    ${navigation(current)}
    ${content}
    ${footer()}
  </body>
</html>
`;
}

function formatDate(value) {
  return String(value).replaceAll('-', '.');
}

module.exports = { GENERATED_MARKER, escapeHtml, formatDate, page };
