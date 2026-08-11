const COMMENT_STATUS = Object.freeze({
  pending: 'pending',
  approved: 'approved',
  rejected: 'rejected',
});

const LIMITS = Object.freeze({
  authorNameMax: 80,
  emailMax: 254,
  bodyMin: 2,
  bodyMax: 2000,
});

class FeedbackValidationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'FeedbackValidationError';
    this.statusCode = statusCode;
  }
}

function textLength(value) {
  return Array.from(value).length;
}

function validateAuthorName(value) {
  const name = String(value || '').trim();
  if (!name) throw new FeedbackValidationError('请填写称呼。');
  if (textLength(name) > LIMITS.authorNameMax) {
    throw new FeedbackValidationError(`称呼不能超过${LIMITS.authorNameMax}个字符。`);
  }
  return name;
}

function validateEmail(value) {
  const email = String(value || '').trim();
  if (!email) return null;
  if (textLength(email) > LIMITS.emailMax
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new FeedbackValidationError('邮箱格式不正确。');
  }
  return email;
}

function validateBody(value) {
  const body = String(value || '').trim();
  const length = textLength(body);
  if (length < LIMITS.bodyMin) {
    throw new FeedbackValidationError(`留言至少需要${LIMITS.bodyMin}个字符。`);
  }
  if (length > LIMITS.bodyMax) {
    throw new FeedbackValidationError(`留言不能超过${LIMITS.bodyMax}个字符。`);
  }
  return body;
}

function validateParentId(value) {
  if (value === undefined || value === null || value === '') return null;
  const parentId = Number(value);
  if (!Number.isSafeInteger(parentId) || parentId <= 0) {
    throw new FeedbackValidationError('回复目标无效。');
  }
  return parentId;
}

class FeedbackService {
  constructor(database) {
    this.database = database;
  }

  getComment(id) {
    const commentId = validateParentId(id);
    const comment = this.database.prepare('SELECT * FROM feedback_comments WHERE id = ?').get(commentId);
    if (!comment) throw new FeedbackValidationError('留言不存在。', 404);
    return comment;
  }

  approvedTopLevel(id) {
    const parent = this.getComment(id);
    if (parent.parent_id !== null) throw new FeedbackValidationError('不允许回复已有回复。');
    if (parent.status !== COMMENT_STATUS.approved) {
      throw new FeedbackValidationError('只能回复已通过审核的顶层留言。');
    }
    return parent;
  }

  listTopics({ pendingOnly = false } = {}) {
    const comments = this.database.prepare(`
      SELECT * FROM feedback_comments
      ORDER BY created_at ASC, id ASC
    `).all();
    const topics = [];
    const topicsById = new Map();
    for (const comment of comments) {
      if (comment.parent_id !== null) continue;
      const topic = { ...comment, replies: [], hasPending: comment.status === COMMENT_STATUS.pending };
      topics.push(topic);
      topicsById.set(comment.id, topic);
    }
    for (const comment of comments) {
      if (comment.parent_id === null) continue;
      const topic = topicsById.get(comment.parent_id);
      if (!topic) continue;
      topic.replies.push(comment);
      if (comment.status === COMMENT_STATUS.pending) topic.hasPending = true;
    }
    topics.sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id - left.id);
    return pendingOnly ? topics.filter((topic) => topic.hasPending) : topics;
  }

  countPending() {
    return this.database.prepare(`
      SELECT COUNT(*) count FROM feedback_comments WHERE status = ?
    `).get(COMMENT_STATUS.pending).count;
  }

  createComment(input, ipAddress) {
    const parentId = validateParentId(input?.parent_id);
    const authorName = validateAuthorName(input?.author_name);
    const authorEmail = validateEmail(input?.author_email);
    const body = validateBody(input?.body);

    if (parentId !== null) {
      try {
        this.approvedTopLevel(parentId);
      } catch (error) {
        if (error.statusCode === 404) throw new FeedbackValidationError('要回复的留言不存在。');
        throw error;
      }
    }

    const createdAt = new Date().toISOString();
    const result = this.database.prepare(`
      INSERT INTO feedback_comments (
        parent_id, author_name, author_email, body, status, created_at, approved_at, ip_address,
        is_admin_reply
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0)
    `).run(
      parentId,
      authorName,
      authorEmail,
      body,
      COMMENT_STATUS.pending,
      createdAt,
      String(ipAddress || '').slice(0, 128),
    );

    return {
      id: Number(result.lastInsertRowid),
      parentId,
      status: COMMENT_STATUS.pending,
      createdAt,
    };
  }

  approveComment(id) {
    const comment = this.getComment(id);
    if (comment.status !== COMMENT_STATUS.pending) {
      throw new FeedbackValidationError('只有待审核留言可以通过。', 409);
    }
    const approvedAt = new Date().toISOString();
    this.database.prepare(`
      UPDATE feedback_comments SET status = ?, approved_at = ? WHERE id = ?
    `).run(COMMENT_STATUS.approved, approvedAt, comment.id);
    return { ...comment, status: COMMENT_STATUS.approved, approved_at: approvedAt };
  }

  rejectComment(id) {
    const comment = this.getComment(id);
    if (![COMMENT_STATUS.pending, COMMENT_STATUS.approved].includes(comment.status)) {
      throw new FeedbackValidationError('该留言已经处于隐藏状态。', 409);
    }
    this.database.prepare(`
      UPDATE feedback_comments SET status = ?, approved_at = NULL WHERE id = ?
    `).run(COMMENT_STATUS.rejected, comment.id);
    return { ...comment, status: COMMENT_STATUS.rejected, approved_at: null };
  }

  createAdminReply(parentId, bodyValue, ipAddress) {
    const parent = this.approvedTopLevel(parentId);
    const body = validateBody(bodyValue);
    const createdAt = new Date().toISOString();
    const result = this.database.prepare(`
      INSERT INTO feedback_comments (
        parent_id, author_name, author_email, body, status, created_at, approved_at, ip_address,
        is_admin_reply
      ) VALUES (?, '站长', NULL, ?, ?, ?, ?, ?, 1)
    `).run(
      parent.id,
      body,
      COMMENT_STATUS.approved,
      createdAt,
      createdAt,
      String(ipAddress || '').slice(0, 128),
    );
    return {
      id: Number(result.lastInsertRowid),
      parentId: parent.id,
      status: COMMENT_STATUS.approved,
      createdAt,
      isAdminReply: true,
    };
  }
}

module.exports = {
  COMMENT_STATUS,
  FeedbackService,
  FeedbackValidationError,
  LIMITS,
  validateAuthorName,
  validateBody,
  validateEmail,
  validateParentId,
};
