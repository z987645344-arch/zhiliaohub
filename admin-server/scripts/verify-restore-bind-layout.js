// Docker-only regression probe that executes the real restore directory-swap helper.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { replaceDirectory } = require('../src/services/backup-service');

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

const mode = option('--mode');
const rawTarget = option('--target');
const target = rawTarget ? path.resolve(rawTarget) : '';

async function main() {
  if (!['old', 'new'].includes(mode) || !target) {
    throw new Error('Usage: node verify-restore-bind-layout.js --mode <old|new> --target <directory>');
  }

  const source = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiliaohub-replace-source-'));
  try {
    await fs.writeFile(path.join(source, 'marker.txt'), 'restored-content');
    await fs.writeFile(path.join(target, 'marker.txt'), 'old-content');
    if (mode === 'old') {
      try {
        await replaceDirectory(source, target);
        throw new Error('OLD_LAYOUT_RESULT=UNEXPECTED_REPLACE_SUCCESS');
      } catch (error) {
        if (error.code !== 'EBUSY') throw error;
        console.log(`OLD_LAYOUT_RESULT=${error.code}`);
      }
      return;
    }

    await replaceDirectory(source, target);
    const marker = await fs.readFile(path.join(target, 'marker.txt'), 'utf8');
    if (marker !== 'restored-content') throw new Error(`Unexpected restored marker: ${marker}`);
    console.log('NEW_LAYOUT_RESULT=REPLACE_SUCCESS');
  } finally {
    await fs.rm(source, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
