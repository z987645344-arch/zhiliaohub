const { escapeHtml, page } = require('./shared');

const legacyPresentations = {
  'mix-video': ['cover-cut', 'MV', '▶', 'VIDEO EDIT'],
  'ai-music': ['cover-wave', 'AM', '♪', 'GENERATIVE SOUND'],
  'ai-video': ['cover-frame', 'AV', '◫', 'GENERATIVE VIDEO'],
  '3d-model': ['cover-cube', '3D', '◇', '3D MODELING'],
  'web-design': ['cover-grid', 'WD', '⌘', 'WEB DESIGN'],
  zhili: ['cover-ring', 'APP', '历', 'SOFTWARE'],
  zhiliao: ['cover-pulse', 'APP', '了', 'SOFTWARE'],
  zhitian: ['cover-orbit', 'SYSTEM', '天', 'AI APPLICATION'],
};
const fallbackCovers = ['cover-cut', 'cover-wave', 'cover-frame', 'cover-cube', 'cover-grid', 'cover-ring', 'cover-pulse', 'cover-orbit'];

function presentation(work, index) {
  return legacyPresentations[work.slug] || [fallbackCovers[index % fallbackCovers.length], 'WORK', '◇', String(work.category).toUpperCase()];
}

function renderWorksList(works) {
  const cards = works.map((work, index) => {
    const [cover, code, symbol, label] = presentation(work, index);
    const number = String(index + 1).padStart(2, '0');
    const featured = work.special_status === 'official_url_pending' ? ' portfolio-card-featured' : '';
    const enter = work.special_status === 'official_url_pending' ? '进入详情 · 展示入口待开放' : '进入详情';
    return `          <article class="portfolio-card${featured}"><a class="portfolio-card-link" href="works-${escapeHtml(work.slug)}.html"><div class="portfolio-cover ${cover}"><span>${escapeHtml(code)} / ${number}</span><b aria-hidden="true">${escapeHtml(symbol)}</b></div><div class="portfolio-copy"><small>${escapeHtml(label)}</small><h2>${escapeHtml(work.title)}</h2><p>${escapeHtml(work.summary)}</p><span class="card-enter">${enter}</span></div></a></article>`;
  }).join('\n');

  return page({
    title: '作品展示',
    description: '知了hub 的作品展示，收录视频、音乐、建模、网页与软件作品。',
    current: 'works',
    content: `<main class="page-main" id="main-content">
      <section class="page-hero" aria-labelledby="page-title"><div class="page-hero-grid"><div><p class="page-kicker">Selected works / 01</p><h1 class="page-title" id="page-title">作品<span class="outline">展示</span></h1><p class="page-index">ZHILIAO.HUB — ARCHIVE 01</p></div><p class="page-intro">从影像、声音到软件，把做过的尝试放在同一条安静的街道上。每个分类都有自己的入口，也为后续内容继续留出空间。</p></div><figure class="page-visual"><img src="assets/works-oc-creative-passage.webp" width="1729" height="910" alt="雨后的水泥灰都市廊道中，黑发男孩站在相机、耳机、电脑和建筑模型组成的创作台前" decoding="async"></figure></section>
      <section class="works-section" aria-labelledby="works-list-title"><div class="section-bar"><h2 id="works-list-title">作品索引</h2><span>${works.length} CATEGORIES / GROWING ARCHIVE</span></div><div class="portfolio-grid">
${cards}
        </div></section>
    </main>`,
  });
}

function renderWorkDetail(work, htmlBody, index) {
  const [, , , label] = presentation(work, index);
  const number = String(index + 1).padStart(2, '0');
  const placeholder = Boolean(work.is_placeholder);
  const special = work.special_status === 'official_url_pending';
  const displayButton = special
    ? '<button class="button button-outline" type="button" data-unavailable-action data-unavailable-message="展示入口暂未开放：知天的正式对外地址尚未配置。">展示入口</button>'
    : '';
  const status = special ? '展示入口待开放' : placeholder ? '内容筹备中' : '已发布';
  const legacyDescription = {
    zhili: '软件知历的作品详情与工作日志占位。',
    zhiliao: '软件知了的作品详情与工作日志占位。',
    zhitian: '知天企业知识库RAG+Agent系统的作品详情与工作日志占位。',
  }[work.slug];
  const workLabel = String(work.title).endsWith('作品') ? work.title : `${work.title}作品`;
  const description = placeholder && legacyDescription
    ? legacyDescription
    : `${workLabel}详情与工作日志${placeholder ? '占位' : ''}。`;
  return page({
    title: work.title,
    description,
    current: 'works',
    bodyClass: 'detail-page',
    content: `<main class="detail-main" id="main-content">
      <section class="detail-hero" aria-labelledby="detail-title"><a class="back-link" href="works.html">← 返回作品列表</a><div class="detail-heading"><div><p class="page-kicker">${escapeHtml(label)} / WORK ${number}</p><h1 id="detail-title">${escapeHtml(work.title)}</h1></div><p>${escapeHtml(work.detail_intro || work.summary)}</p></div><div class="detail-meta"><span>分类 / ${escapeHtml(work.category)}</span><span>状态 / ${status}</span></div></section>
      <section class="detail-actions" aria-label="作品操作" data-action-scope><div><button class="button" type="button" data-unavailable-action data-unavailable-message="下载功能暂未开放：当前没有可下载文件。">下载作品</button><button class="button button-outline" type="button" data-unavailable-action data-unavailable-message="登录功能暂未开放：当前站点没有用户系统。">登录入口</button>${displayButton}</div><p class="action-status" data-action-status role="status" tabindex="-1"></p></section>
      <section class="detail-content" aria-labelledby="work-log-title"><div class="section-bar"><h2 id="work-log-title">工作日志</h2><span>${placeholder ? 'NOT PUBLISHED' : 'PUBLISHED'}</span></div><div class="empty-log">${htmlBody}</div></section>
    </main>`,
  });
}

module.exports = { renderWorkDetail, renderWorksList };
