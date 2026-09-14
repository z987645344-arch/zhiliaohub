// Keeps structured metadata in SQLite while storing bodies as atomically replaced Markdown files.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { atomicWriteFile } = require('../lib/atomic-file');
const { createUniqueSlug } = require('../lib/slug');

class ContentValidationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ContentValidationError';
    this.statusCode = statusCode;
  }
}

const IMAGE_EXTENSIONS = Object.freeze(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);
const VIDEO_EXTENSIONS = Object.freeze(['.mp4', '.webm']);
const MEDIA_DIRECTORIES = Object.freeze({
  cover: 'assets/works/covers/',
  download: 'assets/works/downloads/',
  gallery: 'assets/works/gallery/',
  main: 'assets/works/main/',
});

function requiredText(value, label, maxLength) {
  const text = String(value ?? '').trim();
  if (!text) throw new ContentValidationError(`${label}不能为空。`);
  if (text.length > maxLength) throw new ContentValidationError(`${label}长度不能超过 ${maxLength} 个字符。`);
  return text;
}

function validateCategory(value, database) {
  const name = requiredText(value, '作品分组', 100);
  if (!database?.prepare('SELECT 1 FROM work_categories WHERE name = ?').get(name)) {
    throw new ContentValidationError('所选作品分组不存在，请先创建分组。');
  }
  return name;
}

function validateCategorySlug(value) {
  const slug = requiredText(value, 'URL标识', 100);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new ContentValidationError('URL标识只能使用小写字母、数字和单个连字符，且不能以连字符开头或结尾。');
  }
  return slug;
}

function integerField(value, label, fallback = 0) {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  if (!/^-?\d+$/.test(text)) throw new ContentValidationError(`${label}必须为整数。`);
  const number = Number(text);
  if (!Number.isSafeInteger(number)) throw new ContentValidationError(`${label}超出有效范围。`);
  return number;
}

function categoryRecord(input, existing = null) {
  return {
    name: requiredText(input.name ?? existing?.name, '分组名', 100),
    slug: validateCategorySlug(input.slug ?? existing?.slug),
    kicker: requiredText(input.kicker ?? existing?.kicker, '分类页副标题', 120),
    intro: requiredText(input.intro ?? existing?.intro, '分类页导语', 500),
    emptyText: requiredText(input.emptyText ?? existing?.empty_text, '空状态文案', 500),
    displayOrder: integerField(input.displayOrder ?? existing?.display_order, '排序值'),
    isVisible: booleanFlag(input.isVisible, existing ? Boolean(existing.is_visible) : true),
  };
}

function validateGallery(value) {
  if (value === undefined || value === null || value === '') return null;
  let gallery;
  try {
    gallery = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    throw new ContentValidationError('辅图列表格式无效。');
  }
  if (!Array.isArray(gallery)) {
    throw new ContentValidationError('辅图列表必须为数组。');
  }
  const normalized = gallery.map((item) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new ContentValidationError('辅图列表中的每一项都必须是非空路径。');
    }
    return item.trim();
  });
  return normalized.length > 0 ? JSON.stringify(normalized) : null;
}

function safeParseGallery(value) {
  if (!value) return [];
  try {
    const gallery = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(gallery)) return [];
    if (!gallery.every((item) => typeof item === 'string' && item.trim())) return [];
    return gallery.map((item) => item.trim());
  } catch {
    return [];
  }
}

function optionalText(value, label, maxLength) {
  const text = String(value ?? '').trim();
  if (text.length > maxLength) throw new ContentValidationError(`${label}长度不能超过 ${maxLength} 个字符。`);
  return text || null;
}

function validateMediaPath(value, label, directory, allowedExtensions) {
  const text = optionalText(value, label, 500);
  if (!text) return null;
  const filename = text.slice(directory.length);
  const extension = path.posix.extname(filename).toLowerCase();
  if (!text.startsWith(directory)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename)
    || path.posix.basename(filename) !== filename
    || !allowedExtensions.includes(extension)) {
    throw new ContentValidationError(`${label}不是有效的已上传文件路径。`);
  }
  return text;
}

function validateMainMediaType(value) {
  const text = String(value ?? 'image').trim() || 'image';
  if (!['image', 'video'].includes(text)) {
    throw new ContentValidationError('主媒体类型必须为图片或视频。');
  }
  return text;
}

function validateExperienceUrl(value) {
  const text = optionalText(value, '体验链接', 2000);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
  } catch {
    throw new ContentValidationError('体验链接必须是有效的 HTTP 或 HTTPS 地址。');
  }
  return text;
}

function booleanFlag(value, fallback = false) {
  if (value === undefined) return fallback ? 1 : 0;
  const candidate = Array.isArray(value) ? value.at(-1) : value;
  return candidate === true || candidate === 1 || candidate === '1' || candidate === 'on' ? 1 : 0;
}

function validateWorkGallery(value) {
  const serialized = validateGallery(value);
  if (!serialized) return null;
  const normalized = JSON.parse(serialized).map((item) => validateMediaPath(
    item,
    '辅图',
    MEDIA_DIRECTORIES.gallery,
    [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS],
  ));
  return JSON.stringify(normalized);
}

function workRecord(input, database, existing = null) {
  const detailIntro = requiredText(input.detailIntro, '详情页简介', 500);
  const experienceUrl = validateExperienceUrl(input.experienceUrl ?? existing?.experience_url);
  const showOnTools = booleanFlag(input.showOnTools, Boolean(existing?.show_on_tools));
  if (showOnTools && !experienceUrl) {
    throw new ContentValidationError('在智能工具页显示作品时必须填写体验链接。');
  }
  const mainMediaType = validateMainMediaType(input.mainMediaType ?? existing?.main_media_type);
  const mainMediaPath = validateMediaPath(
    input.mainMediaPath ?? existing?.main_media_path,
    '主媒体',
    MEDIA_DIRECTORIES.main,
    mainMediaType === 'video' ? VIDEO_EXTENSIONS : IMAGE_EXTENSIONS,
  );
  return {
    title: requiredText(input.title, '标题', 200),
    workDate: validDate(input.workDate, '作品日期'),
    category: validateCategory(input.category ?? existing?.category, database),
    summary: requiredText(input.summary ?? detailIntro, '摘要', 500),
    detailIntro,
    coverImage: validateMediaPath(
      input.coverImage ?? existing?.cover_image,
      '封面图',
      MEDIA_DIRECTORIES.cover,
      IMAGE_EXTENSIONS,
    ),
    isDownloadable: booleanFlag(input.isDownloadable, Boolean(existing?.is_downloadable)),
    downloadFile: validateMediaPath(
      input.downloadFile ?? existing?.download_file,
      '下载文件',
      MEDIA_DIRECTORIES.download,
      ['.zip'],
    ),
    experienceUrl,
    showOnTools,
    mainMediaType,
    mainMediaPath,
    gallery: validateWorkGallery(input.gallery ?? existing?.gallery),
  };
}

function workUpdateRecord(input, maxBytes) {
  const localValue = requiredText(input.recordedAt, '记录时间', 40);
  const match = localValue.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) throw new ContentValidationError('记录时间必须使用有效的日期和时间。');
  const [, year, month, day, hour, minute, second = '00'] = match;
  const utcMs = Date.UTC(
    Number(year), Number(month) - 1, Number(day), Number(hour) - 8, Number(minute), Number(second),
  );
  const recordedAt = new Date(utcMs);
  const roundTrip = new Date(recordedAt.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19);
  if (Number.isNaN(recordedAt.getTime())
    || roundTrip !== `${year}-${month}-${day}T${hour}:${minute}:${second}`) {
    throw new ContentValidationError('记录时间必须使用有效的日期和时间。');
  }
  return {
    recordedAt: recordedAt.toISOString(),
    body: markdownBody(input.body, maxBytes),
  };
}

function workUpdatesMarkdown(updates) {
  if (updates.length === 0) return '# 更新记录\n\n暂无更新记录。\n';
  return updates.map((update) => {
    const recordedAt = new Date(update.recorded_at);
    const localTime = Number.isNaN(recordedAt.getTime())
      ? String(update.recorded_at)
      : `${new Date(recordedAt.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC+8`;
    return `## ${localTime}\n\n${String(update.body).trimEnd()}\n`;
  }).join('\n');
}

function validDate(value, label) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new ContentValidationError(`${label}必须使用 YYYY-MM-DD 格式。`);
  }
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new ContentValidationError(`${label}不是有效日期。`);
  }
  return text;
}

function markdownBody(value, maxBytes) {
  const body = String(value ?? '').replaceAll('\r\n', '\n');
  if (!body.trim()) throw new ContentValidationError('Markdown正文不能为空。');
  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    throw new ContentValidationError(`Markdown正文不能超过 ${maxBytes} 字节。`, 413);
  }
  return body.endsWith('\n') ? body : `${body}\n`;
}

function safeContentPath(contentDir, relativePath, expectedDirectory) {
  const normalized = String(relativePath).split('/').join(path.sep);
  const base = path.resolve(contentDir, expectedDirectory);
  const target = path.resolve(contentDir, normalized);
  if (!target.startsWith(`${base}${path.sep}`)) {
    throw new Error('Stored Markdown path escaped its content directory.');
  }
  return target;
}

class ContentService {
  constructor(database, config) {
    this.database = database;
    this.config = config;
    this.updateQueues = new Map();
  }

  runSerializedUpdate(key, operation) {
    const previous = this.updateQueues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.updateQueues.set(key, current);
    return current.finally(() => {
      if (this.updateQueues.get(key) === current) this.updateQueues.delete(key);
    });
  }

  listWorks() {
    return this.database.prepare(`
      SELECT * FROM works
      ORDER BY CASE WHEN display_order IS NULL THEN 1 ELSE 0 END, display_order ASC, work_date DESC, id DESC
    `).all();
  }

  listWorkUpdates(workId) {
    return this.database.prepare(`
      SELECT id, work_id, recorded_at, body, created_at
      FROM work_updates
      WHERE work_id = ?
      ORDER BY recorded_at DESC, id DESC
    `).all(Number(workId));
  }

  listCategories({ visibleOnly = false } = {}) {
    return this.database.prepare(`
      SELECT category.*, COUNT(works.id) AS work_count
      FROM work_categories AS category
      LEFT JOIN works ON works.category = category.name
      ${visibleOnly ? 'WHERE category.is_visible = 1' : ''}
      GROUP BY category.id
      ORDER BY category.display_order ASC, category.id ASC
    `).all();
  }

  getCategory(id) {
    const category = this.database.prepare(`
      SELECT category.*, COUNT(works.id) AS work_count
      FROM work_categories AS category
      LEFT JOIN works ON works.category = category.name
      WHERE category.id = ?
      GROUP BY category.id
    `).get(Number(id));
    if (!category) throw new ContentValidationError('作品分组不存在。', 404);
    return category;
  }

  assertCategoryUnique(record, excludedId = null) {
    const suffix = excludedId === null ? '' : ' AND id <> ?';
    const parameters = excludedId === null ? [record.name] : [record.name, Number(excludedId)];
    if (this.database.prepare(`SELECT 1 FROM work_categories WHERE name = ?${suffix}`).get(...parameters)) {
      throw new ContentValidationError('分组名已存在，请使用其他名称。');
    }
    parameters[0] = record.slug;
    if (this.database.prepare(`SELECT 1 FROM work_categories WHERE slug = ?${suffix}`).get(...parameters)) {
      throw new ContentValidationError('URL标识已存在，请使用其他标识。');
    }
  }

  createCategory(input) {
    const record = categoryRecord(input);
    this.assertCategoryUnique(record);
    const now = new Date().toISOString();
    const result = this.database.prepare(`
      INSERT INTO work_categories (
        name, slug, kicker, intro, empty_text, display_order, is_visible, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.name,
      record.slug,
      record.kicker,
      record.intro,
      record.emptyText,
      record.displayOrder,
      record.isVisible,
      now,
      now,
    );
    return this.getCategory(result.lastInsertRowid);
  }

  updateCategory(id, input) {
    const existing = this.getCategory(id);
    const record = categoryRecord(input, existing);
    this.assertCategoryUnique(record, existing.id);
    this.database.prepare(`
      UPDATE work_categories SET
        name = ?, slug = ?, kicker = ?, intro = ?, empty_text = ?,
        display_order = ?, is_visible = ?, updated_at = ?
      WHERE id = ?
    `).run(
      record.name,
      record.slug,
      record.kicker,
      record.intro,
      record.emptyText,
      record.displayOrder,
      record.isVisible,
      new Date().toISOString(),
      existing.id,
    );
    return this.getCategory(existing.id);
  }

  listNotes() {
    return this.database.prepare(`
      SELECT * FROM notes
      ORDER BY CASE WHEN display_order IS NULL THEN 1 ELSE 0 END, display_order ASC, note_date DESC, id DESC
    `).all();
  }

  uniqueSlug(tableName, title) {
    const used = new Set(this.database.prepare(`SELECT slug FROM ${tableName} WHERE slug IS NOT NULL`).all().map((row) => row.slug));
    return createUniqueSlug(title, used);
  }

  async getWork(id) {
    const record = this.database.prepare('SELECT * FROM works WHERE id = ?').get(Number(id));
    if (!record) throw new ContentValidationError('作品不存在。', 404);
    const body = await fs.readFile(safeContentPath(this.config.contentDir, record.markdown_path, 'works'), 'utf8');
    return {
      ...record,
      body,
      updates: this.listWorkUpdates(record.id),
    };
  }

  async getNote(id) {
    const record = this.database.prepare('SELECT * FROM notes WHERE id = ?').get(Number(id));
    if (!record) throw new ContentValidationError('日记不存在。', 404);
    const body = await fs.readFile(safeContentPath(this.config.contentDir, record.markdown_path, 'notes'), 'utf8');
    return { ...record, body };
  }

  async createWork(input) {
    return this.runSerializedUpdate('works:all', async () => {
      const record = workRecord(input, this.database);
      record.slug = this.uniqueSlug('works', record.title);
      const relativePath = `works/${randomUUID()}.md`;
      const targetPath = safeContentPath(this.config.contentDir, relativePath, 'works');
      const now = new Date().toISOString();

      await atomicWriteFile(targetPath, workUpdatesMarkdown([]));
      try {
        const result = this.database.prepare(`
          INSERT INTO works (
            title, slug, work_date, category, summary, detail_intro,
            cover_image, is_downloadable, download_file, experience_url,
            show_on_tools,
            main_media_type, main_media_path, gallery,
            markdown_path, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          record.title,
          record.slug,
          record.workDate,
          record.category,
          record.summary,
          record.detailIntro,
          record.coverImage,
          record.isDownloadable,
          record.downloadFile,
          record.experienceUrl,
          record.showOnTools,
          record.mainMediaType,
          record.mainMediaPath,
          record.gallery,
          relativePath,
          now,
          now,
        );
        return this.getWork(result.lastInsertRowid);
      } catch (error) {
        await fs.unlink(targetPath).catch(() => {});
        throw error;
      }
    });
  }

  async createNote(input) {
    const record = {
      title: requiredText(input.title, '标题', 200),
      noteDate: validDate(input.noteDate, '日记日期'),
      summary: requiredText(input.summary, '摘要', 500),
      body: markdownBody(input.body, this.config.contentMaxBytes),
    };
    record.slug = this.uniqueSlug('notes', record.title);
    const relativePath = `notes/${randomUUID()}.md`;
    const targetPath = safeContentPath(this.config.contentDir, relativePath, 'notes');
    const now = new Date().toISOString();

    await atomicWriteFile(targetPath, record.body);
    try {
      const result = this.database.prepare(`
        INSERT INTO notes (title, slug, note_date, summary, markdown_path, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(record.title, record.slug, record.noteDate, record.summary, relativePath, now, now);
      return this.getNote(result.lastInsertRowid);
    } catch (error) {
      await fs.unlink(targetPath).catch(() => {});
      throw error;
    }
  }

  async updateWork(id, input) {
    return this.runSerializedUpdate('works:all', async () => {
      const existing = await this.getWork(id);
      const record = workRecord(input, this.database, existing);
      try {
        this.database.prepare(`
          UPDATE works SET
            title = ?, work_date = ?, category = ?, summary = ?, detail_intro = ?,
            cover_image = ?, is_downloadable = ?, download_file = ?, experience_url = ?,
            show_on_tools = ?,
            main_media_type = ?, main_media_path = ?, gallery = ?, updated_at = ?
          WHERE id = ?
        `).run(
          record.title,
          record.workDate,
          record.category,
          record.summary,
          record.detailIntro,
          record.coverImage,
          record.isDownloadable,
          record.downloadFile,
          record.experienceUrl,
          record.showOnTools,
          record.mainMediaType,
          record.mainMediaPath,
          record.gallery,
          new Date().toISOString(),
          Number(id),
        );
      } catch (error) {
        throw error;
      }
      return this.getWork(id);
    });
  }

  async updateNote(id, input) {
    return this.runSerializedUpdate(`note:${Number(id)}`, async () => {
      const existing = await this.getNote(id);
      const record = {
        title: requiredText(input.title, '标题', 200),
        noteDate: validDate(input.noteDate, '日记日期'),
        summary: requiredText(input.summary, '摘要', 500),
        body: markdownBody(input.body, this.config.contentMaxBytes),
      };
      const targetPath = safeContentPath(this.config.contentDir, existing.markdown_path, 'notes');
      await atomicWriteFile(targetPath, record.body);
      try {
        this.database.prepare(`
          UPDATE notes SET title = ?, note_date = ?, summary = ?, updated_at = ? WHERE id = ?
        `).run(record.title, record.noteDate, record.summary, new Date().toISOString(), Number(id));
      } catch (error) {
        await atomicWriteFile(targetPath, existing.body);
        throw error;
      }
      return this.getNote(id);
    });
  }

  async createWorkUpdate(workId, input) {
    return this.runSerializedUpdate('works:all', async () => {
      const work = await this.getWork(workId);
      const record = workUpdateRecord(input, this.config.contentMaxBytes);
      const now = new Date().toISOString();
      const writeDatabase = this.database.transaction(() => {
        const result = this.database.prepare(`
          INSERT INTO work_updates (work_id, recorded_at, body, created_at)
          VALUES (?, ?, ?, ?)
        `).run(work.id, record.recordedAt, record.body, now);
        this.database.prepare('UPDATE works SET updated_at = ? WHERE id = ?').run(now, work.id);
        return result.lastInsertRowid;
      });
      const updateId = writeDatabase();
      const targetPath = safeContentPath(this.config.contentDir, work.markdown_path, 'works');
      try {
        await atomicWriteFile(targetPath, workUpdatesMarkdown(this.listWorkUpdates(work.id)));
      } catch (error) {
        this.database.transaction(() => {
          this.database.prepare('DELETE FROM work_updates WHERE id = ?').run(updateId);
          this.database.prepare('UPDATE works SET updated_at = ? WHERE id = ?').run(work.updated_at, work.id);
        })();
        await atomicWriteFile(targetPath, work.body);
        throw error;
      }
      return this.database.prepare('SELECT * FROM work_updates WHERE id = ?').get(updateId);
    });
  }

  async deleteWorkUpdate(workId, updateId) {
    return this.runSerializedUpdate('works:all', async () => {
      const work = await this.getWork(workId);
      const update = this.database.prepare(`
        SELECT * FROM work_updates WHERE id = ? AND work_id = ?
      `).get(Number(updateId), work.id);
      if (!update) throw new ContentValidationError('更新记录不存在或不属于该作品。', 404);
      const now = new Date().toISOString();
      this.database.transaction(() => {
        this.database.prepare('DELETE FROM work_updates WHERE id = ?').run(update.id);
        this.database.prepare('UPDATE works SET updated_at = ? WHERE id = ?').run(now, work.id);
      })();
      const targetPath = safeContentPath(this.config.contentDir, work.markdown_path, 'works');
      try {
        await atomicWriteFile(targetPath, workUpdatesMarkdown(this.listWorkUpdates(work.id)));
      } catch (error) {
        this.database.transaction(() => {
          this.database.prepare(`
            INSERT INTO work_updates (id, work_id, recorded_at, body, created_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(update.id, update.work_id, update.recorded_at, update.body, update.created_at);
          this.database.prepare('UPDATE works SET updated_at = ? WHERE id = ?').run(work.updated_at, work.id);
        })();
        await atomicWriteFile(targetPath, work.body);
        throw error;
      }
      return update;
    });
  }

  async deleteWork(id) {
    return this.runSerializedUpdate('works:all', async () => {
      const existing = await this.getWork(id);
      await this.deleteWorkRecords([existing], () => {
        this.database.prepare('DELETE FROM works WHERE id = ?').run(Number(id));
      });
      return existing;
    });
  }

  async deleteWorkRecords(records, deleteDatabaseRows) {
    const removed = [];
    try {
      for (const record of records) {
        const targetPath = safeContentPath(this.config.contentDir, record.markdown_path, 'works');
        await fs.unlink(targetPath);
        removed.push({ targetPath, body: record.body });
      }
      deleteDatabaseRows();
    } catch (error) {
      for (const snapshot of removed) await atomicWriteFile(snapshot.targetPath, snapshot.body);
      throw error;
    }
  }

  async deleteCategory(id, { confirmed = false, expectedWorkCount } = {}) {
    return this.runSerializedUpdate('works:all', async () => {
      const category = this.getCategory(id);
      if (!confirmed) {
        throw new ContentValidationError(`删除分组前必须确认将连带删除 ${category.work_count} 条作品。`);
      }
      const expected = integerField(expectedWorkCount, '确认时的作品数量', -1);
      if (expected !== category.work_count) {
        throw new ContentValidationError(`该分组现有 ${category.work_count} 条作品，与确认时数量不一致，请刷新页面后重新确认。`, 409);
      }
      const rows = this.database.prepare('SELECT id FROM works WHERE category = ? ORDER BY id').all(category.name);
      const works = [];
      for (const row of rows) works.push(await this.getWork(row.id));
      const removeRows = this.database.transaction(() => {
        const removeWork = this.database.prepare('DELETE FROM works WHERE id = ?');
        for (const work of works) removeWork.run(work.id);
        const result = this.database.prepare('DELETE FROM work_categories WHERE id = ?').run(category.id);
        if (result.changes !== 1) throw new ContentValidationError('作品分组不存在。', 404);
      });
      await this.deleteWorkRecords(works, removeRows);
      return { ...category, deletedWorks: works };
    });
  }

  async deleteNote(id) {
    return this.runSerializedUpdate(`note:${Number(id)}`, async () => {
      const existing = await this.getNote(id);
      const targetPath = safeContentPath(this.config.contentDir, existing.markdown_path, 'notes');
      await fs.unlink(targetPath);
      try {
        this.database.prepare('DELETE FROM notes WHERE id = ?').run(Number(id));
      } catch (error) {
        await atomicWriteFile(targetPath, existing.body);
        throw error;
      }
      return existing;
    });
  }
}

module.exports = {
  MEDIA_DIRECTORIES,
  ContentService,
  ContentValidationError,
  categoryRecord,
  safeParseGallery,
  validateCategory,
  validateCategorySlug,
  validateGallery,
  validateMediaPath,
  workUpdateRecord,
  workUpdatesMarkdown,
};
