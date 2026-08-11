const { escapeHtml, page } = require('./shared');

function formatCommentTime(value) {
  const normalized = String(value || '');
  const visible = normalized.replace('T', ' ').slice(0, 16).replaceAll('-', '.');
  return visible ? `${visible} UTC` : '';
}

function formFields(prefix, { parentId = null } = {}) {
  const id = (name) => `${prefix}-${name}`;
  return `${parentId === null ? '' : `<input type="hidden" name="parent_id" value="${parentId}">`}
    <div class="form-row"><div class="field"><label for="${id('name')}">称呼 / NAME</label><input id="${id('name')}" name="author_name" type="text" autocomplete="name" placeholder="怎么称呼你" required maxlength="80"></div><div class="field"><label for="${id('email')}">邮箱 / EMAIL（可选）</label><input id="${id('email')}" name="email" type="email" autocomplete="email" placeholder="name@example.com" maxlength="254"><small class="field-hint">仅供站长私下联系，永不公开展示。</small></div></div>
    <div class="field"><label for="${id('message')}">留言 / MESSAGE</label><textarea id="${id('message')}" name="body" placeholder="写下你的想法" required minlength="2" maxlength="2000"></textarea></div>
    <div class="feedback-honeypot" aria-hidden="true"><label for="${id('website')}">网站</label><input id="${id('website')}" name="website" type="text" tabindex="-1" autocomplete="off"></div>`;
}

function renderReply(reply) {
  const adminBadge = reply.is_admin_reply
    ? '<span class="comment-admin-badge">站长回复</span>'
    : '';
  return `<article class="comment-item comment-reply" data-comment-id="${reply.id}"><div class="comment-meta"><span>${escapeHtml(reply.author_name)}${adminBadge}</span><time datetime="${escapeHtml(reply.created_at)}">${escapeHtml(formatCommentTime(reply.created_at))}</time></div><p>${escapeHtml(reply.body)}</p></article>`;
}

function renderTopic(topic) {
  const controlId = `reply-form-${topic.id}`;
  const adminBadge = topic.is_admin_reply
    ? '<span class="comment-admin-badge">站长</span>'
    : '';
  return `<article class="comment-item" data-comment-id="${topic.id}"><div class="comment-meta"><span>${escapeHtml(topic.author_name)}${adminBadge}</span><time datetime="${escapeHtml(topic.created_at)}">${escapeHtml(formatCommentTime(topic.created_at))}</time></div><p>${escapeHtml(topic.body)}</p><button type="button" class="text-button" data-reply-toggle aria-expanded="false" aria-controls="${controlId}">回复</button><form class="comment-reply-form" id="${controlId}" data-feedback-form action="/api/feedback/comments" method="post" hidden>${formFields(`reply-${topic.id}`, { parentId: topic.id })}<div class="reply-form-footer"><p>回复提交后同样需要审核，通过后才会公开。</p><button class="button button-acid" type="submit">提交回复</button></div><p class="form-status" data-feedback-status role="status" tabindex="-1"></p></form>${topic.replies.map(renderReply).join('')}</article>`;
}

function renderFeedbackPage(topics) {
  const comments = topics.length
    ? topics.map(renderTopic).join('')
    : '<div class="comment-empty"><strong>还没有留言</strong><p>来说点什么吧。每条内容都会先经过审核，再公开显示在这里。</p></div>';
  return page({
    title: '反馈中心',
    description: '在知了hub提交留言、查看已通过审核的评论与站长回复。',
    current: 'feedback',
    content: `<main class="page-main" id="main-content">
      <section class="page-hero" aria-labelledby="page-title">
        <div class="page-hero-grid"><div><p class="page-kicker">Feedback signal / 03</p><h1 class="page-title" id="page-title">反馈<span class="outline">中心</span></h1><p class="page-index">ZHILIAO.HUB — SIGNAL 03</p></div><p class="page-intro">这里接收真实留言。所有新内容都会先进入审核队列，通过后才会出现在公开评论区。</p></div>
        <figure class="page-visual"><img src="assets/feedback-oc-message-slot.webp" width="1724" height="912" alt="雨中的水泥灰城市廊下，黑发男孩手持空白卡片站在墙面留言槽前" loading="lazy" decoding="async"></figure>
      </section>

      <section class="feedback-section" aria-labelledby="feedback-form-title">
        <div class="feedback-grid">
          <aside class="feedback-aside"><div><p class="card-kicker">An open channel</p><h2 id="feedback-form-title">想说点什么？</h2><p>欢迎留下建议、想法或问候。内容会由站长审核后公开。</p></div><div class="availability-card is-open" id="feedback-disclaimer"><strong>留言通道已开放</strong><small>先审后发；请勿提交密码、验证码等敏感信息。</small></div></aside>
          <form class="feedback-form" data-feedback-form action="/api/feedback/comments" method="post" aria-describedby="feedback-disclaimer">${formFields('feedback')}<div class="form-footer"><p class="form-disclaimer">提交只代表进入审核队列，不会立即公开。邮箱仅供站长私下联系，永不展示。</p><button class="button button-acid" type="submit">提交留言</button></div><p class="form-status" data-feedback-status role="status" tabindex="-1"></p></form>
        </div>
      </section>

      <section class="comments-section" aria-labelledby="comments-title">
        <div class="section-bar"><h2 id="comments-title">已通过留言</h2><span>REVIEWED / PUBLIC</span></div>
        <div class="truth-notice" role="note"><strong>先审后发</strong><p>这里仅显示已通过审核的内容。待审核与已隐藏留言不会进入静态页面，邮箱和IP也永不公开。</p></div>
        <div class="comment-list" aria-label="已通过审核的留言">${comments}</div>
      </section>
    </main>`,
  });
}

module.exports = { formatCommentTime, renderFeedbackPage };
