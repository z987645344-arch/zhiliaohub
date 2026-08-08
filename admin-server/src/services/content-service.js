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

const ALLOWED_CATEGORIES = Object.freeze(['程序', '影视', '生活']);
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

function validateCategory(value) {
  const text = String(value ?? '').trim();
  if (!ALLOWED_CATEGORIES.includes(text)) {
    throw new ContentValidationError('分类必须为：程序、影视、生活之一。');
  }
  return text;
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

function workRecord(input, maxBytes, existing = null) {
  const detailIntro = requiredText(input.detailIntro, '详情页简介', 500);
  const versionLog = markdownBody(
    input.versionLog ?? input.body ?? existing?.version_log ?? existing?.body,
    maxBytes,
  );
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
    category: validateCategory(input.category),
    summary: requiredText(input.summary ?? detailIntro, '摘要', 500),
    detailIntro,
    body: versionLog,
    versionLog,
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
    experienceUrl: validateExperienceUrl(input.experienceUrl ?? existing?.experience_url),
    mainMediaType,
    mainMediaPath,
    gallery: validateWorkGallery(input.gallery ?? existing?.gallery),
  };
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
    return { ...record, body, versionLog: record.version_log || body };
  }

  async getNote(id) {
    const record = this.database.prepare('SELECT * FROM notes WHERE id = ?').get(Number(id));
    if (!record) throw new ContentValidationError('日记不存在。', 404);
    const body = await fs.readFile(safeContentPath(this.config.contentDir, record.markdown_path, 'notes'), 'utf8');
    return { ...record, body };
  }

  async createWork(input) {
    const record = workRecord(input, this.config.contentMaxBytes);
    record.slug = this.uniqueSlug('works', record.title);
    const relativePath = `works/${randomUUID()}.md`;
    const targetPath = safeContentPath(this.config.contentDir, relativePath, 'works');
    const now = new Date().toISOString();

    await atomicWriteFile(targetPath, record.body);
    try {
      const result = this.database.prepare(`
        INSERT INTO works (
          title, slug, work_date, category, summary, detail_intro,
          cover_image, is_downloadable, download_file, experience_url,
          main_media_type, main_media_path, gallery, version_log,
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
        record.mainMediaType,
        record.mainMediaPath,
        record.gallery,
        record.versionLog,
        relativePath,
        now,
        now,
      );
      return this.getWork(result.lastInsertRowid);
    } catch (error) {
      await fs.unlink(targetPath).catch(() => {});
      throw error;
    }
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
    return this.runSerializedUpdate(`work:${Number(id)}`, async () => {
      const existing = await this.getWork(id);
      const record = workRecord(input, this.config.contentMaxBytes, existing);
      const targetPath = safeContentPath(this.config.contentDir, existing.markdown_path, 'works');
      await atomicWriteFile(targetPath, record.body);
      try {
        this.database.prepare(`
          UPDATE works SET
            title = ?, work_date = ?, category = ?, summary = ?, detail_intro = ?,
            cover_image = ?, is_downloadable = ?, download_file = ?, experience_url = ?,
            main_media_type = ?, main_media_path = ?, gallery = ?, version_log = ?, updated_at = ?
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
          record.mainMediaType,
          record.mainMediaPath,
          record.gallery,
          record.versionLog,
          new Date().toISOString(),
          Number(id),
        );
      } catch (error) {
        await atomicWriteFile(targetPath, existing.body);
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

  async deleteWork(id) {
    return this.runSerializedUpdate(`work:${Number(id)}`, async () => {
      const existing = await this.getWork(id);
      const targetPath = safeContentPath(this.config.contentDir, existing.markdown_path, 'works');
      await fs.unlink(targetPath);
      try {
        this.database.prepare('DELETE FROM works WHERE id = ?').run(Number(id));
      } catch (error) {
        await atomicWriteFile(targetPath, existing.body);
        throw error;
      }
      return existing;
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
  ALLOWED_CATEGORIES,
  MEDIA_DIRECTORIES,
  ContentService,
  ContentValidationError,
  safeParseGallery,
  validateCategory,
  validateGallery,
  validateMediaPath,
};
