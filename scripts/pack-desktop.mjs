// 打包桌面端：electron-builder 对 pnpm 提升式 node_modules 的依赖收集不可靠（会漏包或选错同名不同版本，
// 例如 sharp 的平台包、express 4/5、axios 0.21/1.x），所以先用 `pnpm deploy --prod` 生成一份完整、版本正确的依赖树，
// 再在这份副本里运行 electron-builder。输出仍在 apps/desktop/release。
// 用法：node scripts/pack-desktop.mjs [electron-builder 参数，默认跟随宿主平台：Windows --win，macOS --mac --<arch>]   例：--win --dir
// macOS 打包必须在 macOS 上做（dmg、代码签名与公证都依赖 macOS 工具链），lycore 用本机 cargo build --release 的产物（宿主架构）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultBuilderArgs, extraResources, applyMacBuildConfig } from './platform-lib.mjs';

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
// ffmpeg 目录可能为空（macOS 的固定清单仍是 TODO 时）：保证目录存在，打出来的包会在导出时提示“媒体工具缺失”
fs.mkdirSync(path.join(desktop, 'resources', 'ffmpeg'), { recursive: true });
pkg.build.extraResources = extraResources({ root, desktop });
pkg.build = applyMacBuildConfig(pkg.build, { desktop });
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));

const args = process.argv.length > 2 ? process.argv.slice(2) : defaultBuilderArgs();
sh('pnpm', ['exec', 'electron-builder', '--projectDir', stage, ...args], root);
