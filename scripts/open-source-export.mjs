// P2-G 开源导出干跑：把"应公开目录"复制到临时目录，跑密钥扫描 + 许可证检查 + 清理项检查，输出报告。
// 只读源仓库；只写临时目录；不 git remote、不 push、不联网。方案见 docs/open-source-split.md。
//
// 用法：node scripts/open-source-export.mjs [--out <dir>] [--json] [--clean] [--skip-deps]
//   --out        导出到指定空目录（默认 os.tmpdir() 下新建）
//   --json       报告以 JSON 输出到 stdout（默认人类可读）
//   --clean      跑完删除临时目录（默认保留以便人工抽查）
//   --skip-deps  跳过第三方依赖许可证检查（pnpm licenses，需要已 pnpm install）
// 退出码：有 FAIL 为 1（例如 AGPL 全文缺失、私有目录混入、命中密钥）；只有 WARN 为 0。
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 进入公开仓库的路径（相对仓库根；目录按前缀匹配，文件精确匹配）。改这里就是改边界。 */
export const PUBLIC_PATHS = [
  'apps/desktop', 'apps/renderer',
  'packages/local', 'packages/kernel', 'packages/plugin-sdk',
  'scripts/secret-scan.mjs', 'scripts/licenses-check.mjs',
  'docs/provider-extension.md', 'docs/licenses.md', 'docs/ffmpeg-lgpl.md', 'docs/kernel-design.md',
  'docs/kernel-conformance.md', 'docs/error-codes.md', 'docs/aigc-marking.md', 'docs/test-matrix.md',
  'docs/open-source-split.md', 'docs/open-source-ci.md', 'docs/upstream',
  'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'README.md',
  'LICENSE', 'LICENSE-LocalMiniDrama', 'CONTRIBUTING.md', 'CLA.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md',
  '.github/public-repo', // 公开仓库专用的 .github 内容；导出时映射为 .github/（见 PATH_MAP），不放进私有仓库自己的 .github/workflows，避免在私有仓库里误触发
];

/** 导出时的路径改写：[源前缀, 目标前缀]。 */
export const PATH_MAP = [['.github/public-repo/', '.github/']];
export const mapPath = (f) => { for (const [a, b] of PATH_MAP) if (f.startsWith(a)) return b + f.slice(a.length); return f; };

/** 绝不能出现在导出结果里的私有路径（防止有人误把它们加进 PUBLIC_PATHS）。 */
export const PRIVATE_PATHS = ['packages/core', 'packages/cloud', 'apps/admin', '.github/workflows/core.yml', '.github/workflows/bailian-live.yml'];

/** 即使在公开目录里也不复制的文件。 */
const EXCLUDE = [/(^|\/)node_modules\//, /(^|\/)\.env(\.|$)/, /\.(db|db-shm|db-wal|sqlite)$/i, /(^|\/)data\//, /(^|\/)release\//, /(^|\/)dist\//];

/** 开源前要人工清理的内容（命中只告警，不阻断）。正则只匹配形态，不打印命中内容。 */
export const CLEANUP_RULES = [
  { id: 'internal-doc-ref', label: '引用内部文档/私有目录', re: /\b(phase[12]-(plan|status)|launch-prereqs|release-signing|tencent-deploy|cloud-deploy|windows-collab|local-session-tasks)\b/ },
  { id: 'private-pkg-ref', label: '引用私有包路径（packages/core、packages/cloud、apps/admin）', re: /packages\/(core|cloud)\b|apps\/admin\b/ },
  { id: 'real-host', label: '真实/第三方域名（自家域名、中转/渠道站等；已知官方厂商域名与 .example 不报）', re: /https?:\/\/(?![a-z0-9.-]*(?:\.example\b|example\.com|localhost|127\.0\.0\.1|0\.0\.0\.0|gnu\.org|apache\.org|opensource\.org|contributor-covenant\.org|github\.com|nodejs\.org|aliyun|alibabacloud|volces|volcengine|byteplus|bytedance|minimax|deepseek|googleapis|klingai|vidu\.|openai\.com|x\.ai)\b)[a-z0-9.-]+\.(?:com|cn|app|net|org|io|ai)\b/i },
  { id: 'public-ip', label: '公网 IPv4 字面量', re: /\b(?!(?:10|127|0)\.)(?!192\.168\.)(?!172\.(?:1[6-9]|2\d|3[01])\.)(?:\d{1,3}\.){3}\d{1,3}\b(?!\.)/ },
  { id: 'price', label: '价格/套餐字样（示例价，公开前确认是否保留）', re: /(?:39|299)\s*(?:元|CNY|RMB)|[¥￥]\s*\d/ },
  { id: 'upstream-owner', label: '上游作者署名（保留 LICENSE-LocalMiniDrama，其余引用需法务看）', re: /xuanyustudio/i },
  { id: 'vendor-lock-config', label: '渠道/外发配置文件引用', re: /ai-configs-(qudao|外发|stary)/ },
];

const ASSET_RE = /\.(png|jpe?g|gif|svg|ico|icns|ttf|otf|woff2?|mp3|mp4|wav)$/i;
const PRIVATE_DEP_RE = /@talekiln\/(core|cloud|admin)\b/;

const norm = (p) => p.split(sep).join('/');
const underAny = (file, paths) => paths.some((p) => file === p || file.startsWith(`${p}/`));

/** 从 git 已跟踪文件里选出应公开的（纯函数，便于测试）。 */
export function selectFiles(tracked, publicPaths = PUBLIC_PATHS, exclude = EXCLUDE) {
  return tracked.filter((f) => underAny(f, publicPaths) && !exclude.some((re) => re.test(f)));
}

/** 对导出文件的文本内容跑清理规则，返回 { ruleId: [file:line,...] }（纯函数）。 */
export function scanCleanup(files, readText, rules = CLEANUP_RULES) {
  const hits = Object.fromEntries(rules.map((r) => [r.id, []]));
  for (const f of files) {
    if (ASSET_RE.test(f) || f === 'pnpm-lock.yaml' || f.startsWith('docs/upstream/')) continue;
    const text = readText(f);
    if (text == null) continue;
    text.split('\n').forEach((line, i) => {
      for (const r of rules) if (r.re.test(line)) hits[r.id].push(`${f}:${i + 1}`);
    });
  }
  return hits;
}

/** 许可证相关检查（纯函数：传入读文件函数和文件列表）。返回 [{level:'FAIL'|'WARN'|'OK', msg}]。 */
export function checkLicenses(files, readText) {
  const out = [];
  const has = (f) => files.includes(f);
  const add = (level, msg) => out.push({ level, msg });

  const lic = has('LICENSE') ? readText('LICENSE') : null;
  if (!lic) add('FAIL', '缺少根目录 LICENSE');
  else if (!/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(lic) || lic.length < 20000) add('FAIL', 'LICENSE 不是 AGPL-3.0 全文（仍是 TODO 占位）：公开前从 https://www.gnu.org/licenses/agpl-3.0.txt 取原文放入，并经法务确认');
  else add('OK', 'LICENSE 含 AGPL-3.0 全文');

  add(has('LICENSE-LocalMiniDrama') ? 'OK' : 'FAIL', has('LICENSE-LocalMiniDrama') ? '保留上游 LICENSE-LocalMiniDrama' : '缺少上游 LICENSE-LocalMiniDrama（MIT 要求保留版权声明）');
  for (const f of ['CONTRIBUTING.md', 'CLA.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md']) if (!has(f)) add('FAIL', `缺少 ${f}`);

  const sdkLic = has('packages/plugin-sdk/LICENSE') ? readText('packages/plugin-sdk/LICENSE') : null;
  if (!sdkLic || !/MIT License/.test(sdkLic)) add('FAIL', 'packages/plugin-sdk 缺少 MIT LICENSE');
  else if (/TODO/.test(sdkLic)) add('WARN', 'packages/plugin-sdk/LICENSE 版权人仍是占位（TODO），需 Jay 确认主体');
  else add('OK', 'plugin-sdk MIT LICENSE 完整');

  for (const f of files.filter((x) => /(^|\/)package\.json$/.test(x))) {
    let pkg;
    try { pkg = JSON.parse(readText(f)); } catch { add('WARN', `${f} 无法解析`); continue; }
    const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
    for (const dep of Object.keys(all || {})) if (PRIVATE_DEP_RE.test(dep)) add('FAIL', `${f} 依赖私有包 ${dep}`);
    const want = f.startsWith('packages/plugin-sdk/') ? 'MIT' : 'AGPL-3.0-only';
    if (f === 'package.json') continue; // 根 package.json 是 private 工作区
    if (pkg.license !== want) add('WARN', `${f} 的 license 字段是 ${JSON.stringify(pkg.license)}，公开版应为 ${want}`);
  }

  const assets = files.filter((f) => ASSET_RE.test(f));
  if (assets.length) add('WARN', `${assets.length} 个图片/字体/媒体素材需逐个确认可再分发的许可（品牌 logo、图标、样图、字体）：${assets.slice(0, 5).join(', ')}${assets.length > 5 ? ' ...' : ''}`);
  if (!has('docs/ffmpeg-lgpl.md')) add('WARN', '缺少 ffmpeg LGPL 说明');
  return out;
}

function parseArgs(argv) {
  const a = { out: null, json: false, clean: false, skipDeps: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--json') a.json = true;
    else if (argv[i] === '--clean') a.clean = true;
    else if (argv[i] === '--skip-deps') a.skipDeps = true;
    else throw new Error(`未知参数 ${argv[i]}`);
  }
  return a;
}

function copyTree(root, files, dest) {
  for (const f of files) {
    const src = join(root, f);
    if (!existsSync(src) || !statSync(src).isFile()) continue;
    const to = join(dest, mapPath(f));
    mkdirSync(dirname(to), { recursive: true });
    cpSync(src, to);
  }
}

export function dryRun({ root = ROOT, out = null, skipDeps = false } = {}) {
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean).map(norm);
  const wanted = selectFiles(tracked);
  const missing = PUBLIC_PATHS.filter((p) => !tracked.some((f) => f === p || f.startsWith(`${p}/`)));
  const base = out ? resolve(out) : mkdtempSync(join(tmpdir(), 'talekiln-oss-'));
  const tree = join(base, 'tree');
  if (existsSync(tree) && statSync(tree).isDirectory() && readdirSync(tree).length) throw new Error(`${tree} 非空，换一个 --out`);
  mkdirSync(tree, { recursive: true });
  copyTree(root, wanted, tree);

  const readText = (f) => { try { return readFileSync(join(tree, mapPath(f)), 'utf8'); } catch { return null; } };
  const findings = [];

  // 1) 边界：私有目录不得混入
  const leaked = wanted.filter((f) => underAny(f, PRIVATE_PATHS));
  findings.push(leaked.length
    ? { level: 'FAIL', msg: `私有路径混入导出：${leaked.slice(0, 5).join(', ')}` }
    : { level: 'OK', msg: `边界检查：${wanted.length} 个文件，无私有路径` });
  if (missing.length) findings.push({ level: 'WARN', msg: `PUBLIC_PATHS 中有尚不存在的项（草案文件未建？）：${missing.join(', ')}` });

  // 2) 密钥扫描：复用仓库自带脚本，在导出树里建临时 git 索引后运行（只 git init + add，无 commit、无 remote）
  let scan = { status: 0, out: '' };
  if (existsSync(join(tree, 'scripts', 'secret-scan.mjs'))) {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    execFileSync('git', ['init', '-q'], { cwd: tree, env });
    execFileSync('git', ['add', '-A'], { cwd: tree, env });
    const r = spawnSync('node', ['scripts/secret-scan.mjs'], { cwd: tree, encoding: 'utf8' });
    scan = { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
    rmSync(join(tree, '.git'), { recursive: true, force: true }); // 导出树不留 .git，避免误当仓库推送
  } else scan = { status: 1, out: 'secret-scan.mjs 未进入导出树' };
  findings.push(scan.status === 0
    ? { level: 'OK', msg: `密钥扫描通过：${scan.out.split('\n').pop()}` }
    : { level: 'FAIL', msg: `密钥扫描失败：\n${scan.out}` });

  // 3) 许可证：仓库文件 + 依赖
  findings.push(...checkLicenses(wanted, readText));
  if (skipDeps) findings.push({ level: 'WARN', msg: '已跳过第三方依赖许可证检查（--skip-deps）' });
  else if (!existsSync(join(root, 'node_modules'))) findings.push({ level: 'WARN', msg: '未 pnpm install，跳过 licenses:check（CI 里要跑）' });
  else {
    const r = spawnSync('node', ['scripts/licenses-check.mjs'], { cwd: root, encoding: 'utf8' });
    const text = `${r.stdout || ''}${r.stderr || ''}`.trim();
    findings.push(r.status === 0 ? { level: 'OK', msg: `依赖许可证：${text.split('\n').pop()}` } : { level: 'FAIL', msg: `依赖许可证检查失败：\n${text}` });
  }

  // 4) 清理项
  const hits = scanCleanup(wanted, readText);
  const cleanup = CLEANUP_RULES.map((r) => ({ id: r.id, label: r.label, count: hits[r.id].length, sample: hits[r.id].slice(0, 8) }));

  const report = {
    generatedAt: new Date().toISOString(),
    root, tree, fileCount: wanted.length,
    excludedPrivate: PRIVATE_PATHS.filter((p) => tracked.some((f) => underAny(f, [p]))),
    findings, cleanup,
    fail: findings.filter((f) => f.level === 'FAIL').length,
    warn: findings.filter((f) => f.level === 'WARN').length,
  };
  writeFileSync(join(base, 'report.json'), JSON.stringify(report, null, 2));
  return { report, base };
}

export function formatReport(r) {
  const L = [];
  L.push('# 开源导出干跑报告（未推送任何内容）', '');
  L.push(`- 导出树：${r.tree}`, `- 文件数：${r.fileCount}`, `- 留在私有仓库的目录：${r.excludedPrivate.join(', ') || '（无）'}`, `- FAIL ${r.fail} / WARN ${r.warn}`, '');
  L.push('## 检查结果');
  for (const f of r.findings) L.push(`- [${f.level}] ${f.msg}`);
  L.push('', '## 需人工清理的内容（命中数；只列位置，不打印内容）');
  for (const c of r.cleanup) {
    L.push(`- ${c.label}：${c.count}${c.count ? `（例：${c.sample.slice(0, 3).join(', ')}）` : ''}`);
  }
  return L.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { report, base } = dryRun({ out: args.out, skipDeps: args.skipDeps });
    console.log(args.json ? JSON.stringify(report, null, 2) : formatReport(report));
    if (args.clean) rmSync(base, { recursive: true, force: true });
    else if (!args.json) console.log(`\n报告 JSON：${join(base, 'report.json')}`);
    process.exit(report.fail ? 1 : 0);
  } catch (e) {
    console.error(`导出干跑失败：${e.message}`);
    process.exit(2);
  }
}
