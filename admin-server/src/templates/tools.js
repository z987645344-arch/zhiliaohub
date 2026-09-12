const { escapeHtml, page } = require('./shared');
function renderToolCard(work, index) {
  const number = String(index + 1).padStart(2, '0');
  const experienceLink = work.experience_url
    ? `<a class="button button-acid" href="${escapeHtml(work.experience_url)}" target="_blank" rel="noopener noreferrer">前往工具</a>`
    : '<span class="tool-card-meta">暂未提供体验链接</span>';
  return `<article class="tool-card" aria-labelledby="tool-title-${escapeHtml(work.slug)}"><div class="tool-card-copy"><div class="tool-card-label"><span>可访问</span><small>INTELLIGENT TOOL / ${number}</small></div><h3 id="tool-title-${escapeHtml(work.slug)}">${escapeHtml(work.title)}</h3><p class="tool-card-summary">${escapeHtml(work.detail_intro || work.summary || '')}</p></div><div class="tool-card-actions"><p><strong>作品记录</strong><span>先了解它能做什么，再打开独立工具开始使用。</span></p><div><a class="button button-ghost tool-card-view" href="works-${escapeHtml(work.slug)}.html">查看作品</a>${experienceLink}</div></div></article>`;
}

function renderToolsPage(works) {
  const tools = works.filter((work) => Number(work.show_on_tools) === 1);
  const body = tools.length
    ? `<section class="page-hero" aria-labelledby="page-title"><div class="page-hero-grid"><div><p class="page-kicker">Intelligent tools / 04</p><h1 class="page-title" id="page-title">智能<span class="outline">工具</span></h1><p class="page-index">ZHILIAO — TOOLS 04</p></div><p class="page-intro">一些把想法变成行动的小工具。先看介绍，或直接前往它自己的页面。</p></div><figure class="page-visual page-visual-tools"><img src="assets/tools-oc-planning-workbench.webp" width="1727" height="911" alt="黑发男孩在安静的工作台前整理工具与创作想法" decoding="async"></figure></section><section class="tools-section" aria-labelledby="tools-list-title"><div class="section-bar"><h2 id="tools-list-title">可以使用的工具</h2><span>${tools.length} AVAILABLE</span></div>${tools.map(renderToolCard).join('')}</section>`
    : '<section class="page-hero" aria-labelledby="page-title"><div class="page-hero-grid"><div><p class="page-kicker">Intelligent tools / 04</p><h1 class="page-title" id="page-title">智能<span class="outline">工具</span></h1><p class="page-index">ZHILIAO — TOOLS 04</p></div><p class="page-intro">还没有公开的工具。这里会收录可直接使用的项目；现在可以先去作品展示了解正在做的尝试。</p></div><figure class="page-visual page-visual-tools"><img src="assets/tools-oc-planning-workbench.webp" width="1727" height="911" alt="黑发男孩在安静的工作台前整理工具与创作想法" decoding="async"></figure></section>';

  return page({
    title: '智能工具',
    description: '知了hub 已公开的智能工具。',
    current: 'tools',
    content: `<main class="page-main" id="main-content">${body}</main>`,
  });
}

module.exports = { renderToolsPage };
