const { escapeHtml, page } = require('./shared');

function renderToolCard(work, index) {
  const number = String(index + 1).padStart(2, '0');
  const experienceLink = work.experience_url
    ? `<a class="button button-acid" href="${escapeHtml(work.experience_url)}" target="_blank" rel="noopener noreferrer">前往工具</a>`
    : '<span class="tool-card-meta">体验入口数据缺失</span>';
  return `<article class="tool-card" aria-labelledby="tool-title-${escapeHtml(work.slug)}"><div class="tool-card-copy"><div class="tool-card-label"><span>可访问</span><small>INTELLIGENT TOOL / ${number}</small></div><h3 id="tool-title-${escapeHtml(work.slug)}">${escapeHtml(work.title)}</h3><p class="tool-card-summary">${escapeHtml(work.detail_intro || work.summary || '')}</p></div><div class="tool-card-actions"><p><strong>作品记录</strong><span>工具信息由同一条作品记录维护。</span></p><div><a class="button button-ghost tool-card-view" href="works-${escapeHtml(work.slug)}.html">查看作品</a>${experienceLink}</div></div></article>`;
}

function renderToolsPage(works) {
  const tools = works.filter((work) => Number(work.show_on_tools) === 1);
  const body = tools.length
    ? `<section class="page-hero" aria-labelledby="page-title"><div class="page-hero-grid"><div><p class="page-kicker">Intelligent tools / 04</p><h1 class="page-title" id="page-title">智能<span class="outline">工具</span></h1><p class="page-index">ZHILIAO.HUB — TOOLS 04</p></div><p class="page-intro">这里汇集已经作为作品记录并开放体验入口的智能工具。</p></div></section><section class="tools-section" aria-labelledby="tools-list-title"><div class="section-bar"><h2 id="tools-list-title">工具列表</h2><span>${tools.length} AVAILABLE</span></div>${tools.map(renderToolCard).join('')}</section>`
    : '<section class="page-hero" aria-labelledby="page-title"><div class="page-hero-grid"><div><p class="page-kicker">Intelligent tools / 04</p><h1 class="page-title" id="page-title">智能<span class="outline">工具</span></h1><p class="page-index">ZHILIAO.HUB — TOOLS 04</p></div><p class="page-intro">目前没有已公开的智能工具。</p></div></section>';

  return page({
    title: '智能工具',
    description: '知了hub 已公开的智能工具。',
    current: 'tools',
    content: `<main class="page-main" id="main-content">${body}</main>`,
  });
}

module.exports = { renderToolsPage };
