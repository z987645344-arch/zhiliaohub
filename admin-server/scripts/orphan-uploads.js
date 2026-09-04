// Reports old unreferenced upload-pool files; deletion requires the explicit --delete flag.
const { loadBackupConfig } = require('../src/backup-config');
const { cleanupOrphanUploads } = require('../src/services/orphan-upload-service');

function parseArguments(argv) {
  const unknown = argv.filter((argument) => argument !== '--delete');
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);
  return { delete: argv.includes('--delete') };
}

function printFiles(label, files) {
  console.log(`${label}: ${files.length}`);
  for (const file of files) console.log(`- ${file.archivePath} (${file.size} bytes)`);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const result = await cleanupOrphanUploads(loadBackupConfig(), options);
  console.log(`盘点时间：${result.scannedAt}`);
  console.log(`最小年龄：${result.minimumAgeMs} ms`);
  printFiles('仍被引用', result.referenced);
  printFiles('未引用但仍在保护窗口内', result.recentUnreferenced);
  printFiles('足够旧且未被引用', result.orphans);
  if (!options.delete) {
    console.log('只读模式：未删除任何文件。需要清理时必须显式追加 --delete。');
    return result;
  }
  if (result.backup) console.log(`删除前回退备份：${result.backup.archivePath}`);
  printFiles('已删除', result.deleted);
  printFiles('因状态变化而保留', result.changed);
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArguments };
