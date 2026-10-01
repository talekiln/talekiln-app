// 打包桌面端：electron-builder 对 pnpm 提升式 node_modules 的依赖收集不可靠（会漏包或选错同名不同版本，
// 例如 sharp 的平台包、express 4/5、axios 0.21/1.x），所以先用 `pnpm deploy --prod` 生成一份完整、版本正确的依赖树，
// 再在这份副本里运行 electron-builder。输出仍在 apps/desktop/release。
// 用法：node scripts/pack-desktop.mjs [electron-builder 参数，默认 --win]   例：--win --dir
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(root, 'apps', 'desktop');
const stage = path.join(root, '.stage');
const sh = (cmd, args, cwd = root, env = {}) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`);
};

fs.rmSync(stage, { recursive: true, force: true });
sh('pnpm', ['--filter', '@talekiln/desktop', 'deploy', '--legacy', '--prod', stage]);

const pkgFile = path.join(stage, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
pkg.build.electronVersion = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')).devDependencies.electron;
pkg.build.directories = { output: path.join(desktop, 'release') };
pkg.build.files = [...pkg.build.files.filter((f) => !f.startsWith('!**/node_modules/@talekiln/core')), '!node_modules/.pnpm/**', '!node_modules/@talekiln/core/{target,src}/**'];
pkg.build.extraResources = [
  { from: path.join(root, 'apps', 'renderer', 'dist'), to: 'renderer' },
  { from: path.join(root, 'packages', 'core', 'target', 'release', 'lycore.exe'), to: 'lycore/lycore.exe' },
  { from: path.join(desktop, 'resources', 'ffmpeg'), to: 'lycore/ffmpeg' },
];
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));

const args = process.argv.length > 2 ? process.argv.slice(2) : ['--win'];
sh('pnpm', ['exec', 'electron-builder', '--projectDir', stage, ...args], root);
