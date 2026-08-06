'use strict';

// Reads a password from an interactive terminal without echoing it and prints only its bcrypt hash.
const readline = require('node:readline');
const bcrypt = require('bcrypt');

function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stderr;
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      reject(new Error('必须在交互式终端中运行此工具。'));
      return;
    }

    let value = '';
    readline.emitKeypressEvents(input);
    output.write(prompt);
    input.setRawMode(true);
    input.resume();

    function cleanup() {
      input.removeListener('keypress', onKeypress);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
    }

    function onKeypress(character, key = {}) {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        reject(new Error('操作已取消。'));
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        resolve(value);
        return;
      }
      if (key.name === 'backspace') {
        value = value.slice(0, -1);
        return;
      }
      if (!key.ctrl && !key.meta && character) value += character;
    }

    input.on('keypress', onKeypress);
  });
}

async function main() {
  let password = await readSecret('请输入管理员密码（输入不会显示）：');
  let confirmation = await readSecret('请再次输入以确认：');
  if (!password) throw new Error('密码不能为空。');
  if (password.length > 512) throw new Error('密码不能超过512个字符。');
  if (password !== confirmation) throw new Error('两次输入不一致，未生成哈希。');

  const hash = await bcrypt.hash(password, 12);
  password = null;
  confirmation = null;
  process.stdout.write(`${hash}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
