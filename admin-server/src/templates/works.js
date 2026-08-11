const { escapeHtml, page } = require('./shared');
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

const WORK_CATEGORIES = Object.freeze([
  Object.freeze({
    name: '程序',
    slug: 'program',
    kicker: 'PROGRAM / SOFTWARE',
    intro: '软件、网页与系统项目，从可用原型到持续维护的产品记录。',
    empty: '程序作品正在整理中，新的项目会从这里出现。',
  }),
  Object.freeze({
    name: '影视',
    slug: 'film',
    kicker: 'FILM / MEDIA',
    intro: '影像、声音与三维创作，记录每一次表达和实验。',
    empty: '影视作品正在整理中，新的内容会从这里出现。',
  }),
  Object.freeze({
    name: '生活',
    slug: 'life',
    kicker: 'LIFE / DAILY',
    intro: '来自日常生活的制作、观察和小型实践。',
    empty: '生活类作品还在路上，欢迎稍后再来看看。',
  }),
]);

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

function categoryDefinition(category) {
  return WORK_CATEGORIES.find((item) => item.name === category) || null;
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
    ? `<div class="work-slider-shell"><button class="work-slider-arrow work-slider-arrow-prev" type="button" data-scroll-prev aria-label="向左浏览${category.name}作品" aria-disabled="true">←</button><div class="work-slider-track" data-work-track data-card-count="${latestWorks.length}" tabindex="0" aria-label="${category.name}最新作品，可横向滑动">
              ${cards}
            </div><button class="work-slider-arrow work-slider-arrow-next" type="button" data-scroll-next aria-label="向右浏览${category.name}作品" aria-disabled="true">→</button></div>`
    : `<div class="work-category-empty"><p>${escapeHtml(category.empty)}</p></div>`;
  return `<section class="work-category-block" data-work-slider aria-labelledby="${headingId}">
          <div class="work-category-head"><div><p class="work-category-kicker">${escapeHtml(category.kicker)}</p><h2 id="${headingId}">${escapeHtml(category.name)}</h2><span>${archiveLabel}</span></div><a class="work-category-access" href="works-category-${category.slug}.html">访问<span aria-hidden="true">↗</span></a></div>
          ${body}
        </section>`;
}

function renderLabSection(projects) {
  if (!projects.length) return '';
  const cards = projects.map((project, index) => `<article class="lab-card"><div class="lab-card-index">LAB / ${String(index + 1).padStart(2, '0')}</div><h3>${escapeHtml(project.title)}</h3><p>${escapeHtml(project.description)}</p><a href="${escapeHtml(project.accessUrl)}" target="_blank" rel="noopener noreferrer">打开独立页面<span aria-hidden="true">↗</span></a></article>`).join('');
  return `<section class="lab-section" aria-labelledby="lab-section-title"><div class="section-bar"><h2 id="lab-section-title">小作坊</h2><span>${projects.length} STATIC EXPERIMENTS</span></div><p class="lab-section-intro">一些独立打包的小型网页实验，在新的窗口中打开。</p><div class="lab-grid">${cards}</div></section>`;
}

function renderWorksList(works, labProjects = []) {
  const sections = WORK_CATEGORIES.map((category) => renderCategorySection(category, works)).join('\n        ');

  return page({
    title: '作品展示',
    description: '知了hub 的作品展示，收录视频、音乐、建模、网页与软件作品。',
    current: 'works',
    content: `<main class="page-main" id="main-content">
      <section class="page-hero" aria-labelledby="page-title"><div class="page-hero-grid"><div><p class="page-kicker">Selected works / 01</p><h1 class="page-title" id="page-title">作品<span class="outline">展示</span></h1><p class="page-index">ZHILIAO.HUB — ARCHIVE 01</p></div><p class="page-intro">从影像、声音到软件，把做过的尝试放在同一条安静的街道上。每个分类都有自己的入口，也为后续内容继续留出空间。</p></div><figure class="page-visual"><img src="assets/works-oc-creative-passage.webp" width="1729" height="910" alt="雨后的水泥灰都市廊道中，黑发男孩站在相机、耳机、电脑和建筑模型组成的创作台前" decoding="async"></figure></section>
      <section class="works-section" aria-labelledby="works-list-title"><div class="section-bar"><h2 id="works-list-title">分组索引</h2><span>${works.length} WORKS / ${WORK_CATEGORIES.length} CATEGORIES</span></div><div class="work-category-stack">
        ${sections}
        </div></section>
      ${renderLabSection(labProjects)}
    </main>`,
  });
}

function renderWorkCategory(categoryName, works) {
  const category = categoryDefinition(categoryName);
  if (!category) throw new TypeError(`未知作品分类：${categoryName}`);
  const categoryWorks = worksInCategory(works, category.name);
  const cards = categoryWorks.map((work, index) => renderWorkCard(work, index)).join('\n          ');
  const content = cards
    ? `<div class="portfolio-grid category-portfolio-grid">${cards}</div>`
    : `<div class="work-category-empty work-category-empty-page"><p>${escapeHtml(category.empty)}</p></div>`;
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

function renderWorkDetail(work, htmlBody, index) {
  const [cover, code, symbol] = presentation(work, index);
  const number = String(index + 1).padStart(2, '0');
  const placeholder = Boolean(work.is_placeholder);
  const special = work.special_status === 'official_url_pending';
  const status = special ? '展示入口待开放' : placeholder ? '内容筹备中' : '已发布';
  const primaryPath = work.main_media_path || work.cover_image;
  const primaryType = work.main_media_path && work.main_media_type === 'video' ? 'video' : 'image';
  const mainMedia = primaryPath
    ? primaryType === 'video'
      ? `<video class="showcase-main" src="${escapeHtml(primaryPath)}" controls preload="metadata" playsinline aria-label="${escapeHtml(work.title)}主视频"></video>`
      : `<img class="showcase-main" src="${escapeHtml(primaryPath)}" alt="${escapeHtml(work.title)}主图" decoding="async">`
    : `<div class="showcase-main showcase-placeholder portfolio-cover ${cover}" role="img" aria-label="${escapeHtml(work.title)}暂无媒体，显示默认封面"><span>${escapeHtml(code)} / ${number}</span><b aria-hidden="true">${escapeHtml(symbol)}</b></div>`;
  const gallery = safeParseGallery(work.gallery);
  const thumbs = gallery.map((item, galleryIndex) => {
    const video = /\.(?:mp4|webm)$/i.test(item);
    const label = `${video ? '播放辅视频' : '查看辅图'} ${galleryIndex + 1}`;
    const preview = video
      ? `<video src="${escapeHtml(item)}" muted preload="metadata" playsinline aria-hidden="true"></video>`
      : `<img src="${escapeHtml(item)}" alt="" loading="lazy" decoding="async">`;
    return `<button class="showcase-thumb" type="button" data-src="${escapeHtml(item)}" data-type="${video ? 'video' : 'image'}" aria-label="${label}" aria-pressed="false">${preview}</button>`;
  }).join('');
  const downloadButton = work.is_downloadable && work.download_file
    ? `<a class="button" href="${escapeHtml(work.download_file)}" download>下载</a>`
    : '';
  const experienceButton = work.experience_url
    ? `<a class="button button-outline" href="${escapeHtml(work.experience_url)}" target="_blank" rel="noopener noreferrer">体验</a>`
    : '';
  const actions = downloadButton || experienceButton
    ? `<div class="showcase-actions">${downloadButton}${experienceButton}</div>`
    : '';
  const versionLog = work.version_log
    ? htmlBody
    : '<p class="version-log-empty">暂无版本日志，后续更新将在这里记录。</p>';
  return page({
    title: work.title,
    description: work.detail_intro || '',
    current: 'works',
    bodyClass: 'detail-page',
    content: `<main class="detail-main" id="main-content">
      <div class="showcase-shell"><a class="back-link" href="works.html">← 返回作品列表</a><section class="showcase" aria-labelledby="detail-title"><div class="showcase-left"><div class="showcase-stage" data-showcase-stage aria-live="polite">${mainMedia}</div>${thumbs ? `<div class="showcase-thumbs" data-showcase-thumbs aria-label="作品辅助媒体">${thumbs}</div>` : ''}</div><div class="showcase-right"><p class="page-kicker">${escapeHtml(work.category)} / WORK ${number}</p><h1 id="detail-title">${escapeHtml(work.title)}</h1><p class="showcase-intro">${escapeHtml(work.detail_intro || '')}</p>${actions}<div class="showcase-meta"><span>状态 / ${status}</span></div></div></section></div>
      <section class="detail-content" aria-labelledby="version-log-title"><div class="section-bar"><h2 id="version-log-title">版本日志</h2><span>${work.version_log ? 'PUBLISHED' : 'NO ENTRIES'}</span></div><div class="version-log">${versionLog}</div></section>
    </main>`,
  });
}

module.exports = {
  WORK_CATEGORIES,
  renderWorkCategory,
  renderWorkDetail,
  renderWorksList,
};
