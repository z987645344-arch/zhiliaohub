const { escapeHtml, formatDate, page } = require('./shared');

function renderNotesList(notes) {
  const cards = notes.map((note) => `          <article class="diary-card"><a href="notes-${escapeHtml(note.slug)}.html"><time datetime="${escapeHtml(note.note_date)}">${formatDate(note.note_date)}</time><div><h2>${escapeHtml(note.title)}</h2><p>${escapeHtml(note.summary)}</p></div><span class="diary-arrow" aria-hidden="true">↗</span></a></article>`).join('\n');
  return page({
    title: '学习心得',
    description: '知了hub 的学习心得与日记列表。',
    current: 'notes',
    content: `<main class="page-main" id="main-content">
      <section class="page-hero" aria-labelledby="page-title"><div class="page-hero-grid"><div><p class="page-kicker">Learning notes / 03</p><h1 class="page-title" id="page-title">学习<span class="outline">心得</span></h1><p class="page-index">ZHILIAO — NOTES 03</p></div><p class="page-intro">把零散的学习痕迹按日期收好，让每一次记录都能在之后被重新看见。</p></div><figure class="page-visual page-visual-notes"><img src="assets/notes-oc-rain-writing.webp" width="1731" height="909" alt="黑发男孩坐在雨幕映照的水泥灰窗边，低头在空白笔记本上安静书写" loading="lazy" decoding="async"></figure></section>
      <section class="notes-section" aria-labelledby="diary-list-title"><div class="section-bar"><h2 id="diary-list-title">日记索引</h2><span>${notes.length} ENTRIES / PUBLISHED</span></div><div class="diary-list">
${cards || '<div class="archive-empty"><span class="archive-number">03 / NOTES</span><h3>笔记还在积累中</h3><p>这里会按日期收录学习中的尝试与心得，目前还没有公开的文章。先去作品里逛逛吧。</p><a class="back-link" href="works.html">浏览作品 ↗</a></div>'}
        </div></section>
    </main>`,
  });
}

function renderNoteDetail(note, htmlBody, index) {
  const number = String(index + 1).padStart(2, '0');
  return page({
    title: note.title,
    description: `${note.title}的日记详情。`,
    current: 'notes',
    bodyClass: 'detail-page note-detail-page',
    content: `<main class="detail-main" id="main-content"><article class="note-detail" aria-labelledby="note-title"><a class="back-link" href="notes.html">← 返回日记列表</a><header class="note-detail-header"><p class="page-kicker">LEARNING NOTE / ${number}</p><h1 id="note-title">${escapeHtml(note.title)}</h1><div class="detail-meta"><time datetime="${escapeHtml(note.note_date)}">${formatDate(note.note_date)}</time><span>状态 / 已发布</span></div></header><section class="version-log work-manual-body note-body" aria-label="日记正文">${htmlBody}</section></article></main>`,
  });
}

module.exports = { renderNoteDetail, renderNotesList };
