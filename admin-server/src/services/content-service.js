// Keeps structured metadata in SQLite while storing bodies as atomically replaced Markdown files.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { atomicWriteFile } = require('../lib/atomic-file');

class ContentValidationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ContentValidationError';
    this.statusCode = statusCode;
  }
}

function requiredText(value, label, maxLength) {
  const text = String(value ?? '').trim();
  if (!text) throw new ContentValidationError(`${label}不能为空。`);
  if (text.length > maxLength) throw new ContentValidationError(`${label}长度不能超过 ${maxLength} 个字符。`);
  return text;
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
    return this.database.prepare('SELECT * FROM works ORDER BY work_date DESC, id DESC').all();
  }

  listNotes() {
    return this.database.prepare('SELECT * FROM notes ORDER BY note_date DESC, id DESC').all();
  }

  async getWork(id) {
    const record = this.database.prepare('SELECT * FROM works WHERE id = ?').get(Number(id));
    if (!record) throw new ContentValidationError('作品不存在。', 404);
    const body = await fs.readFile(safeContentPath(this.config.contentDir, record.markdown_path, 'works'), 'utf8');
    return { ...record, body };
  }

  async getNote(id) {
    const record = this.database.prepare('SELECT * FROM notes WHERE id = ?').get(Number(id));
    if (!record) throw new ContentValidationError('日记不存在。', 404);
    const body = await fs.readFile(safeContentPath(this.config.contentDir, record.markdown_path, 'notes'), 'utf8');
    return { ...record, body };
  }

  async createWork(input) {
    const record = {
      title: requiredText(input.title, '标题', 200),
      workDate: validDate(input.workDate, '作品日期'),
      category: requiredText(input.category, '分类', 100),
      summary: requiredText(input.summary, '摘要', 500),
      body: markdownBody(input.body, this.config.contentMaxBytes),
    };
    const relativePath = `works/${randomUUID()}.md`;
    const targetPath = safeContentPath(this.config.contentDir, relativePath, 'works');
    const now = new Date().toISOString();

    await atomicWriteFile(targetPath, record.body);
    try {
      const result = this.database.prepare(`
        INSERT INTO works (title, work_date, category, summary, markdown_path, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(record.title, record.workDate, record.category, record.summary, relativePath, now, now);
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
    const relativePath = `notes/${randomUUID()}.md`;
    const targetPath = safeContentPath(this.config.contentDir, relativePath, 'notes');
    const now = new Date().toISOString();

    await atomicWriteFile(targetPath, record.body);
    try {
      const result = this.database.prepare(`
        INSERT INTO notes (title, note_date, summary, markdown_path, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(record.title, record.noteDate, record.summary, relativePath, now, now);
      return this.getNote(result.lastInsertRowid);
    } catch (error) {
      await fs.unlink(targetPath).catch(() => {});
      throw error;
    }
  }

  async updateWork(id, input) {
    return this.runSerializedUpdate(`work:${Number(id)}`, async () => {
      const existing = await this.getWork(id);
      const record = {
        title: requiredText(input.title, '标题', 200),
        workDate: validDate(input.workDate, '作品日期'),
        category: requiredText(input.category, '分类', 100),
        summary: requiredText(input.summary, '摘要', 500),
        body: markdownBody(input.body, this.config.contentMaxBytes),
      };
      const targetPath = safeContentPath(this.config.contentDir, existing.markdown_path, 'works');
      await atomicWriteFile(targetPath, record.body);
      try {
        this.database.prepare(`
          UPDATE works SET title = ?, work_date = ?, category = ?, summary = ?, updated_at = ? WHERE id = ?
        `).run(record.title, record.workDate, record.category, record.summary, new Date().toISOString(), Number(id));
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
}

module.exports = { ContentService, ContentValidationError };
