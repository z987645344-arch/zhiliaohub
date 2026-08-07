const { escapeHtml, formatDate, page } = require('./shared');

function renderNotesList(notes) {
  const cards = notes.map((note) => {
    const pill = note.is_placeholder ? '<span class="placeholder-pill">占位条目</span>' : '';
    return `          <article class="diary-card"><a href="notes-${escapeHtml(note.slug)}.html"><time datetime="${escapeHtml(note.note_date)}">${formatDate(note.note_date)}</time><div>${pill}<h2>${escapeHtml(note.title)}</h2><p>${escapeHtml(note.summary)}</p></div><span class="diary-arrow" aria-hidden="true">↗</span></a></article>`;
  }).join('\n');
  const placeholders = notes.filter((note) => note.is_placeholder).length;
  const allPlaceholders = notes.length > 0 && placeholders === notes.length;
  const notice = placeholders
    ? `<div class="diary-notice"><strong>占位内容说明</strong><p>${allPlaceholders ? '以下日期、标题和摘要只用于预览日记列表样式，不代表真实文章已经发布。' : '标注为占位条目的日期、标题和摘要只用于预览日记结构，不代表真实文章已经发布。'}</p></div>`
    : '';
  const status = allPlaceholders ? `${notes.length} PLACEHOLDERS / NOT PUBLISHED` : placeholders ? `${notes.length} ENTRIES / ${placeholders} PLACEHOLDERS` : `${notes.length} ENTRIES / PUBLISHED`;
  const intro = allPlaceholders
    ? '把零散的学习痕迹按日期收好。当前条目用于确认日记列表与阅读结构，正文尚未发布。'
    : '把零散的学习痕迹按日期收好，让每一次记录都能在之后被重新看见。';
  return page({
    title: '学习心得',
    description: allPlaceholders ? '知了hub 的学习心得与占位日记列表。' : '知了hub 的学习心得与日记列表。',
    current: 'notes',
    content: `<main class="page-main" id="main-content">
      <section class="page-hero" aria-labelledby="page-title"><div class="page-hero-grid"><div><p class="page-kicker">Learning notes / 02</p><h1 class="page-title" id="page-title">学习<span class="outline">心得</span></h1><p class="page-index">ZHILIAO.HUB — NOTES 02</p></div><p class="page-intro">${intro}</p></div><figure class="page-visual page-visual-notes"><img src="assets/notes-oc-rain-writing.webp" width="1731" height="909" alt="黑发男孩坐在雨幕映照的水泥灰窗边，低头在空白笔记本上安静书写" loading="lazy" decoding="async"></figure></section>
      <section class="notes-section" aria-labelledby="diary-list-title"><div class="section-bar"><h2 id="diary-list-title">日记索引</h2><span>${status}</span></div>${notice}<div class="diary-list">
${cards}
        </div></section>
    </main>`,
  });
}

function renderNoteDetail(note, htmlBody, index) {
  const number = String(index + 1).padStart(2, '0');
  const placeholder = Boolean(note.is_placeholder);
  const pill = placeholder ? '<span class="placeholder-pill">占位内容</span>' : '';
  return page({
    title: note.title,
    description: placeholder ? `占位日记《${note.title}》的详情模板。` : `${note.title}的日记详情。`,
    current: 'notes',
    bodyClass: 'detail-page note-detail-page',
    content: `<main class="detail-main" id="main-content"><article class="note-detail" aria-labelledby="note-title"><a class="back-link" href="notes.html">← 返回日记列表</a><header class="note-detail-header"><p class="page-kicker">${placeholder ? 'PLACEHOLDER DIARY' : 'LEARNING NOTE'} / ${number}</p>${pill}<h1 id="note-title">${escapeHtml(note.title)}</h1><div class="detail-meta"><time datetime="${escapeHtml(note.note_date)}">${formatDate(note.note_date)}</time><span>状态 / ${placeholder ? '正文筹备中' : '已发布'}</span></div></header><section class="detail-actions note-actions" aria-label="日记操作" data-action-scope><div><button class="button button-outline" type="button" data-unavailable-action data-unavailable-message="登录后可编辑，该功能暂未开放。">编辑日记</button></div><p class="action-status" data-action-status role="status" tabindex="-1"></p></section><section class="note-placeholder" aria-label="日记正文">${htmlBody}</section></article></main>`,
  });
}

module.exports = { renderNoteDetail, renderNotesList };
