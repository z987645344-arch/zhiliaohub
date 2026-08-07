#!/usr/bin/env node
// One-time import of the original eight works and three notes into SQLite + Markdown.
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const Database = require('better-sqlite3');
const { loadConfig } = require('../src/config');
const { initializeDatabase } = require('../src/db');
const { atomicWriteFile } = require('../src/lib/atomic-file');
const { PublishService } = require('../src/services/publish-service');

const MIGRATION_NAME = 'existing-static-content-v1';
const works = [
  ['mix-video', '创作混剪视频', '影像创作', '把音乐、节奏与片段重新编排成一段个人表达。', '把音乐、节奏与片段重新编排成一段个人表达。当前详情页已建立，具体作品与制作记录仍在整理。', '这里将用于记录素材选择、节奏编排和版本复盘。当前文字仅说明页面结构，不代表日志已经发布。'],
  ['ai-music', 'AI音乐作品', 'AI音乐', '记录从旋律构思到生成编曲的声音实验。', '记录从旋律构思到生成编曲的声音实验。当前详情页已建立，试听内容与制作记录仍在整理。', '这里将用于记录旋律方向、生成尝试与编曲调整。当前文字仅说明页面结构，不代表日志已经发布。'],
  ['ai-video', 'AI视频作品', 'AI影像', '用生成式影像探索短片叙事与视觉节奏。', '用生成式影像探索短片叙事与视觉节奏。当前详情页已建立，成片与生成过程仍在整理。', '这里将用于记录镜头设计、生成迭代与剪辑复盘。当前文字仅说明页面结构，不代表日志已经发布。'],
  ['3d-model', '建模作品', '三维建模', '收集角色、场景与物件的三维建模练习。', '收集角色、场景与物件的三维建模练习。当前详情页已建立，模型展示和制作记录仍在整理。', '这里将用于记录造型、材质和场景搭建过程。当前文字仅说明页面结构，不代表日志已经发布。'],
  ['web-design', '网页设计作品', '网页设计', '以信息层级和交互细节打磨网页体验。', '以信息层级和交互细节打磨网页体验。当前详情页已建立，案例画面与设计记录仍在整理。', '这里将用于记录信息架构、视觉推演与响应式取舍。当前文字仅说明页面结构，不代表日志已经发布。'],
  ['zhili', '知历', '软件', '面向个人记录与时间回望的软件作品。', '面向个人记录与时间回望的软件作品。当前只建立展示骨架，功能说明与开发记录仍在整理。', '这里将用于记录产品设想、界面演进与实现复盘。当前文字仅说明页面结构，不代表日志已经发布。'],
  ['zhiliao', '知了', '软件', '围绕个人知识与创作整理的软件作品。', '围绕个人知识与创作整理的软件作品。当前只建立展示骨架，功能说明与开发记录仍在整理。', '这里将用于记录信息整理方式、交互取舍与开发复盘。当前文字仅说明页面结构，不代表日志已经发布。'],
  ['zhitian', '知天', 'AI系统', '企业知识库RAG+Agent系统', '企业知识库RAG+Agent系统。知天与知了hub 保持独立仓库和独立部署，本站当前只提供作品条目与详情占位。', '这里将用于整理知天作为作品的阶段记录。本仓库不包含知天业务逻辑、管理后台、API 或反向代理配置。', 'official_url_pending'],
].map(([slug, title, category, summary, detailIntro, body, specialStatus = null], index) => ({
  slug, title, category, summary, detailIntro, body: `## 工作日志内容筹备中\n\n${body}\n`, specialStatus, displayOrder: index + 1,
}));

const notes = [
  ['rain-window', '2026-08-02', '雨落在窗外的时候', '关于放慢节奏、记录观察与保留思考过程的页面结构示例。', '本页只用于确认日记详情的标题、日期、阅读区域和编辑入口。当前没有真实正文，也不代表这篇日记已经发布。'],
  ['learning-path', '2026-07-28', '把学习路径画成一条线', '用于展示学习复盘类日记的日期、标题与摘要层级。', '本页只用于确认学习复盘类日记的详情结构。当前没有真实正文，也不代表这篇日记已经发布。'],
  ['small-progress', '2026-07-21', '小进展也值得留下', '用于确认短篇记录在列表与详情页中的阅读体验。', '本页只用于确认短篇日记的详情结构。当前没有真实正文，也不代表这篇日记已经发布。'],
].map(([slug, noteDate, title, summary, body], index) => ({
  slug, noteDate, title, summary, body: `## 日记正文筹备中\n\n${body}\n`, displayOrder: index + 1,
}));

function assertServerStopped(config) {
  const host = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: config.port });
    const finish = (error) => {
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(1000, () => finish(new Error(`无法确认 ${host}:${config.port} 已停止：端口探测超时。`)));
    socket.once('connect', () => finish(new Error(`检测到 ${host}:${config.port} 仍有服务监听；请先停止 admin-server。`)));
    socket.once('error', (error) => {
      if (['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'].includes(error.code)) finish();
      else finish(new Error(`无法确认 ${host}:${config.port} 已停止：${error.message}`));
    });
  });
}

function preview(config) {
  let databaseState = '数据库文件尚不存在';
  let canApply = true;
  if (fs.existsSync(config.databasePath)) {
    const database = new Database(config.databasePath, { readonly: true, fileMustExist: true });
    try {
      const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
      if (tables.has('works') && tables.has('notes')) {
        const counts = database.prepare('SELECT (SELECT COUNT(*) FROM works) AS works_count, (SELECT COUNT(*) FROM notes) AS notes_count').get();
        databaseState = `当前数据库：${counts.works_count} 个作品、${counts.notes_count} 篇日记`;
        canApply = counts.works_count === 0 && counts.notes_count === 0;
        if (tables.has('content_migrations') && database.prepare('SELECT 1 FROM content_migrations WHERE name = ?').get(MIGRATION_NAME)) {
          databaseState += '；本迁移已执行';
          canApply = false;
        }
      } else databaseState = '数据库存在，但内容表尚未初始化';
    } finally {
      database.close();
    }
  }
  console.log('仅预览，未写入任何文件或数据库。');
  console.log(databaseState);
  console.log(`计划导入：${works.length} 个作品、${notes.length} 篇日记。`);
  if (canApply) {
    console.log('实际执行前请停止 admin-server，然后运行：');
    console.log('node scripts/migrate-existing-content.js --apply --confirm-server-stopped');
  } else {
    console.log('当前数据库不符合应用前置条件；即使传入 --apply，脚本也会拒绝重复或追加导入。');
  }
}

async function applyMigration(config) {
  const database = initializeDatabase(config);
  const createdMarkdown = [];
  const siteSnapshots = new Map();
  let transactionOpen = false;
  let siteChanged = false;
  try {
    const alreadyApplied = database.prepare('SELECT 1 FROM content_migrations WHERE name = ?').get(MIGRATION_NAME);
    const counts = database.prepare('SELECT (SELECT COUNT(*) FROM works) AS works_count, (SELECT COUNT(*) FROM notes) AS notes_count').get();
    if (alreadyApplied) throw new Error('迁移已执行过，已拒绝重复运行。');
    if (counts.works_count !== 0 || counts.notes_count !== 0) {
      throw new Error(`内容表不是空表（作品 ${counts.works_count}、日记 ${counts.notes_count}），已拒绝覆盖或追加。`);
    }

    const plannedMarkdown = [
      ...works.map((item) => path.join(config.contentDir, 'works', `${item.slug}.md`)),
      ...notes.map((item) => path.join(config.contentDir, 'notes', `${item.slug}.md`)),
    ];
    for (const target of plannedMarkdown) {
      if (fs.existsSync(target)) throw new Error(`目标Markdown文件已存在，已拒绝覆盖：${target}`);
    }

    await fsPromises.mkdir(config.siteRoot, { recursive: true });
    const existingSiteEntries = await fsPromises.readdir(config.siteRoot, { withFileTypes: true });
    const siteNames = new Set([
      'works.html',
      'notes.html',
      ...works.map((item) => `works-${item.slug}.html`),
      ...notes.map((item) => `notes-${item.slug}.html`),
      ...existingSiteEntries
        .filter((entry) => entry.isFile() && /^(?:works|notes)-[a-z0-9-]+\.html$/.test(entry.name))
        .map((entry) => entry.name),
    ]);
    for (const name of siteNames) {
      const target = path.join(config.siteRoot, name);
      siteSnapshots.set(name, fs.existsSync(target) ? await fsPromises.readFile(target) : null);
    }

    database.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const now = new Date().toISOString();
    const insertWork = database.prepare(`
      INSERT INTO works (title, slug, work_date, category, summary, detail_intro, special_status, is_placeholder, display_order, markdown_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `);
    const insertNote = database.prepare(`
      INSERT INTO notes (title, slug, note_date, summary, is_placeholder, display_order, markdown_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
    `);

    for (const item of works) {
      const relativePath = `works/${item.slug}.md`;
      const target = path.join(config.contentDir, 'works', `${item.slug}.md`);
      await atomicWriteFile(target, item.body);
      createdMarkdown.push(target);
      insertWork.run(item.title, item.slug, '2026-08-02', item.category, item.summary, item.detailIntro, item.specialStatus, item.displayOrder, relativePath, now, now);
    }
    for (const item of notes) {
      const relativePath = `notes/${item.slug}.md`;
      const target = path.join(config.contentDir, 'notes', `${item.slug}.md`);
      await atomicWriteFile(target, item.body);
      createdMarkdown.push(target);
      insertNote.run(item.title, item.slug, item.noteDate, item.summary, item.displayOrder, relativePath, now, now);
    }

    const publishService = new PublishService(database, config);
    const publication = await publishService.publishAll();
    siteChanged = true;
    database.prepare('INSERT INTO content_migrations (name, applied_at) VALUES (?, ?)').run(MIGRATION_NAME, now);
    database.exec('COMMIT');
    transactionOpen = false;
    console.log(`迁移完成：${publication.worksCount} 个作品、${publication.notesCount} 篇日记，生成 ${publication.files.length} 个静态页面。`);
  } catch (error) {
    if (transactionOpen) database.exec('ROLLBACK');
    if (siteChanged) {
      const currentEntries = await fsPromises.readdir(config.siteRoot, { withFileTypes: true });
      for (const entry of currentEntries) {
        if (entry.isFile() && /^(?:works|notes)(?:-[a-z0-9-]+)?\.html$/.test(entry.name) && !siteSnapshots.has(entry.name)) {
          await fsPromises.unlink(path.join(config.siteRoot, entry.name)).catch(() => {});
        }
      }
      for (const [name, snapshot] of siteSnapshots) {
        const target = path.join(config.siteRoot, name);
        if (snapshot === null) await fsPromises.unlink(target).catch(() => {});
        else await atomicWriteFile(target, snapshot);
      }
    }
    for (const target of createdMarkdown.reverse()) await fsPromises.unlink(target).catch(() => {});
    throw error;
  } finally {
    database.close();
  }
}

async function main() {
  const config = loadConfig();
  const apply = process.argv.includes('--apply');
  const stopped = process.argv.includes('--confirm-server-stopped');
  if (!apply) return preview(config);
  if (!stopped) throw new Error('缺少 --confirm-server-stopped；请先停止 admin-server，再确认执行。');
  await assertServerStopped(config);
  return applyMigration(config);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`迁移失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { MIGRATION_NAME, applyMigration, assertServerStopped, notes, works };
