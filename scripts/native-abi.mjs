// 切换提升式 node_modules 里 better-sqlite3 原生模块的目标运行时。仓库只有一份 better_sqlite3.node，
// pnpm install 装的是 Node 的预编译包（NODE_MODULE_VERSION 141），Electron 39 要 140，两边不能同时满足：
//   node scripts/native-abi.mjs node       跑 pnpm test / dev:web / 本地服务脚本之前
//   node scripts/native-abi.mjs electron   跑 pnpm dev（electron .）之前
// 切回 Node 时必须顺手删掉 @electron/rebuild 留下的 build/Release/.forge-meta：prebuild-install 只换二进制不动
// 这个标记，electron-builder 打包时会据此以为“已经按 Electron 编过”而跳过重编，打出来的包启动即报 ABI 不符
// （2026-10-02 本机实测踩过）。切换完都会在目标运行时里真的 require 一次，失败就退出非零。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
const run = (cmd, args, { shell = false, env = {} } = {}) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell, env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`);
};
const binary = path.join(root, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
const meta = path.join(path.dirname(binary), '.forge-meta');
const checkFile = path.join(os.tmpdir(), 'talekiln-native-check.cjs');
fs.writeFileSync(checkFile, [
  'const p = process.argv[2];',
  "try { require(p); console.log('better-sqlite3 loads under NODE_MODULE_VERSION ' + process.versions.modules); }",
  'catch (e) { console.error(String(e.message).slice(0, 300)); process.exit(1); }',
].join(String.fromCharCode(10)));

if (target === 'node') {
  run('pnpm', ['--filter', '@talekiln/local', 'rebuild', 'better-sqlite3'], { shell: process.platform === 'win32' });
  fs.rmSync(meta, { force: true });
  run(process.execPath, [checkFile, binary]);
} else if (target === 'electron') {
  run('pnpm', ['--filter', '@talekiln/desktop', 'exec', 'electron-rebuild', '-f', '-w', 'better-sqlite3', '-m', '../..'], { shell: process.platform === 'win32' });
  const electronExe = createRequire(path.join(root, 'apps', 'desktop', 'package.json'))('electron');
  run(electronExe, [checkFile, binary], { env: { ELECTRON_RUN_AS_NODE: '1' } });
} else {
  console.error('用法：node scripts/native-abi.mjs <node|electron>');
  process.exit(2);
}
