const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWriteFile } = require('../lib/atomic-file');
const { escapeHtml } = require('../lib/html');
const { GENERATED_MARKER } = require('../templates/shared');
const { renderWorksList, renderWorkDetail } = require('../templates/works');
const { renderNotesList, renderNoteDetail } = require('../templates/notes');

class PublishError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'PublishError';
    this.statusCode = 500;
  }
}

function assertSlug(slug) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(slug))) {
    throw new PublishError(`内容 slug 不安全，已拒绝发布：${slug}`);
  }
  return String(slug);
}

function resolveSiteFile(siteRoot, filename) {
  if (!/^(?:works|notes)(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.html$/.test(filename)) {
    throw new PublishError(`发布目标不在允许范围内：${filename}`);
  }
  const root = path.resolve(siteRoot);
  const target = path.resolve(root, filename);
  if (path.dirname(target) !== root) throw new PublishError(`发布目标越过站点根目录：${filename}`);
  return target;
}

async function readOptional(filePath) {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

class PublishService {
  constructor(database, config) {
    this.database = database;
    this.config = config;
    this.queue = Promise.resolve();
  }

  getStatus() {
    return this.database.prepare('SELECT * FROM publish_state WHERE id = 1').get() || null;
  }

  publishAll() {
    const current = this.queue.catch(() => {}).then(async () => {
      try {
        return await this.performPublish();
      } catch (error) {
        if (error instanceof PublishError) throw error;
        throw new PublishError(`全量发布失败：${error.message}`, error);
      }
    });
    this.queue = current;
    return current;
  }

  async loadMarkdown(relativePath, kind) {
    const base = path.resolve(this.config.contentDir, kind);
    const target = path.resolve(this.config.contentDir, String(relativePath).split('/').join(path.sep));
    if (!target.startsWith(`${base}${path.sep}`)) throw new PublishError('Markdown 路径越过内容目录，已拒绝发布。');
    return fs.readFile(target, 'utf8');
  }

  async buildFiles() {
    const { marked, Renderer } = await import('marked');
    const renderer = new Renderer();
    const defaultLink = renderer.link;
    const defaultImage = renderer.image;
    const isSafeUrl = (href) => {
      const protocol = String(href).match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
      return !protocol || ['http', 'https', 'mailto'].includes(protocol);
    };
    renderer.html = ({ text }) => escapeHtml(text);
    renderer.link = function renderSafeLink(token) {
      return isSafeUrl(token.href) ? defaultLink.call(this, token) : escapeHtml(token.text || token.href);
    };
    renderer.image = function renderSafeImage(token) {
      return isSafeUrl(token.href) ? defaultImage.call(this, token) : escapeHtml(token.text || '图片');
    };
    const renderMarkdown = (markdown) => marked.parse(markdown, { renderer });
    const works = this.database.prepare(`
      SELECT * FROM works
      ORDER BY CASE WHEN display_order IS NULL THEN 1 ELSE 0 END, display_order ASC, work_date DESC, id DESC
    `).all();
    const notes = this.database.prepare(`
      SELECT * FROM notes
      ORDER BY CASE WHEN display_order IS NULL THEN 1 ELSE 0 END, display_order ASC, note_date DESC, id DESC
    `).all();
    const files = new Map([
      ['works.html', renderWorksList(works)],
      ['notes.html', renderNotesList(notes)],
    ]);

    for (const [index, work] of works.entries()) {
      const slug = assertSlug(work.slug);
      const markdown = await this.loadMarkdown(work.markdown_path, 'works');
      const prefix = work.is_placeholder ? '<small>WORK LOG / PLACEHOLDER</small>' : '';
      files.set(`works-${slug}.html`, renderWorkDetail(work, `${prefix}${renderMarkdown(markdown)}`, index));
    }
    for (const [index, note] of notes.entries()) {
      const slug = assertSlug(note.slug);
      const markdown = await this.loadMarkdown(note.markdown_path, 'notes');
      const prefix = note.is_placeholder ? '<small>CONTENT / PLACEHOLDER</small>' : '';
      files.set(`notes-${slug}.html`, renderNoteDetail(note, `${prefix}${renderMarkdown(markdown)}`, index));
    }
    return { files, worksCount: works.length, notesCount: notes.length };
  }

  async staleGeneratedFiles(desiredNames) {
    await fs.mkdir(this.config.siteRoot, { recursive: true });
    const entries = await fs.readdir(this.config.siteRoot, { withFileTypes: true });
    const stale = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^(?:works|notes)-[a-z0-9-]+\.html$/.test(entry.name) || desiredNames.has(entry.name)) continue;
      const target = resolveSiteFile(this.config.siteRoot, entry.name);
      const head = (await fs.readFile(target, 'utf8')).slice(0, GENERATED_MARKER.length + 10);
      if (head.startsWith(GENERATED_MARKER)) stale.push(entry.name);
    }
    return stale;
  }

  async performPublish() {
    let build;
    try {
      build = await this.buildFiles();
    } catch (error) {
      if (error instanceof PublishError) throw error;
      throw new PublishError(`生成静态页面失败：${error.message}`, error);
    }

    const desiredNames = new Set(build.files.keys());
    const stale = await this.staleGeneratedFiles(desiredNames);
    const affected = new Set([...desiredNames, ...stale]);
    const snapshots = new Map();
    for (const filename of affected) {
      snapshots.set(filename, await readOptional(resolveSiteFile(this.config.siteRoot, filename)));
    }

    try {
      for (const [filename, html] of build.files) {
        await atomicWriteFile(resolveSiteFile(this.config.siteRoot, filename), html);
      }
      for (const filename of stale) await fs.unlink(resolveSiteFile(this.config.siteRoot, filename));

      const publishedAt = new Date().toISOString();
      this.database.prepare(`
        INSERT INTO publish_state (id, last_published_at, works_count, notes_count)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          last_published_at = excluded.last_published_at,
          works_count = excluded.works_count,
          notes_count = excluded.notes_count
      `).run(publishedAt, build.worksCount, build.notesCount);
      return { publishedAt, worksCount: build.worksCount, notesCount: build.notesCount, files: [...desiredNames] };
    } catch (error) {
      for (const [filename, snapshot] of snapshots) {
        const target = resolveSiteFile(this.config.siteRoot, filename);
        if (snapshot === null) await fs.unlink(target).catch((unlinkError) => {
          if (unlinkError.code !== 'ENOENT') throw unlinkError;
        });
        else await atomicWriteFile(target, snapshot);
      }
      throw new PublishError(`写入静态页面失败，已恢复发布前文件：${error.message}`, error);
    }
  }
}

module.exports = { PublishError, PublishService, resolveSiteFile };
