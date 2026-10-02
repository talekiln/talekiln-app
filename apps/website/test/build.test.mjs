import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build, downloadRows, escapeHtml, loadConfig, merge, prepare, render, safeUrl } from '../build.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HASH = 'ab'.repeat(32);
const tmp = () => mkdtempSync(join(tmpdir(), 'tk-site-'));
const cfg = (o = {}) => prepare(merge(JSON.parse(readFileSync(join(ROOT, 'site.config.json'), 'utf8')), o));

test('默认配置可构建，产出全部页面，且不残留未替换的占位符', () => {
  const out = tmp();
  const r = build({ root: ROOT, env: {}, out });
  assert.deepEqual(readdirSync(out).sort(), ['download.html', 'index.html', 'privacy.html', 'report.html', 'style.css', 'terms.html']);
  for (const f of r.written.filter((x) => x.endsWith('.html'))) {
    const html = readFileSync(join(out, f), 'utf8');
    assert.equal(/\{\{/.test(html), false, `${f} 有未替换的占位符`);
    assert.match(html, /<html lang="zh-CN">/);
    assert.match(html, /<meta name="viewport"/);
    assert.match(html, /<title>[^<]+<\/title>/);
  }
});

test('内容：产品介绍关键词、法务/举报/开源入口、备案号占位都在', () => {
  const out = tmp();
  build({ root: ROOT, env: {}, out });
  const index = readFileSync(join(out, 'index.html'), 'utf8');
  for (const w of ['故事窑', 'Talekiln', '剧本', '镜头', '时间线', '画布', '无缝', '自带 Key', '本地处理']) assert.ok(index.includes(w), w);
  assert.match(index, /href="privacy\.html"/);
  assert.match(index, /href="terms\.html"/);
  assert.match(index, /href="report\.html"/);
  assert.match(index, /href="#repo-placeholder"/);
  assert.match(index, /ICP 备案号占位/);
  const dl = readFileSync(join(out, 'download.html'), 'utf8');
  assert.match(dl, /download-windows-placeholder/);
  assert.match(dl, /即将开放/, 'macOS 无链接时显示即将开放');
});

test('不引用任何外部资源：无 CDN 脚本、无外链样式/图片/字体，页面里也没有 http 地址', () => {
  const out = tmp();
  build({ root: ROOT, env: {}, out });
  for (const f of readdirSync(out)) {
    const text = readFileSync(join(out, f), 'utf8');
    assert.equal(/<script/i.test(text), false, `${f} 含 script`);
    assert.equal(/https?:\/\//i.test(text), false, `${f} 含外部地址`);
    assert.equal(/@import|url\(\s*['"]?(https?:)?\/\//i.test(text), false, `${f} 含外部样式引用`);
    assert.equal(/<(img|iframe|link|source)\b[^>]*(src|href)=["'](https?:)?\/\//i.test(text), false, `${f} 含外部引用`);
  }
});

test('配置注入：版本、哈希、链接、备案号；转义防注入', () => {
  const out = tmp();
  const file = join(tmp(), 'prod.json');
  writeFileSync(file, JSON.stringify({
    version: '1.4.2',
    releaseDate: '2026-12-01',
    icpNumber: '某ICP备00000000号<script>',
    downloads: { windows: { url: 'https://downloads.example.invalid/talekiln/Talekiln-Setup-1.4.2.exe', sha256: HASH.toUpperCase(), size: '96 MB' } },
    repoUrl: 'https://git.example.invalid/talekiln',
  }));
  build({ root: ROOT, env: { SITE_CONFIG: file }, out });
  const dl = readFileSync(join(out, 'download.html'), 'utf8');
  assert.match(dl, /下载 1\.4\.2/);
  assert.ok(dl.includes('href="https://downloads.example.invalid/talekiln/Talekiln-Setup-1.4.2.exe"'));
  assert.ok(dl.includes(HASH), '哈希统一小写');
  assert.equal(dl.includes(HASH.toUpperCase()), false);
  assert.ok(dl.includes('96 MB'));
  assert.match(dl, /Get-FileHash \.\\Talekiln-Setup-1\.4\.2\.exe/);
  const index = readFileSync(join(out, 'index.html'), 'utf8');
  assert.ok(index.includes('某ICP备00000000号&lt;script&gt;'));
  assert.equal(/<script/i.test(index), false);
  assert.ok(index.includes('href="https://git.example.invalid/talekiln"'));
  assert.ok(index.includes('2026-12-01'));
});

test('校验：非法版本、非法链接、哈希长度不对、未知占位符都会让构建失败', () => {
  assert.throws(() => cfg({ version: 'latest' }), /语义化/);
  for (const bad of ['javascript:alert(1)', 'http://insecure.example.invalid/x', '//evil.example.invalid/x', 'data:text/html,x', 'https://a b']) {
    assert.throws(() => cfg({ repoUrl: bad }), /链接/, bad);
    assert.throws(() => safeUrl(bad), /链接/, bad);
  }
  assert.throws(() => cfg({ downloads: { windows: { sha256: 'abc123' } } }), /64/);
  assert.equal(safeUrl(''), '');
  assert.equal(safeUrl('#x'), '#x');
  assert.equal(safeUrl('privacy.html'), 'privacy.html');
  assert.throws(() => render('{{nope}}', cfg()), /不存在/);
  assert.throws(() => render('{{{nope}}}', cfg(), {}), /不存在/);
  assert.throws(() => render('{{downloads}}', cfg()), /不是字符串/);
});

test('模板：转义、嵌套取值、片段原样输出', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  const c = cfg();
  assert.equal(render('{{downloads.windows.size}}', c), '（大小占位）');
  assert.equal(render('{{{f}}}', c, { f: '<b>x</b>' }), '<b>x</b>');
  assert.equal(render('{{ siteName }}', c), '故事窑 Talekiln');
});

test('下载表：有链接显示下载，占位链接禁用态，无链接即将开放；合并配置只覆盖给定字段', () => {
  const real = cfg({ downloads: { macos: { url: 'https://dl.example.invalid/m.dmg', sha256: HASH } } });
  const rows = downloadRows(real);
  assert.equal((rows.match(/btn-primary/g) || []).length, 1, '只有 macOS 有真实链接');
  assert.match(rows, /下载链接占位/);
  assert.match(downloadRows(cfg()), /即将开放/);
  const m = merge({ a: { b: 1, c: 2 }, d: 1 }, { a: { c: 3 }, e: 4 });
  assert.deepEqual(m, { a: { b: 1, c: 3 }, d: 1, e: 4 });
  assert.equal(loadConfig({}, ROOT).siteName, '故事窑 Talekiln');
});

test('仓库内的默认配置只含占位值：无真实地址与 64 位哈希', () => {
  const raw = readFileSync(join(ROOT, 'site.config.json'), 'utf8');
  assert.equal(/https?:\/\//i.test(raw), false);
  assert.equal(/\b[0-9a-f]{64}\b/i.test(raw), false);
});
