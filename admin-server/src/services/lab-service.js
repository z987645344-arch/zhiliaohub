const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const unzipper = require('unzipper');
const { createUniqueSlug } = require('../lib/slug');

const ALLOWED_WEB_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.json', '.map', '.txt', '.xml', '.svg',
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.ico',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.wav', '.ogg', '.mp4', '.webm',
]);

class LabValidationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'LabValidationError';
    this.statusCode = statusCode;
  }
}

function validatedId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new LabValidationError('小作坊项目编号无效。');
  return id;
}

function validateText(value, label, { min = 1, max }) {
  const text = String(value || '').trim();
  if (text.length < min || text.length > max) {
    throw new LabValidationError(`${label}长度应为 ${min} 至 ${max} 个字符。`);
  }
  return text;
}

function buildProjectUrl(baseUrl, slug) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(slug))) {
    throw new LabValidationError('小作坊项目 slug 不安全。');
  }
  return `${String(baseUrl).replace(/\/+$/, '')}/${slug}/`;
}

function safeEntry(entry, destinationRoot) {
  const rawName = String(entry.path || '');
  const normalizedName = rawName.replaceAll('\\', '/');
  const isDirectory = entry.type === 'Directory' || normalizedName.endsWith('/');
  const parts = normalizedName.split('/').filter((part) => part !== '');
  if (!normalizedName || normalizedName.includes('\0') || path.posix.isAbsolute(normalizedName)
    || /^[a-z]:/i.test(normalizedName) || parts.some((part) => part === '..' || part === '.')) {
    throw new LabValidationError(`ZIP包含不安全路径，已拒绝整个上传：${rawName}`);
  }
  const unixMode = (Number(entry.externalFileAttributes) >>> 16) & 0xffff;
  if ((unixMode & 0o170000) === 0o120000) {
    throw new LabValidationError(`ZIP不允许包含符号链接：${rawName}`);
  }
  if ((Number(entry.flags) & 0x1) !== 0) {
    throw new LabValidationError(`ZIP不允许包含加密条目：${rawName}`);
  }
  const root = path.resolve(destinationRoot);
  const target = path.resolve(root, ...parts);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new LabValidationError(`ZIP条目试图越过项目目录，已拒绝整个上传：${rawName}`);
  }
  if (!isDirectory) {
    const extension = path.posix.extname(normalizedName).toLowerCase();
    if (!ALLOWED_WEB_EXTENSIONS.has(extension)) {
      throw new LabValidationError(`ZIP包含不允许的文件类型：${rawName}`, 415);
    }
  }
  return { isDirectory, normalizedName, target };
}

async function inspectZip(zipPath, destinationRoot, limits) {
  let fileCount = 0;
  let entryCount = 0;
  let totalBytes = 0;
  let hasRootIndex = false;
  let entries;
  try {
    const directory = await unzipper.Open.file(zipPath);
    entries = directory.files;
    for (const entry of entries) {
      const safe = safeEntry(entry, destinationRoot);
      entryCount += 1;
      if (entryCount > limits.maxFiles) {
        throw new LabValidationError(`ZIP条目数量超过 ${limits.maxFiles} 个上限。`, 413);
      }
      if (safe.isDirectory) continue;
      fileCount += 1;
      totalBytes += Number(entry.uncompressedSize);
      if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxUncompressedBytes) {
        throw new LabValidationError(`ZIP解压后总大小超过 ${limits.maxUncompressedBytes} 字节上限。`, 413);
      }
      if (safe.normalizedName === 'index.html') hasRootIndex = true;
    }
  } catch (error) {
    if (error instanceof LabValidationError) throw error;
    throw new LabValidationError(`ZIP结构无效或已损坏：${error.message}`);
  }
  if (fileCount === 0) throw new LabValidationError('ZIP中没有可发布的网页文件。');
  if (!hasRootIndex) throw new LabValidationError('ZIP根目录必须包含 index.html。');
  return { entries, entryCount, fileCount, totalBytes };
}

async function extractZip(entries, destinationRoot, limits) {
  let extractedBytes = 0;
  for (const entry of entries) {
    const safe = safeEntry(entry, destinationRoot);
    if (safe.isDirectory) {
      await fs.mkdir(safe.target, { recursive: true });
      continue;
    }
    await fs.mkdir(path.dirname(safe.target), { recursive: true });
    let entryBytes = 0;
    const sizeGuard = new Transform({
      transform(chunk, _encoding, callback) {
        entryBytes += chunk.length;
        extractedBytes += chunk.length;
        if (extractedBytes > limits.maxUncompressedBytes) {
          callback(new LabValidationError(`ZIP实际解压大小超过 ${limits.maxUncompressedBytes} 字节上限。`, 413));
          return;
        }
        callback(null, chunk);
      },
    });
    const output = require('node:fs').createWriteStream(safe.target, { flags: 'wx' });
    await pipeline(entry.stream(), sizeGuard, output);
    if (entryBytes !== Number(entry.uncompressedSize)) {
      throw new LabValidationError(`ZIP条目实际大小与目录声明不一致：${entry.path}`);
    }
  }
}

class LabService {
  constructor(database, config) {
    this.database = database;
    this.config = config;
  }

  projectDirectory(slug) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(slug))) {
      throw new LabValidationError('小作坊项目 slug 不安全。');
    }
    const root = path.resolve(this.config.labStorageDir);
    const target = path.resolve(root, String(slug));
    if (path.dirname(target) !== root) throw new LabValidationError('小作坊项目目录不安全。');
    return target;
  }

  projectView(record) {
    return {
      ...record,
      isVisible: Boolean(record.is_visible),
      accessUrl: buildProjectUrl(this.config.labBaseUrl, record.slug),
    };
  }

  listProjects() {
    return this.database.prepare('SELECT * FROM lab_projects ORDER BY updated_at DESC, id DESC')
      .all().map((record) => this.projectView(record));
  }

  listVisibleProjects() {
    return this.database.prepare(`
      SELECT * FROM lab_projects WHERE is_visible = 1 ORDER BY updated_at DESC, id DESC
    `).all().map((record) => this.projectView(record));
  }

  getProject(id) {
    const record = this.database.prepare('SELECT * FROM lab_projects WHERE id = ?').get(validatedId(id));
    if (!record) throw new LabValidationError('小作坊项目不存在。', 404);
    return this.projectView(record);
  }

  async createProject(file, values = {}) {
    if (!file?.path) throw new LabValidationError('请选择一个ZIP文件。');
    let finalDirectory = '';
    let temporaryDirectory = '';
    let movedToFinal = false;
    try {
      const title = validateText(values.title, '标题', { min: 1, max: 120 });
      const description = validateText(values.description, '简介', { min: 1, max: 1000 });
      const originalFilename = validateText(file.originalname, '原始文件名', { min: 1, max: 255 });
      if (path.extname(originalFilename).toLowerCase() !== '.zip') {
        throw new LabValidationError('小作坊只接受ZIP压缩包。', 415);
      }
      const usedSlugs = new Set(this.database.prepare('SELECT slug FROM lab_projects').all().map((row) => row.slug));
      const slug = createUniqueSlug(title, usedSlugs);
      finalDirectory = this.projectDirectory(slug);
      temporaryDirectory = path.join(this.config.labStorageDir, `.pending-${randomUUID()}`);
      await fs.mkdir(this.config.labStorageDir, { recursive: true });
      const limits = {
        maxFiles: this.config.labMaxFiles,
        maxUncompressedBytes: this.config.labMaxUncompressedBytes,
      };
      const inspection = await inspectZip(file.path, temporaryDirectory, limits);
      await fs.mkdir(temporaryDirectory, { recursive: false });
      await extractZip(inspection.entries, temporaryDirectory, limits);
      const rootIndex = await fs.stat(path.join(temporaryDirectory, 'index.html'));
      if (!rootIndex.isFile()) throw new LabValidationError('ZIP根目录的 index.html 不是普通文件。');
      await fs.rename(temporaryDirectory, finalDirectory);
      movedToFinal = true;
      const now = new Date().toISOString();
      const result = this.database.prepare(`
        INSERT INTO lab_projects (
          slug, title, description, original_filename, is_visible, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(slug, title, description, originalFilename, values.isVisible ? 1 : 0, now, now);
      return this.getProject(result.lastInsertRowid);
    } catch (error) {
      const cleanupDirectory = movedToFinal ? finalDirectory : temporaryDirectory;
      if (cleanupDirectory) await fs.rm(cleanupDirectory, { recursive: true, force: true });
      if (error instanceof LabValidationError) throw error;
      throw new LabValidationError(`小作坊项目创建失败：${error.message}`);
    } finally {
      await fs.unlink(file.path).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  toggleVisibility(id) {
    const record = this.getProject(id);
    this.database.prepare('UPDATE lab_projects SET is_visible = ?, updated_at = ? WHERE id = ?')
      .run(record.is_visible ? 0 : 1, new Date().toISOString(), record.id);
    return this.getProject(record.id);
  }

  async deleteProject(id) {
    const record = this.getProject(id);
    const projectDirectory = this.projectDirectory(record.slug);
    const trashDirectory = path.join(this.config.labStorageDir, `.deleted-${randomUUID()}`);
    let moved = false;
    try {
      await fs.rename(projectDirectory, trashDirectory);
      moved = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new LabValidationError(`无法移除小作坊目录：${error.message}`);
    }
    try {
      if (moved) await fs.rm(trashDirectory, { recursive: true, force: true });
      this.database.prepare('DELETE FROM lab_projects WHERE id = ?').run(record.id);
      return record;
    } catch (error) {
      if (moved) await fs.rename(trashDirectory, projectDirectory).catch(() => {});
      if (error instanceof LabValidationError) throw error;
      throw new LabValidationError(`小作坊项目删除失败：${error.message}`);
    }
  }
}

module.exports = {
  ALLOWED_WEB_EXTENSIONS,
  LabService,
  LabValidationError,
  buildProjectUrl,
  inspectZip,
};
