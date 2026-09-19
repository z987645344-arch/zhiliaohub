const { escapeHtml, page } = require('./shared');
const { formatDateTime } = require('../lib/html');
const { safeParseGallery } = require('../services/content-service');

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

function compareByLatest(left, right) {
  const leftUpdated = String(left.updated_at || left.created_at || '');
  const rightUpdated = String(right.updated_at || right.created_at || '');
  return rightUpdated.localeCompare(leftUpdated)
    || String(right.created_at || '').localeCompare(String(left.created_at || ''))
    || Number(right.id || 0) - Number(left.id || 0);
}

function worksInCategory(works, category) {
  return works.filter((work) => work.category === category).sort(compareByLatest);
}

function renderWorkCard(work, index, headingLevel = 2) {
  const [cover, code, symbol] = presentation(work, index);
  const number = String(index + 1).padStart(2, '0');
  const featured = work.special_status === 'official_url_pending' ? ' portfolio-card-featured' : '';
  const enter = work.special_status === 'official_url_pending' ? '进入详情 · 展示入口待开放' : '进入详情';
  const headingTag = headingLevel === 3 ? 'h3' : 'h2';
  const coverMarkup = work.cover_image
    ? `<div class="portfolio-cover portfolio-cover-photo"><img src="${escapeHtml(work.cover_image)}" alt="${escapeHtml(work.title)}封面" loading="lazy" decoding="async"><span class="portfolio-cover-num">${escapeHtml(code)} / ${number}</span></div>`
    : `<div class="portfolio-cover ${cover}"><span>${escapeHtml(code)} / ${number}</span><b aria-hidden="true">${escapeHtml(symbol)}</b></div>`;
  return `<article class="portfolio-card${featured}"><a class="portfolio-card-link" href="works-${escapeHtml(work.slug)}.html">${coverMarkup}<div class="portfolio-copy"><small>${escapeHtml(work.category)}</small><${headingTag}>${escapeHtml(work.title)}</${headingTag}><p>${escapeHtml(work.detail_intro || '')}</p><span class="card-enter">${enter}</span></div></a></article>`;
}

function renderCategorySection(category, works) {
  const allCategoryWorks = worksInCategory(works, category.name);
  const latestWorks = allCategoryWorks.slice(0, 4);
  const headingId = `works-category-${category.slug}-title`;
  const cards = latestWorks.map((work, index) => renderWorkCard(work, index, 3)).join('\n              ');
  const archiveLabel = `${allCategoryWorks.length} ITEMS / LATEST ${latestWorks.length}`;
  const body = latestWorks.length
    ? `<div class="work-slider-track" data-work-track tabindex="0" aria-label="${category.name}最新作品，可横向滑动">
              ${cards}
            </div>`
    : `<div class="work-category-empty"><p>${escapeHtml(category.empty_text)}</p></div>`;
  return `<section class="work-category-block" data-work-slider aria-labelledby="${headingId}">
          <div class="work-category-head"><div><p class="work-category-kicker">${escapeHtml(category.kicker)}</p><h2 id="${headingId}">${escapeHtml(category.name)}</h2><span>${archiveLabel}</span></div><a class="work-category-access" href="works-category-${category.slug}.html">查看全部<span aria-hidden="true">↗</span></a></div>
          ${body}
        </section>`;
}

function renderLabSection(projects) {
  if (!projects.length) return '';
  const cards = projects.map((project, index) => {
    const number = String(index + 1).padStart(2, '0');
    const cover = project.cover_image
      ? `<div class="portfolio-cover portfolio-cover-photo"><img src="${escapeHtml(project.cover_image)}" alt="${escapeHtml(project.title)}封面" loading="lazy" decoding="async"><span class="portfolio-cover-num">LAB / ${number}</span></div>`
      : `<div class="portfolio-cover ${fallbackCovers[index % fallbackCovers.length]}"><span>LAB / ${number}</span><b aria-hidden="true">◇</b></div>`;
    return `<article class="portfolio-card"><a class="portfolio-card-link" href="${escapeHtml(project.accessUrl)}" target="_blank" rel="noopener noreferrer">${cover}<div class="portfolio-copy"><small>LAB / ${number}</small><h3>${escapeHtml(project.title)}</h3><p>${escapeHtml(project.description)}</p><span class="card-enter">打开独立页面 ↗</span></div></a></article>`;
  }).join('\n              ');
  const cardsMarkup = `<div class="work-slider-track" data-work-track tabindex="0" aria-label="小作坊项目，可横向滑动">${cards}</div>`;
  return `<section class="work-category-block lab-section" data-work-slider aria-labelledby="lab-section-title"><div class="work-category-head"><div><p class="work-category-kicker">LAB / EXPERIMENTS</p><h2 id="lab-section-title">小作坊</h2><span>${projects.length} ITEMS</span></div></div><p class="lab-section-intro">一些独立打包的小型网页实验，在新的窗口中打开。</p>${cardsMarkup}</section>`;
}

function renderWorksList(categories, works, labProjects = []) {
  const sections = categories.length
    ? categories.map((category) => renderCategorySection(category, works)).join('\n        ')
    : '<div class="work-category-empty"><p>作品还在整理中。这里会按主题收录影像、声音和软件创作，公开后就能逐一浏览。</p></div>';
  const visibleWorks = works.filter((work) => categories.some((category) => category.name === work.category));

  return page({
    title: '作品展示',
    description: '知了hub 的作品展示，收录视频、音乐、建模、网页与软件作品。',
    current: 'works',
    content: `<main class="page-main" id="main-content">
      <section class="page-hero" aria-labelledby="page-title"><div class="page-hero-grid"><div><p class="page-kicker">Selected works / 02</p><h1 class="page-title" id="page-title">作品<span class="outline">展示</span></h1><p class="page-index">ZHILIAO — ARCHIVE 02</p></div><p class="page-intro">从影像、声音到软件，把做过的尝试放在同一条安静的街道上。按分组浏览，或打开一件作品看看它的来路。</p></div><figure class="page-visual"><img src="assets/works-oc-creative-passage.webp" width="1729" height="910" alt="雨后的水泥灰都市廊道中，黑发男孩站在相机、耳机、电脑和建筑模型组成的创作台前" decoding="async"></figure></section>
      <section class="works-section" aria-labelledby="works-list-title"><div class="section-bar"><h2 id="works-list-title">分组索引</h2><span>${visibleWorks.length} WORKS / ${categories.length} CATEGORIES</span></div><div class="work-category-stack">
        ${sections}
        </div></section>
      ${renderLabSection(labProjects)}
    </main>`,
  });
}

function renderWorkCategory(category, works) {
  if (!category?.name || !category?.slug) throw new TypeError('作品分组数据不完整。');
  const categoryWorks = worksInCategory(works, category.name);
  const cards = categoryWorks.map((work, index) => renderWorkCard(work, index)).join('\n          ');
  const content = cards
    ? `<div class="portfolio-grid category-portfolio-grid">${cards}</div>`
    : `<div class="work-category-empty work-category-empty-page"><p>${escapeHtml(category.empty_text)}</p></div>`;
  return page({
    title: `${category.name}作品`,
    description: `知了hub ${category.name}分类的全部作品。`,
    current: 'works',
    bodyClass: 'works-category-page',
    content: `<main class="page-main" id="main-content">
      <section class="category-page-hero" aria-labelledby="category-page-title"><a class="back-link" href="works.html">← 返回作品展示</a><p class="page-kicker">${escapeHtml(category.kicker)}</p><h1 id="category-page-title">${escapeHtml(category.name)}<span class="outline">作品</span></h1><p>${escapeHtml(category.intro)}</p></section>
      <section class="works-section" aria-labelledby="category-list-title"><div class="section-bar"><h2 id="category-list-title">全部${escapeHtml(category.name)}作品</h2><span>${categoryWorks.length} ITEMS / FULL ARCHIVE</span></div>${content}</section>
    </main>`,
  });
}

function renderWorkDetail(work, updates = [], index = 0) {
  const [cover, code, symbol] = presentation(work, index);
  const number = String(index + 1).padStart(2, '0');
  const placeholder = Boolean(work.is_placeholder);
  const special = work.special_status === 'official_url_pending';
  const status = special ? '展示入口待开放' : placeholder ? '内容筹备中' : '已发布';
  const gallery = safeParseGallery(work.gallery);
  const storedPrimaryPath = work.main_media_path || work.cover_image;
  const storedPrimaryType = work.main_media_path && work.main_media_type === 'video' ? 'video' : 'image';
  const stageItems = [
    ...(storedPrimaryPath ? [{ path: storedPrimaryPath, type: storedPrimaryType, primary: true }] : []),
    ...gallery.map((item) => ({
      path: item,
      type: /\.(?:mp4|webm)$/i.test(item) ? 'video' : 'image',
      primary: false,
    })),
  ];
  const primaryItem = stageItems[0] || null;
  const primaryPath = primaryItem?.path;
  const primaryType = primaryItem?.type;
  const mainMedia = primaryPath
    ? primaryType === 'video'
      ? `<video class="showcase-main" src="${escapeHtml(primaryPath)}" controls preload="metadata" playsinline aria-label="${escapeHtml(work.title)}主视频"></video>`
      : `<img class="showcase-main" src="${escapeHtml(primaryPath)}" alt="${escapeHtml(work.title)}主图" decoding="async">`
    : `<div class="showcase-main showcase-placeholder portfolio-cover ${cover}" role="img" aria-label="${escapeHtml(work.title)}暂无媒体，显示默认封面"><span>${escapeHtml(code)} / ${number}</span><b aria-hidden="true">${escapeHtml(symbol)}</b></div>`;
  const thumbs = stageItems.map((item, itemIndex) => {
    const label = item.primary
      ? `${item.type === 'video' ? '播放' : '查看'}主${item.type === 'video' ? '视频' : '图'}`
      : `${item.type === 'video' ? '播放辅视频' : '查看辅图'} ${itemIndex + (storedPrimaryPath ? 0 : 1)}`;
    const preview = item.type === 'video'
      ? `<video src="${escapeHtml(item.path)}" muted preload="metadata" playsinline aria-hidden="true"></video>`
      : `<img src="${escapeHtml(item.path)}" alt="" loading="lazy" decoding="async">`;
    return `<button class="showcase-thumb${itemIndex === 0 ? ' is-active' : ''}" type="button" data-src="${escapeHtml(item.path)}" data-type="${item.type}" aria-label="${label}" aria-current="${itemIndex === 0 ? 'true' : 'false'}">${preview}</button>`;
  }).join('');
  const galleryControls = gallery.length > 0
    ? `<div class="showcase-gallery" data-showcase-gallery><button class="showcase-gallery-arrow" type="button" data-showcase-scroll-prev aria-label="向左滚动媒体缩略图" aria-disabled="true" disabled>←</button><div class="showcase-thumbs" data-showcase-thumbs aria-label="作品媒体" tabindex="0">${thumbs}</div><button class="showcase-gallery-arrow" type="button" data-showcase-scroll-next aria-label="向右滚动媒体缩略图" aria-disabled="true" disabled>→</button></div>`
    : '';
  const downloadButton = work.is_downloadable && work.download_file
    ? `<a class="button" href="${escapeHtml(work.download_file)}" download>下载作品</a>`
    : '';
  const experienceButton = work.experience_url
    ? `<a class="button button-outline" href="${escapeHtml(work.experience_url)}" target="_blank" rel="noopener noreferrer">前往体验</a>`
    : '';
  const actions = downloadButton || experienceButton
    ? `<div class="showcase-actions">${downloadButton}${experienceButton}</div>`
    : '';
  const sortedUpdates = [...updates].sort((left, right) => (
    String(right.recorded_at).localeCompare(String(left.recorded_at)) || Number(right.id) - Number(left.id)
  ));
  const renderUpdate = (update) => `<article class="version-entry"><time datetime="${escapeHtml(update.recorded_at)}">${escapeHtml(formatDateTime(update.recorded_at))}</time><div class="version-entry-body">${update.htmlBody}</div></article>`;
  const visibleUpdates = sortedUpdates.slice(0, 5);
  const hiddenUpdates = sortedUpdates.slice(5);
  const hiddenUpdatesMarkup = hiddenUpdates.length
    ? `<details class="version-more"><summary>展开更新详情（还有 ${hiddenUpdates.length} 条）</summary><div class="version-timeline version-timeline-overflow">${hiddenUpdates.map(renderUpdate).join('')}</div></details>`
    : '';
  const updatesMarkup = sortedUpdates.length
    ? `<div class="version-timeline">${visibleUpdates.map(renderUpdate).join('')}${hiddenUpdatesMarkup}</div>`
    : '<p class="version-log-empty">还没有更新记录。之后的调整与新进展会记在这里。</p>';
  const detailsMarkup = work.htmlDetailBody
    ? `<section class="detail-content work-manual" aria-labelledby="work-manual-title"><div class="section-bar"><h2 id="work-manual-title">详情</h2><span>WORK MANUAL</span></div><div class="version-log work-manual-body">${work.htmlDetailBody}</div></section>`
    : '';
  return page({
    title: work.title,
    description: work.detail_intro || '',
    current: 'works',
    bodyClass: 'detail-page',
    content: `<main class="detail-main" id="main-content">
      <div class="showcase-shell"><a class="back-link" href="works.html">← 返回作品列表</a><section class="showcase" aria-labelledby="detail-title"><div class="showcase-left"><div class="showcase-stage" data-showcase-stage aria-live="polite">${mainMedia}</div>${galleryControls}</div><div class="showcase-right"><p class="page-kicker">${escapeHtml(work.category)} / WORK ${number}</p><h1 id="detail-title">${escapeHtml(work.title)}</h1><p class="showcase-intro">${escapeHtml(work.detail_intro || '')}</p>${actions}<div class="showcase-meta"><span>状态 / ${status}</span></div></div></section></div>
      ${detailsMarkup}<section class="detail-content" aria-labelledby="version-log-title"><div class="section-bar"><h2 id="version-log-title">更新记录</h2><span>${sortedUpdates.length ? `${sortedUpdates.length} ENTRIES` : 'NO ENTRIES'}</span></div><div class="version-log">${updatesMarkup}</div></section>
    </main>`,
  });
}

module.exports = {
  renderWorkCategory,
  renderWorkDetail,
  renderWorksList,
};
