const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { atomicWriteFile } = require('../lib/atomic-file');
const { escapeHtml } = require('../lib/html');
const { MEDIA_DIRECTORIES, safeParseGallery } = require('./content-service');
const { buildProjectUrl } = require('./lab-service');
const { GENERATED_MARKER } = require('../templates/shared');
const {
  WORK_CATEGORIES,
  renderWorkCategory,
  renderWorkDetail,
  renderWorksList,
} = require('../templates/works');
const { renderNotesList, renderNoteDetail } = require('../templates/notes');
const { renderFeedbackPage } = require('../templates/feedback');

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
  if (!/^(?:(?:works|notes)(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?|feedback)\.html$/.test(filename)) {
    throw new PublishError(`发布目标不在允许范围内：${filename}`);
  }
  const root = path.resolve(siteRoot);
  const target = path.resolve(root, filename);
  if (path.dirname(target) !== root) throw new PublishError(`发布目标越过站点根目录：${filename}`);
  return target;
}

function resolvePublishedMediaFile(siteRoot, relativePath, expectedDirectory = '') {
  const value = String(relativePath || '').split(path.sep).join('/');
  const directory = expectedDirectory || Object.values(MEDIA_DIRECTORIES).find((candidate) => value.startsWith(candidate));
  if (!directory || !value.startsWith(directory)) throw new PublishError(`媒体发布目标不在允许范围内：${relativePath}`);
  const filename = value.slice(directory.length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename) || path.posix.basename(filename) !== filename) {
    throw new PublishError(`媒体发布文件名不安全：${relativePath}`);
  }
  const directoryPath = path.resolve(siteRoot, ...directory.replace(/\/$/, '').split('/'));
  const target = path.resolve(siteRoot, ...value.split('/'));
  if (path.dirname(target) !== directoryPath) throw new PublishError(`媒体发布目标越过目录：${relativePath}`);
  return target;
}

function resolveUploadSource(uploadsDir, relativePath) {
  const filename = path.posix.basename(String(relativePath).split(path.sep).join('/'));
  const root = path.resolve(uploadsDir);
  const target = path.resolve(root, filename);
  if (path.dirname(target) !== root || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename)) {
    throw new PublishError(`上传源文件名不安全：${relativePath}`);
  }
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

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
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
    const labProjects = this.database.prepare(`
      SELECT * FROM lab_projects
      WHERE is_visible = 1
      ORDER BY updated_at DESC, id DESC
    `).all().map((project) => ({
      ...project,
      accessUrl: buildProjectUrl(this.config.labBaseUrl, project.slug),
    }));
    const approvedComments = this.database.prepare(`
      SELECT id, parent_id, author_name, body, created_at, is_admin_reply
      FROM feedback_comments
      WHERE status = 'approved'
      ORDER BY created_at ASC, id ASC
    `).all();
    const feedbackTopics = [];
    const feedbackTopicsById = new Map();
    for (const comment of approvedComments) {
      if (comment.parent_id !== null) continue;
      const topic = { ...comment, replies: [] };
      feedbackTopics.push(topic);
      feedbackTopicsById.set(comment.id, topic);
    }
    for (const comment of approvedComments) {
      if (comment.parent_id === null) continue;
      feedbackTopicsById.get(comment.parent_id)?.replies.push(comment);
    }
    feedbackTopics.sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id - left.id);
    const files = new Map([
      ['works.html', renderWorksList(works, labProjects)],
      ...WORK_CATEGORIES.map((category) => [
        `works-category-${category.slug}.html`,
        renderWorkCategory(category.name, works),
      ]),
      ['notes.html', renderNotesList(notes)],
      ['feedback.html', renderFeedbackPage(feedbackTopics)],
    ]);
    const mediaFiles = new Map();

    const addMedia = (relativePath, directory) => {
      if (!relativePath) return;
      const normalized = String(relativePath).split(path.sep).join('/');
      resolvePublishedMediaFile(this.config.siteRoot, normalized, directory);
      mediaFiles.set(normalized, resolveUploadSource(this.config.uploadsDir, normalized));
    };

    for (const [index, work] of works.entries()) {
      const slug = assertSlug(work.slug);
      const markdown = await this.loadMarkdown(work.markdown_path, 'works');
      const prefix = work.is_placeholder ? '<small>WORK LOG / PLACEHOLDER</small>' : '';
      files.set(`works-${slug}.html`, renderWorkDetail(work, `${prefix}${renderMarkdown(markdown)}`, index));
      addMedia(work.cover_image, MEDIA_DIRECTORIES.cover);
      addMedia(work.main_media_path, MEDIA_DIRECTORIES.main);
      addMedia(work.download_file, MEDIA_DIRECTORIES.download);
      for (const item of safeParseGallery(work.gallery)) addMedia(item, MEDIA_DIRECTORIES.gallery);
    }
    for (const [index, note] of notes.entries()) {
      const slug = assertSlug(note.slug);
      const markdown = await this.loadMarkdown(note.markdown_path, 'notes');
      const prefix = note.is_placeholder ? '<small>CONTENT / PLACEHOLDER</small>' : '';
      files.set(`notes-${slug}.html`, renderNoteDetail(note, `${prefix}${renderMarkdown(markdown)}`, index));
    }
    return { files, mediaFiles, worksCount: works.length, notesCount: notes.length };
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

  async staleMediaFiles(desiredPaths) {
    const stale = [];
    for (const directory of Object.values(MEDIA_DIRECTORIES)) {
      const directoryPath = path.resolve(this.config.siteRoot, ...directory.replace(/\/$/, '').split('/'));
      await fs.mkdir(directoryPath, { recursive: true });
      const entries = await fs.readdir(directoryPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const relativePath = `${directory}${entry.name}`;
        if (!desiredPaths.has(relativePath)) stale.push(relativePath);
      }
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
    const desiredMediaPaths = new Set(build.mediaFiles.keys());
    const staleMedia = await this.staleMediaFiles(desiredMediaPaths);
    const affected = new Set([...desiredNames, ...stale]);
    const snapshots = new Map();
    for (const filename of affected) {
      snapshots.set(filename, await readOptional(resolveSiteFile(this.config.siteRoot, filename)));
    }

    await fs.mkdir(this.config.dataDir, { recursive: true });
    const mediaRollbackRoot = path.join(this.config.dataDir, `publish-media-rollback-${randomUUID()}`);
    await fs.mkdir(mediaRollbackRoot, { recursive: true });
    const mediaSnapshots = new Map();
    let mediaIndex = 0;
    try {
      for (const relativePath of new Set([...desiredMediaPaths, ...staleMedia])) {
        const target = resolvePublishedMediaFile(this.config.siteRoot, relativePath);
        if (!await fileExists(target)) {
          mediaSnapshots.set(relativePath, null);
          continue;
        }
        const backupPath = path.join(mediaRollbackRoot, String(mediaIndex));
        mediaIndex += 1;
        await fs.copyFile(target, backupPath);
        mediaSnapshots.set(relativePath, backupPath);
      }
      for (const [relativePath, source] of build.mediaFiles) {
        const target = resolvePublishedMediaFile(this.config.siteRoot, relativePath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(source, target);
      }
      for (const relativePath of staleMedia) {
        await fs.unlink(resolvePublishedMediaFile(this.config.siteRoot, relativePath));
      }
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
      return {
        publishedAt,
        worksCount: build.worksCount,
        notesCount: build.notesCount,
        files: [...desiredNames],
        mediaFiles: [...desiredMediaPaths],
      };
    } catch (error) {
      for (const [relativePath, snapshot] of mediaSnapshots) {
        const target = resolvePublishedMediaFile(this.config.siteRoot, relativePath);
        if (snapshot === null) await fs.unlink(target).catch((unlinkError) => {
          if (unlinkError.code !== 'ENOENT') throw unlinkError;
        });
        else {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.copyFile(snapshot, target);
        }
      }
      for (const [filename, snapshot] of snapshots) {
        const target = resolveSiteFile(this.config.siteRoot, filename);
        if (snapshot === null) await fs.unlink(target).catch((unlinkError) => {
          if (unlinkError.code !== 'ENOENT') throw unlinkError;
        });
        else await atomicWriteFile(target, snapshot);
      }
      throw new PublishError(`写入静态页面或媒体失败，已恢复发布前文件：${error.message}`, error);
    } finally {
      await fs.rm(mediaRollbackRoot, { recursive: true, force: true });
    }
  }
}

module.exports = {
  PublishError,
  PublishService,
  resolvePublishedMediaFile,
  resolveSiteFile,
};
