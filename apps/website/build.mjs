// 官网构建：把 src/ 里的页面做占位符替换后写到 dist/，无第三方依赖。
//
//   node build.mjs                          使用 site.config.json（全是占位值）
//   SITE_CONFIG=/path/to/prod.json node build.mjs   用部署方私有配置覆盖（真实下载地址、哈希、备案号；该文件不要提交）
//
// 模板语法：{{key}} 为转义后的文本；{{{key}}} 为原样输出（仅用于本脚本生成的片段）。key 用点号取嵌套字段，如 downloads.windows.url。
// 引用了不存在的 key 会让构建失败，避免把 "{{...}}" 发布到线上。
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

export const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 深度合并：override 覆盖 base，只合并对象。 */
export function merge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override ?? {})) out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : v;
  return out;
}

/** 链接只允许 https://、站内相对路径或 #锚点；空串表示“暂无”。拒绝 javascript:/data: 等。 */
export function safeUrl(url, field = 'url') {
  const u = String(url ?? '').trim();
  if (u === '') return '';
  if (u.startsWith('#') || /^https:\/\/[^\s"'<>]+$/i.test(u) || /^(?![a-z][a-z0-9+.-]*:)(?!\/\/)[^\s"'<>]+$/i.test(u)) return u;
  throw new Error(`配置项 ${field} 不是允许的链接（只接受 https://、相对路径或 #锚点）：${u.slice(0, 40)}`);
}

export const SHA256_RE = /^[0-9a-f]{64}$/i;

/** 校验并规范化配置；返回渲染用的扁平 + 嵌套数据。 */
export function prepare(config) {
  const c = structuredClone(config);
  if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(String(c.version))) throw new Error(`version 需为语义化版本：${c.version}`);
  for (const k of ['repoUrl', 'privacyUrl', 'termsUrl', 'reportUrl']) c[k] = safeUrl(c[k], k);
  for (const [os, d] of Object.entries(c.downloads ?? {})) {
    d.url = safeUrl(d.url, `downloads.${os}.url`);
    d.sha256 = String(d.sha256 ?? '').trim();
    // 真实哈希必须是 64 位十六进制并统一小写；占位文字原样显示
    if (SHA256_RE.test(d.sha256)) d.sha256 = d.sha256.toLowerCase();
    else if (/^[0-9a-f]+$/i.test(d.sha256)) throw new Error(`downloads.${os}.sha256 看起来是哈希但长度不是 64 位`);
    d.available = d.url !== '' && !d.url.startsWith('#');
    d.hashed = SHA256_RE.test(d.sha256);
  }
  return c;
}

function lookup(data, key) {
  let cur = data;
  for (const part of key.split('.')) {
    if (!isObject(cur) || !(part in cur)) throw new Error(`模板引用了不存在的配置项：${key}`);
    cur = cur[part];
  }
  if (isObject(cur) || Array.isArray(cur)) throw new Error(`模板引用的配置项不是字符串：${key}`);
  return String(cur);
}

export function render(template, data, fragments = {}) {
  return template
    .replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (_, key) => {
      if (!(key in fragments)) throw new Error(`模板引用了不存在的片段：${key}`);
      return fragments[key];
    })
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => escapeHtml(lookup(data, key)));
}

/** 下载表格行：没有链接时显示“即将开放”，不输出空链接。 */
export function downloadRows(c) {
  const rows = [['windows', 'Windows 10 / 11（64 位）'], ['macos', 'macOS（Apple 芯片 / Intel）']];
  return rows.map(([os, label]) => {
    const d = c.downloads?.[os];
    const link = d && d.available
      ? `<a class="btn btn-primary" href="${escapeHtml(d.url)}" rel="noopener">下载 ${escapeHtml(c.version)}</a>`
      : d && d.url.startsWith('#')
        ? `<a class="btn btn-ghost" href="${escapeHtml(d.url)}" aria-disabled="true">下载链接占位</a>`
        : '<span class="btn btn-ghost" aria-disabled="true">即将开放</span>';
    const hash = d && d.sha256 ? `<code class="hash">${escapeHtml(d.sha256)}</code>` : '<span class="muted">—</span>';
    const size = d && d.size ? escapeHtml(d.size) : '—';
    return `<tr><th scope="row">${escapeHtml(label)}</th><td>${link}</td><td>${size}</td><td>${hash}</td></tr>`;
  }).join('\n');
}

export function verifyHint(c) {
  const d = c.downloads?.windows;
  if (!d || !d.hashed) return '<p class="muted">发布后这里会给出安装包的 SHA-256，下载完成后请先校验再运行。</p>';
  return `<p>校验方法（PowerShell）：</p><pre><code>Get-FileHash .\\Talekiln-Setup-${escapeHtml(c.version)}.exe -Algorithm SHA256</code></pre><p>输出的哈希应与上表一致；不一致请不要运行，重新下载。</p>`;
}

export function loadConfig(env = process.env, root = ROOT) {
  const base = JSON.parse(readFileSync(join(root, 'site.config.json'), 'utf8'));
  const override = env.SITE_CONFIG ? JSON.parse(readFileSync(resolve(env.SITE_CONFIG), 'utf8')) : {};
  return prepare(merge(base, override));
}

export function build({ root = ROOT, env = process.env, out = join(root, 'dist') } = {}) {
  const config = loadConfig(env, root);
  const fragments = { downloadRows: downloadRows(config), verifyHint: verifyHint(config) };
  // 公共片段：src/partials/<name>.html 渲染后可在页面里用 {{{name}}} 引用
  const partialsDir = join(root, 'src', 'partials');
  for (const f of readdirSync(partialsDir)) {
    if (f.endsWith('.html')) fragments[f.slice(0, -5)] = render(readFileSync(join(partialsDir, f), 'utf8'), config, fragments);
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const src = join(root, 'src');
  const written = [];
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) continue;
    const f = e.name;
    if (f.endsWith('.html')) writeFileSync(join(out, f), render(readFileSync(join(src, f), 'utf8'), config, fragments));
    else copyFileSync(join(src, f), join(out, f));
    written.push(f);
  }
  return { out, written, config };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = build();
  console.log(`官网已生成到 ${r.out}：${r.written.join(', ')}（版本 ${r.config.version}）`);
}
