#!/usr/bin/env node
// 浏览器 e2e：自带启动 / 关闭本机服务（假厂商）与 vite dev server，用 Playwright（全局安装或仓库依赖）驱动 Chromium。
// 先走四视图主流程：首页 -> 新建空白项目 -> 剧本 -> 分镜 -> 时间线 -> 导出菜单 -> 切到英文 -> 整项目备份 -> 恢复（得到新项目）；
// 再依次点模板市场、插件页、批量生成页、云备份设置页、分镜表 / 工作台（一致性芯片、改片面板）、导演面板（用内置示例项目）。
// 每页截图到 e2e/screenshots/，记录控制台错误、页面异常与 5xx 响应，最后写 e2e/screenshots/report.json。
// 运行：pnpm --filter @talekiln/renderer e2e   （见 docs/e2e-browser.md）
// 环境变量：TALEKILN_E2E_API_PORT（默认 5791）、TALEKILN_E2E_WEB_PORT（默认 3091）、TALEKILN_E2E_HEADED=1 有头、TALEKILN_E2E_KEEP=1 跑完不关服务。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.join(here, '..');
const repoRoot = path.join(rendererDir, '..', '..');
const localDir = path.join(repoRoot, 'packages', 'local');
const shotsDir = path.join(here, 'screenshots');
const API_PORT = Number(process.env.TALEKILN_E2E_API_PORT) || 5791;
const WEB_PORT = Number(process.env.TALEKILN_E2E_WEB_PORT) || 3091;
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const API = `http://127.0.0.1:${API_PORT}/api/v1`;
const HEADED = process.env.TALEKILN_E2E_HEADED === '1';

fs.rmSync(shotsDir, { recursive: true, force: true });
fs.mkdirSync(shotsDir, { recursive: true });
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talekiln-e2e-'));
const logDir = path.join(workDir, 'logs');
fs.mkdirSync(logDir, { recursive: true });

// ---------- Playwright：优先仓库依赖，其次全局 npm 包（CI 镜像 / 本机预装） ----------
function loadPlaywright() {
  const req = createRequire(import.meta.url);
  try { return req('playwright'); } catch (_) { /* 仓库没装 */ }
  try { return req('@playwright/test'); } catch (_) { /* 同上 */ }
  const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  return createRequire(path.join(globalRoot, 'x.js'))('playwright');
}

const report = { started_at: new Date().toISOString(), work_dir: workDir, pages: [], console_errors: [], page_errors: [], server_errors: [], api_4xx: [], failures: [] };
const log = (...a) => console.log('[e2e]', ...a);

// ---------- 子进程 ----------
const children = [];
function spawnLogged(name, cmd, args, opts) {
  const out = fs.openSync(path.join(logDir, `${name}.log`), 'a');
  const child = spawn(cmd, args, { ...opts, stdio: ['ignore', out, out] });
  child.on('error', (e) => report.failures.push({ page: `(spawn ${name})`, error: e.message }));
  children.push(child);
  return child;
}
async function waitFor(fn, { timeout = 60000, interval = 300, label = '' } = {}) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    try { const r = await fn(); if (r) return r; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`等待超时：${label}${last ? `（${last.message}）` : ''}`);
}
const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true))).listen(port, '127.0.0.1');
});
async function api(method, p, body) {
  const r = await fetch(API + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j.data !== undefined ? j.data : j;
}

async function startServers() {
  for (const p of [API_PORT, WEB_PORT]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用，用 TALEKILN_E2E_API_PORT / TALEKILN_E2E_WEB_PORT 换一个`);
  // 未签名插件夹具：开发者模式打开后应出现在插件页
  const acme = path.join(localDir, 'test', 'fixtures', 'plugins', 'acme');
  fs.cpSync(acme, path.join(workDir, 'data', 'plugins', 'acme'), { recursive: true });
  spawnLogged('local', process.execPath, [path.join(localDir, 'src', 'server.js')], {
    // TALEKILN_DEV_SECRET_KEY：开发模式的文件密文存储（不设则备份页保存 Secret Key 会按设计返回 503）。随机生成，只活在这次运行里
    cwd: workDir, env: { ...process.env, TALEKILN_FAKE_VENDOR: '1', PORT: String(API_PORT), TALEKILN_DEV_SECRET_KEY: crypto.randomBytes(32).toString('hex') },
  });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${API_PORT}/health`)).ok, { label: '本机服务 /health' });
  // vite 可执行文件：从 renderer 的依赖解析（pnpm 下 .bin 可能在仓库根）
  const viteReq = createRequire(path.join(rendererDir, 'package.json'));
  const viteBin = path.join(path.dirname(viteReq.resolve('vite/package.json')), 'bin', 'vite.js');
  spawnLogged('vite', process.execPath, [viteBin, '--port', String(WEB_PORT), '--strictPort'], {
    cwd: rendererDir, env: { ...process.env, TALEKILN_API_PORT: String(API_PORT) },
  });
  await waitFor(async () => (await fetch(BASE + '/')).ok, { label: 'vite dev server' });
}

function stopServers() {
  if (process.env.TALEKILN_E2E_KEEP === '1') { log('TALEKILN_E2E_KEEP=1：服务保持运行', { api: API, web: BASE }); return; }
  for (const c of children) { try { c.kill('SIGTERM'); } catch (_) { /* 已退出 */ } }
}

// ---------- 浏览器辅助 ----------
let page;
let shotNo = 0;
async function shot(name) {
  shotNo += 1;
  const file = path.join(shotsDir, `${String(shotNo).padStart(2, '0')}-${name}.png`);
  await page.waitForTimeout(400); // 等 Element Plus 的标签 / 提示动画（el-zoom-in-center 0.3s）结束，否则截到半截标签
  await page.screenshot({ path: file, fullPage: true });
  return path.relative(repoRoot, file);
}
const t = (name) => page.locator(`[data-test="${name}"]`);
/** 填表单：data-test 可能落在 el-input 的内层 input / textarea 上，也可能在外层容器上。 */
async function fill(name, value) {
  const el = t(name).first();
  const tag = await el.evaluate((n) => n.tagName.toLowerCase());
  const target = tag === 'input' || tag === 'textarea' ? el : el.locator('input, textarea').first();
  await target.fill(value);
}
/** Element Plus 的 MessageBox 确认按钮。 */
async function confirmBox() {
  const btn = page.locator('.el-message-box:visible .el-message-box__btns .el-button--primary');
  await btn.waitFor({ state: 'visible', timeout: 10000 });
  await btn.click();
}
async function expectToast(text, timeout = 15000) {
  await page.locator('.el-message', { hasText: text }).first().waitFor({ state: 'visible', timeout });
}
async function goto(p) {
  await page.goto(BASE + p, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
}
async function step(name, fn) {
  const entry = { name, ok: true, screenshots: [], notes: [] };
  report.pages.push(entry);
  const t0 = Date.now();
  try {
    await fn(entry);
  } catch (e) {
    entry.ok = false;
    entry.error = e.message;
    report.failures.push({ page: name, error: e.message });
    try { entry.screenshots.push(await shot(`${name}-failed`)); } catch (_) { /* 页面可能已关闭 */ }
    log(`失败：${name}：${e.message}`);
  }
  entry.ms = Date.now() - t0;
}

// ---------- 主流程 ----------
async function main() {
  const pw = loadPlaywright();
  await startServers();
  log('服务已就绪', { api: API, web: BASE, workDir });

  // 种数据：跳过首次引导、种内置示例项目（5 镜）
  await api('PUT', '/onboarding/state', { dismissed: true, step: 'done' });
  const seeded = await api('POST', '/samples/talekiln-sample-v1/seed', {});
  const dramaId = seeded.drama_id;
  const episodeId = seeded.episode_id;
  const drama = await api('GET', `/dramas/${dramaId}`);
  report.seed = { dramaId, episodeId, episodes: (drama.episodes || []).length };

  const browser = await pw.chromium.launch({ headless: !HEADED, executablePath: process.env.TALEKILN_E2E_CHROMIUM || undefined });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'zh-CN' });
  page = await context.newPage();
  // 法务同意记录在 localStorage，提前写入避免页面弹同意框
  const legalVersion = (fs.readFileSync(path.join(rendererDir, 'src', 'utils', 'legal.js'), 'utf8').match(/LEGAL_VERSION = '([^']+)'/) || [])[1] || 'draft-0';
  await context.addInitScript((v) => {
    try { if (!localStorage.getItem('talekiln.legal.consent')) localStorage.setItem('talekiln.legal.consent', JSON.stringify({ version: v, acceptedAt: new Date().toISOString() })); } catch (_) { /* 忽略 */ }
  }, legalVersion);
  page.on('console', (m) => { if (m.type() === 'error') report.console_errors.push({ url: page.url(), text: m.text().slice(0, 500) }); });
  page.on('pageerror', (e) => report.page_errors.push({ url: page.url(), text: String(e && e.message || e).slice(0, 500) }));
  page.on('response', (r) => {
    const u = r.url();
    if (!u.includes('/api/')) return;
    if (r.status() >= 500) report.server_errors.push({ status: r.status(), method: r.request().method(), url: u.replace(BASE, '') });
    else if (r.status() >= 400) report.api_4xx.push({ status: r.status(), method: r.request().method(), url: u.replace(BASE, '') });
  });

  // 0. 四视图主流程（空白项目，全程走新路由 /p/:dramaId/e/:episodeId/...）
  const flow = {};
  await step('flow-home-new-blank', async (e) => {
    await goto('/');
    await t('start-blank').waitFor({ timeout: 15000 });
    e.screenshots.push(await shot('home'));
    await t('start-blank').click();
    await t('blank-title').waitFor({ timeout: 10000 });
    await fill('blank-title', 'e2e-flow');
    await t('blank-submit').click();
    await page.waitForURL(/\/p\/\d+\/e\/\d+\/script/, { timeout: 20000 });
    const m = /\/p\/(\d+)\/e\/(\d+)\/script/.exec(page.url());
    flow.dramaId = Number(m[1]);
    flow.episodeId = Number(m[2]);
    e.notes.push(`新项目 ${flow.dramaId}，第 1 集 ${flow.episodeId}；落地页：${page.url().replace(BASE, '')}`);
    await t('script-view').waitFor({ timeout: 15000 });
    e.screenshots.push(await shot('script-empty'));
  });

  await step('flow-script', async (e) => {
    if (!flow.dramaId) throw new Error('上一步没有建出项目');
    await t('write-direct').click();
    await t('full-text-area').waitFor({ timeout: 10000 });
    await fill('full-text-area', '# 旧书店\n小林推开旧书店的门，风铃响了。\n老板：欢迎光临，随便看看。\n小林：我想找一本绝版的诗集。\n# 街角\n△雨后的街角，小林撑着伞走远。');
    await t('full-text-apply').click();
    await waitFor(async () => (await t('script-line').count()) >= 5, { label: '剧本行出现', timeout: 15000 });
    await t('append-line').first().click();
    await waitFor(async () => (await t('script-line').count()) >= 7, { label: '追加一行', timeout: 10000 });
    e.notes.push(`剧本行：${await t('script-line').count()}`);
    // 行 -> 正文的防抖写回（约 1 秒）
    await waitFor(async () => /已保存|Saved/.test(await t('save-state').innerText()), { label: '剧本保存状态', timeout: 15000 }).catch((err) => e.notes.push(err.message));
    e.screenshots.push(await shot('script-lines'));
  });

  await step('flow-storyboard', async (e) => {
    if (!flow.dramaId) throw new Error('上一步没有建出项目');
    await t('tab-storyboard').click();
    await page.waitForURL(/\/storyboard/, { timeout: 15000 });
    await t('storyboard-page').waitFor({ timeout: 15000 });
    // 本机没有文本模型，“生成分镜”会失败；这里用“新增镜头”造 3 个镜头（走内核意图），再用假厂商生成图 / 视频
    for (let i = 0; i < 3; i++) {
      await waitFor(async () => !(await t('add-shot').isDisabled()), { label: '新增镜头可用', timeout: 15000 });
      await t('add-shot').click();
      await page.waitForTimeout(700);
    }
    const g = await api('GET', `/episodes/${flow.episodeId}/graph`).catch(() => null);
    const nodes = g ? ((g.graph || g).nodes || {}) : {};
    const shots = Object.values(nodes).filter((n) => n.type === 'shot').length;
    e.notes.push(`内核图镜头数：${g ? shots : '(读不到)'}`);
    if (g && shots < 3) throw new Error(`应有 3 个镜头，实际 ${shots}`);
    e.screenshots.push(await shot('storyboard-shots'));
    // 新建的镜头没有提示词，“生成全部”会提示缺提示词；先在检查器里给每个镜头填上图 / 视频提示词（失焦时提交）
    for (let i = 1; i <= 3; i++) {
      await t(`shot-card-${i}`).click();
      await t('field-image-prompt').waitFor({ timeout: 10000 });
      await fill('field-title', `镜头${i}`);
      await fill('field-description', `小林在旧书店里翻书（${i}）`);
      await fill('field-image-prompt', `旧书店内景，暖色灯光，镜头${i}`);
      await fill('field-video-prompt', `缓慢推近，镜头${i}`);
      await t('field-video-prompt').first().evaluate((n) => (n.querySelector('textarea') || n).blur());
      await page.waitForTimeout(800);
    }
    await t('generate-all').click();
    await t('generate-confirm').waitFor({ timeout: 15000 });
    await waitFor(async () => !(await t('generate-confirm').isDisabled()), { label: '确认按钮可用', timeout: 15000 });
    e.notes.push(`确认框：${(await t('generate-dialog').innerText()).trim().replace(/\s+/g, ' ').slice(0, 120)}`);
    e.screenshots.push(await shot('storyboard-confirm'));
    await t('generate-confirm').click();
    await waitFor(async () => {
      const st = await api('GET', `/episodes/${flow.episodeId}/generation/status`);
      const arr = st.shots || [];
      return arr.length > 0 && arr.every((s) => s.state === 'fresh');
    }, { label: '假厂商生成完成', timeout: 120000, interval: 1000 });
    await page.waitForTimeout(1500);
    e.notes.push(`过期徽标：${(await t('stale-badge').innerText()).trim()}`);
    e.screenshots.push(await shot('storyboard-generated'));
  });

  await step('flow-timeline', async (e) => {
    if (!flow.dramaId) throw new Error('上一步没有建出项目');
    await t('tab-timeline').click();
    await page.waitForURL(/\/timeline/, { timeout: 15000 });
    await page.waitForTimeout(1500);
    e.notes.push(`路径：${page.url().replace(BASE, '')}`);
    e.screenshots.push(await shot('timeline'));
  });

  await step('flow-export-menu', async (e) => {
    if (!flow.dramaId) throw new Error('上一步没有建出项目');
    const expected = ['video', 'jianying', 'premiere', 'srt', 'storyboardSheet', 'projectZip', 'assetPack', 'fullBackup'];
    for (const tab of ['script', 'storyboard', 'timeline', 'canvas']) {
      await t(`tab-${tab}`).click();
      await page.waitForURL(new RegExp(`/${tab}`), { timeout: 15000 });
      await page.waitForTimeout(800);
      await t('menu-export').click();
      await t('item-export.fullBackup').waitFor({ timeout: 10000 });
      const have = [];
      for (const id of expected) if (await t(`item-export.${id}`).count()) have.push(id);
      e.notes.push(`${tab}：导出菜单 ${have.length}/${expected.length} 项`);
      if (have.length !== expected.length) throw new Error(`${tab} 的导出菜单缺项：${expected.filter((x) => !have.includes(x)).join(',')}`);
      if (tab === 'storyboard') e.screenshots.push(await shot('export-menu'));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
    // 视频导出需要渲染核心；e2e 里没有，应当是“软禁用”而不是消失
    await t('menu-export').click();
    const cls = await t('item-export.video').getAttribute('class');
    e.notes.push(`导出视频项：${/soft-disabled/.test(cls || '') ? '软禁用（渲染核心未连接）' : '可用'}`);
    await page.keyboard.press('Escape');
  });

  await step('flow-english', async (e) => {
    if (!flow.dramaId) throw new Error('上一步没有建出项目');
    await t('tab-storyboard').click();
    await page.waitForURL(/\/storyboard/, { timeout: 15000 });
    await t('locale-switch').click();
    await page.locator('.el-dropdown-menu__item', { hasText: 'English' }).first().click();
    await waitFor(async () => (await page.evaluate(() => document.documentElement.lang)) === 'en', { label: 'html lang=en', timeout: 8000 });
    await page.waitForTimeout(500);
    const title = await page.title();
    const tabText = (await t('tab-script').innerText()).trim();
    e.notes.push(`标题：${title}；剧本标签：${tabText}`);
    if (/故事窑/.test(title)) throw new Error(`切到英文后浏览器标题还是中文：${title}`);
    if (tabText !== 'Script') throw new Error(`剧本标签应为 Script，实际 ${tabText}`);
    // 外壳（顶栏 / 左栏 / 状态栏）里不应残留中文，用户自己的数据（项目名、集名）除外
    const left = await page.evaluate(() => {
      const out = [];
      for (const sel of ['[data-test=topbar]', '[data-test=left-rail]', '[data-test=statusbar]']) {
        const root = document.querySelector(sel);
        if (!root) continue;
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) if (/[一-鿿]/.test(n.nodeValue)) out.push(n.nodeValue.trim().slice(0, 30));
      }
      return out;
    });
    e.notes.push(`外壳里的中文文本：${left.length ? left.join(' | ') : '无'}`);
    const stray = left.filter((x) => !/^(第\s*\d*\s*集.*|e2e-flow)$/.test(x) && x !== '中文');
    if (stray.length) throw new Error(`英文界面外壳残留中文：${stray.join(' | ')}`);
    e.screenshots.push(await shot('english-storyboard'));
  });

  let backupFile = null;
  await step('flow-backup', async (e) => {
    if (!flow.dramaId) throw new Error('上一步没有建出项目');
    await t('menu-export').click();
    await t('item-export.fullBackup').waitFor({ timeout: 10000 });
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      t('item-export.fullBackup').click(),
    ]);
    backupFile = path.join(workDir, 'flow-backup.zip');
    await dl.saveAs(backupFile);
    const size = fs.statSync(backupFile).size;
    e.notes.push(`下载文件：${dl.suggestedFilename()}，${size} 字节`);
    if (size < 200) throw new Error('备份文件过小');
  });

  await step('flow-restore', async (e) => {
    if (!backupFile) throw new Error('上一步没有备份文件');
    const before = (await api('GET', '/dramas?page=1&page_size=100')).items.map((d) => d.id);
    await goto('/');
    await t('start-importPackage').click();
    await t('package-file').setInputFiles(backupFile);
    await page.waitForURL(/\/p\/\d+\//, { timeout: 30000 });
    const m = /\/p\/(\d+)\/e\/(\d+)\//.exec(page.url());
    const restoredId = m ? Number(m[1]) : null;
    e.notes.push(`恢复后落地：${page.url().replace(BASE, '')}`);
    if (!restoredId || restoredId === flow.dramaId || before.includes(restoredId)) throw new Error(`恢复必须得到新项目，实际 ${restoredId}（原项目 ${flow.dramaId}）`);
    const list = (await api('GET', '/dramas?page=1&page_size=100')).items;
    const orig = list.find((d) => d.id === flow.dramaId);
    const copy = list.find((d) => d.id === restoredId);
    e.notes.push(`原项目：${orig ? orig.title : '(不见了)'}；新项目：${copy ? copy.title : '(找不到)'}`);
    if (!orig || !copy) throw new Error('原项目或恢复出的项目不在列表里');
    // 恢复出的项目保留撤销历史：顶栏的撤销可用
    await t('topbar').waitFor({ timeout: 15000 });
    await waitFor(async () => !(await t('undo-btn').isDisabled()), { label: '恢复项目的撤销可用', timeout: 15000 });
    e.notes.push('恢复项目的撤销按钮可用（历史随项目一起恢复）');
    e.screenshots.push(await shot('restored'));
    // 清理：删掉两个临时项目（软删除）
    await api('DELETE', `/dramas/${restoredId}`).catch(() => {});
    await api('DELETE', `/dramas/${flow.dramaId}`).catch(() => {});
  });

  // 1. 模板市场
  await step('templates', async (e) => {
    await goto('/templates');
    const cards = page.locator('[data-test^="tpl-"]');
    await cards.first().waitFor({ timeout: 15000 });
    e.notes.push(`模板数：${await cards.count()}`);
    await cards.first().click();
    await t('estimate-total').waitFor({ timeout: 15000 });
    e.notes.push(`估价：${(await t('estimate-total').innerText()).trim()}`);
    e.screenshots.push(await shot('templates-detail'));
    await t('apply-open').click();
    await t('apply-confirm').waitFor();
    e.screenshots.push(await shot('templates-apply-dialog'));
    await t('apply-confirm').click();
    await expectToast('已套用');
    e.screenshots.push(await shot('templates-applied'));
    const list = await api('GET', '/dramas?page=1&page_size=100');
    e.notes.push(`套用后项目数：${(list.items || []).length}`);
  });

  // 2. 插件页
  await step('plugins', async (e) => {
    await goto('/settings/plugins');
    await t('developer-mode-switch').waitFor({ timeout: 15000 });
    e.screenshots.push(await shot('plugins-list'));
    await t('developer-mode-switch').click();
    await confirmBox();
    await expectToast('开发者模式已打开');
    await page.waitForTimeout(800);
    const acme = t('row-acme');
    e.notes.push(`acme 行：${await acme.count() ? '可见' : '缺失'}`);
    if (await acme.count()) e.notes.push(`acme 签名标签：${(await t('sig-acme').innerText()).trim()}`);
    e.screenshots.push(await shot('plugins-devmode-on'));
    await t('detail-acme').click().catch(() => {});
    await page.waitForTimeout(500);
    e.screenshots.push(await shot('plugins-detail'));
    await page.keyboard.press('Escape');
    await t('developer-mode-switch').click();
    await expectToast('开发者模式已关闭');
    e.screenshots.push(await shot('plugins-devmode-off'));
  });

  // 3. 批量生成
  await step('batches', async (e) => {
    await goto(`/p/${dramaId}/batch`);
    await t('select-all').waitFor({ timeout: 15000 });
    await t('select-all').click();
    await waitFor(async () => (await t('estimate').innerText()).trim() && !(await t('start').isDisabled()), { label: '批次估算', timeout: 20000 });
    e.notes.push(`估算：${(await t('estimate').innerText()).trim().replace(/\s+/g, ' ')}`);
    e.screenshots.push(await shot('batch-form'));
    await t('start').click();
    await confirmBox();
    await expectToast('批次已创建');
    const b = page.locator('[data-test^="batch-"]').filter({ has: t('batch-status') }).first();
    await b.waitFor({ timeout: 15000 });
    e.screenshots.push(await shot('batch-created'));
    const pause = b.locator('[data-test="pause"]');
    if (await pause.count()) {
      await pause.click();
      await waitFor(async () => /暂停/.test(await b.locator('[data-test="batch-status"]').innerText()), { label: '批次暂停', timeout: 15000 });
      e.notes.push(`暂停后状态：${(await b.locator('[data-test="batch-status"]').innerText()).trim()}`);
    } else {
      e.notes.push(`没有暂停按钮，状态：${(await b.locator('[data-test="batch-status"]').innerText()).trim()}`);
    }
    e.screenshots.push(await shot('batch-paused'));
    const resume = b.locator('[data-test="resume"]');
    if (await resume.count()) { await resume.click(); await page.waitForTimeout(1500); e.screenshots.push(await shot('batch-resumed')); }
    // 等批次跑完（假厂商秒级）：后面的分镜表步骤会整集重做，若批次还在跑，其在途结果会被判成“批次运行期间被修改”而失败（这是设计行为）
    const done = await waitFor(async () => {
      const list = await api('GET', `/batches?drama_id=${dramaId}`);
      const cur = (list.items || [])[0];
      return cur && ['completed', 'failed', 'cancelled'].includes(cur.status) ? cur : null;
    }, { label: '批次结束', timeout: 120000, interval: 1000 }).catch(() => null);
    e.notes.push(done ? `批次最终状态：${done.status}${done.error ? '（' + done.error + '）' : ''}，已花费 ${done.totals.spent_cents} 分` : '批次 120 秒内没有结束');
    await page.waitForTimeout(1500);
    e.screenshots.push(await shot('batch-finished'));
  });

  // 4. 云备份设置
  await step('backup', async (e) => {
    await goto('/settings/backup');
    await t('endpoint').waitFor({ timeout: 15000 });
    e.screenshots.push(await shot('backup-empty'));
    await fill('endpoint', `http://127.0.0.1:${API_PORT + 1}`); // 回环、无人监听：测试连接必失败
    await fill('region', 'us-east-1');
    await fill('bucket', 'talekiln-e2e');
    await fill('prefix', 'talekiln');
    await fill('access-key', 'e2e-access-key');
    await fill('secret-key', 'e2e-secret-not-real');
    await t('save').click();
    await expectToast('云备份设置已保存');
    await t('secret-saved').waitFor({ timeout: 10000 });
    e.screenshots.push(await shot('backup-saved'));
    await t('test').click();
    await t('test-result').waitFor({ timeout: 30000 });
    const r = (await t('test-result').innerText()).trim();
    e.notes.push(`测试连接：${r}`);
    if (!/失败|不通|连不上|错误|拒绝|ECONNREFUSED/.test(r)) e.notes.push('预期测试连接失败，但文案不像失败');
    e.screenshots.push(await shot('backup-test-failed'));
  });

  // 5. 生成一轮（假厂商，秒级完成）让一致性评分有数据，再看分镜表
  await step('storyboard', async (e) => {
    // 一致性评分只对“锁定了参考图的角色 / 场景”算：给示例角色锁一张参考图，并把每个分镜勾上这个角色
    const chars = drama.characters || [];
    const sbs = (await api('GET', `/episodes/${episodeId}/storyboards`)).storyboards || [];
    if (chars.length && sbs.length) {
      const first = sbs[0];
      await api('PUT', `/reference-locks/character/${chars[0].id}`, { local_path: first.local_path });
      for (const sb of sbs) await api('PUT', `/storyboards/${sb.id}`, { characters: [chars[0].id] });
      e.notes.push(`已锁定角色 ${chars[0].name || chars[0].id} 的参考图并勾到 ${sbs.length} 个分镜`);
    } else {
      e.notes.push('示例项目没有角色或分镜，跳过参考图锁定');
    }
    // 示例项目已有首帧与视频：regenerate=true 强制整集重做（假厂商秒级完成）
    const preview = await api('POST', `/episodes/${episodeId}/generate`, { shots: 'all', kind: 'both', confirm: false, regenerate: true });
    e.notes.push(`生成估算：${JSON.stringify(preview.estimate || preview).slice(0, 160)}`);
    await api('POST', `/episodes/${episodeId}/generate`, { shots: 'all', kind: 'both', confirm: true, regenerate: true });
    await waitFor(async () => {
      const st = await api('GET', `/episodes/${episodeId}/generation/status`);
      const arr = st.shots || [];
      return arr.length > 0 && arr.every((s) => s.state === 'fresh');
    }, { label: '假厂商生成完成', timeout: 90000, interval: 1000 });
    await waitFor(async () => {
      const rep = await api('GET', `/episodes/${episodeId}/consistency`);
      return rep.available && rep.counts && (rep.counts.ok + rep.counts.check + rep.counts.retry) > 0 ? rep : null;
    }, { label: '一致性评分', timeout: 60000, interval: 1000 }).then((rep) => e.notes.push(`一致性：${JSON.stringify(rep.counts)}`), (err) => e.notes.push(err.message));
    await goto(`/p/${dramaId}/e/${episodeId}/storyboard`);
    await t('consistency-chip').first().waitFor({ timeout: 20000 }).catch((err) => e.notes.push(`卡片视图没有一致性芯片：${err.message}`));
    await page.waitForTimeout(1000);
    e.notes.push(`卡片视图一致性芯片：${await t('consistency-chip').count()} 个`);
    e.screenshots.push(await shot('storyboard-cards'));
    await t('view-mode').locator('label', { hasText: /表格|Table/ }).click();
    await page.locator('table tbody tr').first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(800);
    e.notes.push(`表格视图一致性芯片：${await t('consistency-chip').count()} 个；图片状态芯片：${await t('row-chip-image').count()} 个`);
    e.screenshots.push(await shot('storyboard-chips'));
  });

  // 6. 工作台：一致性芯片 + 改片面板
  let shotId = null;
  await step('workbench', async (e) => {
    const rows = await api('GET', `/episodes/${episodeId}/storyboards`).catch(() => null);
    const items = rows ? (rows.storyboards || []) : [];
    shotId = items[0] && items[0].id;
    if (!shotId) throw new Error('取不到分镜 id');
    await goto(`/p/${dramaId}/e/${episodeId}/shot/${shotId}`);
    await t('region-edit').waitFor({ timeout: 20000 });
    await page.waitForTimeout(1000);
    e.notes.push(`一致性芯片：${await t('consistency-chip').count()}；提示：${await t('consistency-hint').count() ? (await t('consistency-hint').innerText()).trim() : '无'}`);
    e.screenshots.push(await shot('workbench'));
    const bar = t('clip-bar');
    if (await bar.count()) {
      const box = await bar.boundingBox();
      if (box) { await page.mouse.click(box.x + box.width * 0.2, box.y + box.height / 2); await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2); }
    }
    e.notes.push(`提示词为空时确认按钮：${await t('re-submit').isDisabled() ? '禁用' : '可用'}`);
    await fill('re-prompt', '把伞换成红色');
    // 框选区域：点“框选区域”进入画框模式，在视频层上拖一个矩形
    const layer = t('rect-layer');
    if (await layer.count()) {
      await t('re-draw').click();
      const lb = await layer.boundingBox();
      if (lb) {
        await page.mouse.move(lb.x + lb.width * 0.3, lb.y + lb.height * 0.3);
        await page.mouse.down();
        await page.mouse.move(lb.x + lb.width * 0.6, lb.y + lb.height * 0.7, { steps: 8 });
        await page.mouse.up();
      }
    } else {
      e.notes.push('没有 rect-layer（无已采用视频），无法框选');
    }
    await waitFor(async () => (await t('re-cost').count()) > 0, { label: '改片估价', timeout: 15000 }).catch((err) => e.notes.push(err.message));
    e.notes.push(`改片估价：${await t('re-cost').count() ? (await t('re-cost').innerText()).trim() : '（未出现）'}；确认按钮：${await t('re-submit').isDisabled() ? '禁用' : '可用'}`);
    e.screenshots.push(await shot('workbench-region-edit'));
  });

  // 7. 导演面板：生成计划（假文本模型回固定计划）→ 干跑结果 → 执行 → 撤销
  await step('director', async (e) => {
    await t('open-director').waitFor({ timeout: 10000 });
    await t('open-director').click();
    await t('director-drawer').waitFor({ timeout: 10000 });
    await fill('director-input', '把第一镜改成特写');
    await t('director-plan').click();
    await t('director-turn').first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(500);
    e.notes.push(`状态：${(await t('director-status').first().innerText()).trim()}；步骤：${await t('director-step').count()}；影响：${await t('director-impact').count() ? (await t('director-impact').first().innerText()).trim().replace(/\s+/g, ' ').slice(0, 160) : '无'}`);
    e.screenshots.push(await shot('director-plan'));
    const apply = t('director-apply').first();
    await waitFor(async () => (await apply.count()) && !(await apply.isDisabled()), { label: '执行按钮可用', timeout: 10000 }).catch((err) => e.notes.push(err.message));
    if (await apply.count() && !(await apply.isDisabled())) {
      await apply.click();
      await expectToast('已执行');
      await page.waitForTimeout(800);
      e.screenshots.push(await shot('director-applied'));
      const undo = t('director-undo').first();
      if (await undo.count() && !(await undo.isDisabled())) { await undo.click(); await expectToast('已撤销'); await page.waitForTimeout(800); e.screenshots.push(await shot('director-undone')); }
      else e.notes.push('撤销按钮不可用');
    } else {
      e.notes.push('执行按钮不可用');
    }
  });

  await browser.close();
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  exitCode = 1;
  report.failures.push({ page: '(setup)', error: e.message });
  log('运行失败：', e.message);
} finally {
  stopServers();
  report.finished_at = new Date().toISOString();
  report.logs = logDir;
  fs.writeFileSync(path.join(shotsDir, 'report.json'), JSON.stringify(report, null, 2));
  const lines = [];
  for (const p of report.pages) lines.push(`${p.ok ? 'OK  ' : 'FAIL'} ${p.name} (${p.ms} ms)${p.error ? ' — ' + p.error : ''}`, ...p.notes.map((n) => '      · ' + n), ...p.screenshots.map((s) => '      → ' + s));
  lines.push(`控制台错误 ${report.console_errors.length}，页面异常 ${report.page_errors.length}，5xx ${report.server_errors.length}，4xx ${report.api_4xx.length}`);
  for (const c of report.console_errors) lines.push('  console: ' + c.text.slice(0, 200));
  for (const c of report.page_errors) lines.push('  pageerror: ' + c.text.slice(0, 200));
  for (const c of report.server_errors) lines.push(`  5xx: ${c.method} ${c.url} -> ${c.status}`);
  for (const c of report.api_4xx) lines.push(`  4xx: ${c.method} ${c.url} -> ${c.status}`);
  lines.push(`日志：${logDir}；报告：${path.relative(repoRoot, path.join(shotsDir, 'report.json'))}`);
  console.log(lines.join('\n'));
  if (report.failures.length) exitCode = 1;
  process.exit(exitCode);
}
