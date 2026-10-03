# 四视图统一工作台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 LocalMiniDrama 的 FilmCreate / DramaDetail / DramaCanvas 全部功能并入四视图统一外壳，删除旧页面，全程中英文可切换。

**Architecture:** 一个 `ProjectShell` 路由布局包住所有项目页（顶栏、左栏、状态栏、生成 / 导出菜单、对话框宿主）。菜单项、对话框、翻译文案都用“按归属分文件的注册表”，使并行 worker 互不改同一个文件。后端三项独立改动（可撤销的重新生成分镜、草稿 / 成片质量档、完整项目备份）与前端同时推进。

**Tech Stack:** Vue 3、Element Plus、Pinia、vue-router、Express、better-sqlite3、`node --test`。不新增 npm 依赖（i18n 自研，约 80 行）。

**Spec:** `docs/superpowers/specs/2026-10-03-four-view-unification-design.md`（含 §10 评审结论）。UI 线框：https://claude.ai/artifact/AMhnpTL2cGa5GgJHvxTaqG 。

## Global Constraints

- 密钥只放本机环境变量或应用的 AI 配置页，不进文件、提交、聊天。每次提交前跑 `pnpm secrets:scan`。测试用假密钥 `sk-dummy-safestorage-TEST1234`。
- 业务写入只走内核意图或已改道的兼容接口（`docs/kernel-design.md` §12）。不新增直接写分镜表 / 时间线表的代码。
- 后端改动后跑 `node packages/kernel/test/conformance/report.js`，要求 0 失败（约 6 分钟，输出在跑完前为空；它会改写 `docs/kernel-conformance.md`，只差 CRLF，提交前 `git checkout docs/kernel-conformance.md`）。
- 所有新增或改动的界面文字走 `t()`，中文（`zh-CN`）与英文（`en`）都要有。不允许在已迁移文件里留中文字面量（有测试检查，见 Task 1）。
- 不新增 npm 依赖。
- 不用快速拼接 / `finalize` / `video_merges`；字幕烧录、对白烧录、水印不做（记为渲染核心缺口）。
- 提交署名：`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`（用户记忆规则）。永远不要提交 `.scratch/`、`.stage/`、`apps/desktop/release/`。
- Windows：Node 25 对应 `pnpm native:node`；很多文件是 CRLF，用 Edit 工具而不是字符串锚点脚本；含反斜杠的内容用 Write / Edit 工具，不用 Bash heredoc；在 `packages/local` 目录里跑 `node --test test/<file>.test.js`，在 `apps/renderer` 里跑 `node --test test/<file>.test.js`。
- 分支：全部在 `win/four-view-impl` 上，工作树共享（见“协作规则”）。

## 协作规则（并行 worker 必读）

所有 worker 在**同一个工作目录、同一个分支**上工作，所以必须遵守：

1. 只修改自己任务“Files”里列出的文件。需要新文件时放在自己的归属目录下。共享入口文件（`src/i18n/catalog.js`、`src/shell/actions/index.js`、`src/shell/dialogs/index.js`、`src/router/index.js`）已由 Task 1 / 2 预先接好，**不要再改**；只改自己名下的 `messages/<lane>.js`、`actions/<lane>.js`、`dialogs/<lane>.js`。
2. 提交：`git add <自己改过的路径>` 然后 `git commit -m "..." -- <自己改过的路径>`（带路径规格，避免把别人未完成的文件带进来）。遇到 `index.lock` 就等 2 秒重试。不要 `git checkout`、`stash`、`reset`、换分支。不要 push，由协调者统一 push。
3. 不要改 `docs/phase1-status.md`、`docs/bailian-flow-coverage.md`、`docs/windows-test-results/*`。把要写的内容放进 `docs/superpowers/notes/<lane>.md`（你的 lane 名），协调者最后合并进上述文档。
4. 其他 worker 的文件可能在你测试时处于中间状态。如果别人的测试失败而你的通过，不要去改别人的文件，在报告里说明。
5. 不要启动或停止 dev server（协调者的 `pnpm dev:web` 已在运行）。需要看界面时用已运行的服务（renderer 在 vite 默认端口，后端 127.0.0.1:5679），只读访问。

## Review Focus

1. **英文缺 key**：某个 key 只在 `zh-CN` 里有。预期：回退到中文而不是显示 key；并且 `i18nParity` 测试在 CI 里直接失败。（Task 1）
2. **旧书签**：`/film/12?episode=3`、`/drama/12`、`/episodes/7/export`、`/project/12/library` 打开后应进入对应的新页面，不出现空白页。（Task 2）
3. **重新生成分镜后撤销**：撤销一次后旧镜头、旧首帧 / 视频和它们的版本全部回来；重做再回新分镜。（Task 3）
4. **草稿档切回成片档**：不会让已有产物变“过期”；“按成片质量重跑”只命中草稿产物，数量与预估花费与实际一致。（Task 4）
5. **备份恢复**：恢复出来的是新项目，撤销历史、版本、媒体都在；原项目不变；包被损坏或版本更高时给出明确错误而不是半恢复。（Task 5）
6. **没有渲染核心**：导出菜单里只有“导出成片”置灰，其余项可用；点击置灰项有原因提示。（Task 2 / Task 9）
7. **空项目**：没有剧集 / 没有镜头 / 没有资产时，每个页面显示引导而不是报错。（各 lane）

---

## 依赖与分波

```
波 0（立即并行）：Task 1 → Task 2   前端地基（同一个 worker，先 i18n 后外壳）
                  Task 3            后端：可撤销重新生成分镜 + 补接口
                  Task 4            后端：草稿 / 成片质量档
                  Task 5            后端：完整项目备份
波 1（Task 2 完成后并行）：Task 6 剧本  Task 7 资产  Task 8 分镜  Task 9 生成与导出  Task 10 画布  Task 11 首页
波 2（全部完成后）：Task 12 清理旧页面 + e2e + 文档 + 验收
```

文件归属表（避免冲突）：

| Lane | 拥有的路径 |
|---|---|
| T1/T2 地基 | `src/i18n/index.js`、`src/i18n/catalog.js`、`src/i18n/messages/*.js`（创建全部占位）、`src/shell/**`（创建全部占位）、`src/router/index.js`、`src/stores/shell.js`、`src/utils/legacyRoutes.js`、`src/components/ViewSwitcher.vue`（删除）、`src/main.js`、`src/App.vue` |
| T3/T4/T5 后端 | `packages/local/**`（各自的子目录，见任务） |
| T6 剧本 | `src/views/ScriptView.vue`、`src/shell/{actions,dialogs}/script.js`、`src/i18n/messages/script.js`、`src/components/script/**`、`src/utils/scriptTools.js`、`src/api/episodes.js` |
| T7 资产 | `src/views/ReferenceLibrary.vue`→`AssetLibrary.vue`、`src/components/assets/**`、`src/stores/assets.js`、`src/api/{characters,scenes,props,characterLibrary,sceneLibrary,propLibrary}.js`、`src/shell/{actions,dialogs}/assets.js`、`messages/assets.js` |
| T8 分镜 | `src/views/{StoryboardPage,ShotWorkbench}.vue`、`src/components/shot/**`、`src/utils/{storyboardTable,shotWorkbench,storyboardMedia}.js`、`src/shell/{actions,dialogs}/storyboard.js`、`messages/storyboard.js` |
| T9 生成与导出 | `src/views/{ExportPage,TimelineEditor,BatchPage}.vue`、`src/composables/usePipeline.js`、`src/components/export/**`、`src/utils/{exportJob,exportStoryboardSheet,exportSrt,pipelinePlan}.js`、`src/shell/{actions,dialogs}/{generate,export}.js`、`messages/{generate,export}.js` |
| T10 画布 | `src/views/CanvasView.vue`、`src/components/canvas/**`（已有目录）、`src/shell/{actions,dialogs}/canvas.js`、`messages/canvas.js` |
| T11 首页 | `src/views/{FilmList,NewProject,MediaLibrary,TaskCenter}.vue`、`src/components/home/**`、`src/shell/{actions,dialogs}/home.js`、`messages/home.js` |

---

## Task 1: i18n 核心（波 0，前端地基 worker 先做）

**Files:**
- Create: `apps/renderer/src/i18n/index.js`、`apps/renderer/src/i18n/catalog.js`
- Create（空占位，供各 lane 填）: `apps/renderer/src/i18n/messages/{common,shell,script,assets,storyboard,generate,export,canvas,home,backup}.js`
- Create: `apps/renderer/test/i18n.test.js`、`apps/renderer/test/i18nParity.test.js`、`apps/renderer/test/i18nLiterals.test.js`、`apps/renderer/test/i18n-migrated/README.md`
- Modify: `apps/renderer/src/main.js`（Element Plus 随语言切换）

**Interfaces:**
- Produces（所有 lane 依赖，签名不可改）:
  - `export const LOCALES = ['zh-CN', 'en']`
  - `export const locale: Ref<'zh-CN'|'en'>`（默认：本机保存的值，否则 `navigator.language` 以 `zh` 开头则 `zh-CN`，否则 `en`）
  - `export function setLocale(l): void`（写 `localStorage['talekiln.locale']`，try/catch；设置 `document.documentElement.lang`）
  - `export function t(key: string, params?: Record<string, string|number>): string`（读取 `locale.value`，在模板里自动响应；`{name}` 占位；缺英文回退中文，再缺返回 key）
  - `export function useI18n(): { t, locale, setLocale, LOCALES }`
  - `export function createTranslator(catalog, getLocale)`（纯函数，测试用）
- 消息文件格式：`export default { 'zh-CN': { 'script.toolbar.aiWrite': 'AI 写剧本' }, en: { 'script.toolbar.aiWrite': 'AI write script' } }`；key 必须以文件名（命名空间）开头加点。
- `catalog.js` 显式 import 全部 10 个消息文件并合并（不用 `import.meta.glob`，保证 `node --test` 能加载）。

- [ ] **Step 1: 写失败测试 `i18n.test.js`**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTranslator } from '../src/i18n/index.js'

const catalog = {
  'zh-CN': { 'a.hello': '你好，{name}', 'a.onlyZh': '仅中文' },
  en: { 'a.hello': 'Hello, {name}' },
}

test('interpolates params', () => {
  const t = createTranslator(catalog, () => 'en')
  assert.equal(t('a.hello', { name: 'Lin' }), 'Hello, Lin')
})
test('falls back to zh-CN then key', () => {
  const t = createTranslator(catalog, () => 'en')
  assert.equal(t('a.onlyZh'), '仅中文')
  assert.equal(t('a.missing'), 'a.missing')
})
test('keeps unknown placeholders visible', () => {
  const t = createTranslator(catalog, () => 'zh-CN')
  assert.equal(t('a.hello'), '你好，{name}')
})
```

- [ ] **Step 2: 运行确认失败**

Run（`apps/renderer`）: `node --test test/i18n.test.js` — Expected: FAIL，找不到 `../src/i18n/index.js`。

- [ ] **Step 3: 实现 `index.js`**

```js
import { ref } from 'vue'
import catalog from './catalog.js'

export const LOCALES = ['zh-CN', 'en']
const STORE_KEY = 'talekiln.locale'

function initial() {
  try {
    const saved = globalThis.localStorage?.getItem(STORE_KEY)
    if (LOCALES.includes(saved)) return saved
  } catch (_) { /* 私有窗口等情况读不到，用默认 */ }
  const nav = globalThis.navigator?.language || ''
  return nav.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

export const locale = ref(initial())

export function createTranslator(messages, getLocale) {
  return function t(key, params) {
    const loc = getLocale()
    const raw = messages[loc]?.[key] ?? messages['zh-CN']?.[key] ?? key
    if (!params) return raw
    return raw.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m))
  }
}

export const t = createTranslator(catalog, () => locale.value)

export function setLocale(l) {
  if (!LOCALES.includes(l)) return
  locale.value = l
  try { globalThis.localStorage?.setItem(STORE_KEY, l) } catch (_) { /* 忽略 */ }
  if (globalThis.document) globalThis.document.documentElement.lang = l
}

export function useI18n() {
  return { t, locale, setLocale, LOCALES }
}
```

`index.js` 引入了 `vue`；`node --test` 能直接加载 `vue`（renderer 的依赖），测试里的 `ref` 不依赖 DOM。

- [ ] **Step 4: 创建 `catalog.js` 与 10 个空消息文件**

```js
import common from './messages/common.js'
import shell from './messages/shell.js'
import script from './messages/script.js'
import assets from './messages/assets.js'
import storyboard from './messages/storyboard.js'
import generate from './messages/generate.js'
import exportMsgs from './messages/export.js'
import canvas from './messages/canvas.js'
import home from './messages/home.js'
import backup from './messages/backup.js'

const all = [common, shell, script, assets, storyboard, generate, exportMsgs, canvas, home, backup]
const catalog = { 'zh-CN': {}, en: {} }
for (const m of all) {
  Object.assign(catalog['zh-CN'], m['zh-CN'])
  Object.assign(catalog.en, m.en)
}
export default catalog
```

每个消息文件占位为 `export default { 'zh-CN': {}, en: {} }`。`common.js` 先写入通用词：确定、取消、保存、删除、重命名、关闭、重试、加载中、复制、更多、返回、搜索、语言、中文、English（中英各一份）。

- [ ] **Step 5: 写 `i18nParity.test.js`**（遍历 `src/i18n/messages/*.js`，动态 import）

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/i18n/messages')
for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
  const ns = file.replace(/\.js$/, '')
  test(`messages/${file}: zh-CN and en have identical keys under namespace`, async () => {
    const mod = (await import(pathToFileURL(path.join(dir, file)).href)).default
    const zh = Object.keys(mod['zh-CN']).sort()
    const en = Object.keys(mod.en).sort()
    assert.deepEqual(en, zh, 'every key needs both languages')
    for (const k of zh) assert.ok(k.startsWith(`${ns}.`), `key ${k} must start with ${ns}.`)
    for (const [k, v] of Object.entries(mod.en)) assert.ok(String(v).trim() !== '', `${k} English text is empty`)
  })
}
```

（`common.js` 的 key 前缀为 `common.`。）

- [ ] **Step 6: 写 `i18nLiterals.test.js`**

读取 `test/i18n-migrated/*.json`（每个 lane 一个文件，内容是相对 `src/` 的路径数组），对每个 `.vue` / `.js` 文件检查：`.vue` 的 `<template>` 部分去掉 `{{ ... }}` 与属性值里的 `t(...)` 表达式后不得含 CJK（`[一-鿿]`）；`<script>` 与 `.js` 去掉注释后，字符串字面量里不得含 CJK，除非该行带 `// i18n-ignore`。失败信息要列出文件、行号、片段。README 说明：lane 完成迁移后，在自己的 json 里登记文件。

- [ ] **Step 7: 修改 `main.js`**：用 `watch(locale)` 在 `zh-cn` 与 `en`（`element-plus/dist/locale/en.mjs`）之间切换 `ElConfigProvider` 的 `locale`；`ElConfigProvider` 的 `locale` prop 用 `computed`。

- [ ] **Step 8: 运行测试通过**

Run: `node --test test/i18n.test.js test/i18nParity.test.js test/i18nLiterals.test.js` — Expected: 全部 PASS。

- [ ] **Step 9: 提交**

```bash
git add apps/renderer/src/i18n apps/renderer/src/main.js apps/renderer/test/i18n.test.js apps/renderer/test/i18nParity.test.js apps/renderer/test/i18nLiterals.test.js apps/renderer/test/i18n-migrated
git commit -m "feat(i18n): zh-CN/en translator with per-lane message files and parity tests" -- apps/renderer/src/i18n apps/renderer/src/main.js apps/renderer/test/i18n.test.js apps/renderer/test/i18nParity.test.js apps/renderer/test/i18nLiterals.test.js apps/renderer/test/i18n-migrated
```

Review Focus 对应测试：`falls back to zh-CN then key`、parity 测试。

---

## Task 2: ProjectShell 外壳、路由、菜单与对话框注册表（波 0，紧接 Task 1，同一个 worker）

**Files:**
- Create: `apps/renderer/src/shell/ProjectShell.vue`、`TopBar.vue`、`LeftRail.vue`、`StatusBar.vue`、`TaskDrawer.vue`、`DialogHost.vue`、`LocaleSwitch.vue`
- Create: `apps/renderer/src/shell/menus.js`、`actions/registry.js`、`actions/index.js`、`actions/{script,assets,storyboard,generate,export,canvas,home}.js`（占位）、`dialogs/index.js`、`dialogs/{script,assets,storyboard,generate,export,canvas,home}.js`（占位）
- Create: `apps/renderer/src/stores/shell.js`、`apps/renderer/src/utils/legacyRoutes.js`
- Modify: `apps/renderer/src/router/index.js`、`apps/renderer/src/views/{ScriptView,CanvasView,StoryboardPage,TimelineEditor}.vue`（只删 `<ViewSwitcher>` 与其 slot 内容的搬迁，不动其他逻辑；此处是 Lane 之前唯一一次碰这四个文件）
- Delete: `apps/renderer/src/components/ViewSwitcher.vue`
- Modify: `apps/renderer/src/views/{ExportPage,BatchPage,ReferenceLibrary,ShotWorkbench}.vue` 只改其返回键与路由跳转到新路径
- Test: `apps/renderer/test/legacyRoutes.test.js`、`menus.test.js`、`shellStore.test.js`

**Interfaces:**
- Produces:
  - 路由（均为 `ProjectShell` 的子路由，`name` 固定）:
    - `/p/:dramaId/e/:episodeId/script` → `episode-script`
    - `/p/:dramaId/e/:episodeId/storyboard` → `episode-storyboard`
    - `/p/:dramaId/e/:episodeId/timeline` → `episode-timeline`
    - `/p/:dramaId/e/:episodeId/canvas` → `episode-canvas`
    - `/p/:dramaId/e/:episodeId/shot/:shotId` → `shot-workbench`
    - `/p/:dramaId/e/:episodeId/export` → `episode-export`（页面形式保留；T9 把它改为对话框后此路由重定向到 timeline 并打开对话框）
    - `/p/:dramaId/assets` → `assets`
    - `/p/:dramaId/batch` → `batch`
    - `/p/:dramaId` → 重定向到 `shell.lastView(dramaId)` 或第 1 集剧本
  - `utils/legacyRoutes.js`: `resolveLegacyRoute(to, { episodeToDrama, firstEpisode }): Promise<string|null>`，把 spec §6 的重定向表实现为纯函数（异步仅用于查询注入）。旧路由 `/drama/:id`、`/film/:id`、`/film/:id/canvas`、`/film/new`、`/episodes/:id/{script,canvas,timeline,storyboard,export}`、`/project/:dramaId/{storyboard,library,shot/:shotId,batch}` 都在 `router.beforeEach` 里先过它；旧页面组件的路由记录保留到 Task 12 才删除。
  - `shell/menus.js`: `export const GENERATE_MENU`、`EXPORT_MENU`（数组：`{ id, group, labelKey, descKey, action, requires }`，`requires` 取 `'episode' | 'renderCore' | 'shots' | 'timeline'`），`export function menuState(item, ctx): { enabled: boolean, reasonKey?: string }`，`ctx = { episodeId, shotCount, hasTimeline, renderCoreOk, draftCount }`。
  - 菜单项 id 与 action 固定如下（各 lane 用同名 action 注册处理函数）:
    - 生成菜单: `generate.pipeline`（一键成片）、`generate.missing`（只补齐过期与未生成）、`generate.allFirstFrames`、`generate.allVideos`、`generate.allVoice`、`generate.director`、`generate.batchEpisodes`、`generate.rerunDraft`（按成片质量重跑草稿产物）。
    - 导出菜单: `export.video`（导出成片 MP4…）、`export.jianying`、`export.premiere`、`export.srt`、`export.storyboardSheet`、`export.projectZip`、`export.assetPack`、`export.fullBackup`（完整项目备份…）。
  - `shell/actions/registry.js`: `registerAction(id, fn)`、`runAction(id, ctx): Promise<void>`（未注册的 id：toast `shell.action.notReady` 并返回）、`hasAction(id)`。`ctx` 为 `{ router, route, dramaId, episodeId, openDialog, store }`。
  - `shell/dialogs/index.js`: `openDialog(id, props): Promise<any>`（返回对话框关闭时的结果）；`dialogs/<lane>.js` 导出 `{ 'script.aiWrite': () => import('...vue'), ... }` 形式的懒加载表，`index.js` 合并。`DialogHost.vue` 渲染当前对话框。
  - `stores/shell.js`: `useShellStore()`，字段 `dramaId, drama, episodes, assetCounts({characters,scenes,props}), quality('draft'|'final'), tasksRunning, renderCoreOk, lastView(dramaId)`；动作 `loadProject(dramaId)`、`setQuality(q)`（调用 `PUT /dramas/:id/quality`，由 Task 4 提供；接口不存在时本地保存并忽略 404）、`rememberView(dramaId, episodeId, view)`（写 `localStorage`，try/catch）。
  - 顶栏、左栏、状态栏的所有文字使用 `shell.*` key。

- [ ] **Step 1: 写 `legacyRoutes.test.js`（失败测试）**。覆盖 spec §6 全部行，另加：`/film/12?episode=3` → `/p/12/e/3/storyboard`；`/film/12` 无 episode → 第 1 集；`/drama/12` 的剧集列表为空 → `/p/12/assets`（不白屏）；`/episodes/99/script` 查不到所属项目 → `/`。
- [ ] **Step 2: 运行确认失败**（`node --test test/legacyRoutes.test.js`）。
- [ ] **Step 3: 实现 `legacyRoutes.js`**，纯函数；运行测试通过。
- [ ] **Step 4: 写 `menus.test.js`**：`export.video` 在 `renderCoreOk=false` 时 `enabled=false` 且 `reasonKey='shell.menu.reason.renderCore'`；其余导出项此时 `enabled=true`；没有镜头时 `generate.*` 禁用并给出原因；`generate.rerunDraft` 在 `draftCount=0` 时禁用。实现 `menus.js`，通过。
- [ ] **Step 5: 实现 `actions/registry.js` + 占位文件 + `dialogs/index.js` 与占位**；占位文件只导出空对象或空 `register()`，由对应 lane 填充。写 `registry` 的测试（未注册 id 不抛错、已注册的被调用且收到 ctx）。
- [ ] **Step 6: 实现 `stores/shell.js`**（测试用注入的 fake API 验证 `loadProject`、`setQuality` 在 404 时不抛错、`rememberView` 在 `localStorage` 抛错时不抛错）。
- [ ] **Step 7: 实现外壳组件**，对照线框：
  - `TopBar.vue`：Logo；项目 / 集下拉（切集保留当前 view）；标签（`剧本 分镜 时间线 画布` → `shell.tab.*`）；待生成徽标（点击设置 store 的“只看过期”标志，各视图自己读取）；任务按钮打开 `TaskDrawer`（复用 `TaskCenter` 的数据源 `api/task.js`）；花费（跳 `/spend`）；历史（打开已有 `VersionHistoryDrawer`）；撤销 / 重做（搬 `ViewSwitcher` 的 Ctrl+Z / Ctrl+Y 处理，保持“输入框内与时间线视图不拦截”的现有行为）；质量档开关（草稿 / 成片）；`LocaleSwitch`；生成▾ 次按钮、导出▾ 主按钮（按 `menus.js` 渲染，分组标题与禁用原因提示）。
  - `LeftRail.vue`：分集列表（点击切集，当前集高亮，显示过期点）；资产三项（计数，点击在当前页面打开资产面板：向 store 发 `assetsPanelOpen=true` 并导航到 `assets` 当不在四视图时）；项目链接（批量生成、项目设置 → `openDialog('home.projectSettings')`，T6 实现，未实现时 toast）。分集新建 / 批量导入按钮调用 `runAction('script.addEpisode')` / `runAction('script.importEpisodes')`，由 T6 注册。
  - `StatusBar.vue`：保存状态、`summary` 来自当前视图（视图通过 `provide('shellSummary')` 的 ref 设置）、画幅、风格、模型、渲染核心状态（`GET /export/status` 或现有等价接口；先读 `api/export.js` 确认）、Ctrl+K 提示。
  - `ProjectShell.vue`：布局 + `<router-view>` + `<DialogHost>`；进入时 `shell.loadProject(dramaId)`，`projectViews.load(episodeId, {drama})`；离开时 `rememberView`。窄屏（<900px）左栏折叠成抽屉。
- [ ] **Step 8: 改路由**：新增上表路由，旧路由保留但 `beforeEach` 先重定向；`episode-storyboard` 的 `resolveDrama` 扫描逻辑删除，改用 `legacyRoutes`（`episodeToDrama` 通过 Task 3 的 `GET /episodes/:id` 注入，接口未就绪时回退到现有 `resolveDrama`）。更新 `account.test.js:65` 中引用的路由名（先读测试再改）。
- [ ] **Step 9: 四个视图去掉 `ViewSwitcher`**；原先塞进 `<slot>` 的页面级按钮（如时间线的“导出”）暂时放进各视图自己的工具条，保证功能不丢。删除 `ViewSwitcher.vue`。ExportPage / BatchPage / ReferenceLibrary / ShotWorkbench 的返回键改指向新路由。
- [ ] **Step 10: i18n**：在 `messages/shell.js` 填入所有外壳文案（中英），把 `shell/**` 全部文件登记进 `test/i18n-migrated/shell.json`。
- [ ] **Step 11: 运行 `node --test test/*.test.js`（renderer 全量）**，Expected: 全部 PASS。再 `pnpm --filter @talekiln/renderer build` 确认能打包。
- [ ] **Step 12: 用浏览器走一遍**：`/new-project` 创建项目 → 进入 `/p/<id>/e/<ep>/script`，依次点四个标签；切语言；打开生成 / 导出菜单；点“导出成片”置灰项看到原因。截图存 `.scratch/shots/`（不提交）。
- [ ] **Step 13: 提交**（`git add` 上述路径；`pnpm secrets:scan`）。完成后在 `docs/superpowers/notes/shell.md` 写给后续 lane 的使用说明（如何注册 action / dialog / 菜单项 / 翻译、如何登记 i18n 已迁移文件）。**完成后立刻通知协调者，波 1 才能开始。**

---

## Task 3: 后端 — 可撤销的重新生成分镜与缺失接口（波 0，与前端并行）

**Files:**
- Modify: `packages/local/src/routes/storyboards.js`、`packages/local/src/services/storyboardService.js`（先 `grep -rn "resetGraph" packages/local/src` 找到调用点）、`packages/local/src/kernel/compat.js`（如需新增“整集替换”的事务封装）
- Create: `packages/local/src/routes/episodes.js`（`GET /episodes/:id`）；在 `routes/index.js` 注册
- Modify: `packages/local/src/routes/{scenes,characters,characterLibrary}.js` 或相应注册处（补缺失接口）
- Test: `packages/local/test/storyboardRegenerate.test.js`、`episodeLookup.test.js`、`legacyGaps.test.js`

**Interfaces:**
- Produces:
  - `GET /episodes/:id` → `{ id, drama_id, episode_number, title }`（404 用统一错误体）。
  - `POST /episodes/:id/storyboards`：行为改为“生成新分镜 → 用**一次内核事务**把旧镜头全部删除并加入新镜头（同事务内 materialize 到旧表）→ 返回 `{ ..., tx_id, can_undo: true }`”，不再调用 `resetGraph`。事务可被 `POST /episodes/:id/undo` 一步撤销，撤销后旧镜头、其首帧 / 视频版本与采用关系恢复；`redo` 回到新分镜。进入此流程前调用快照钩子 `backupHooks.beforeDestructive(episodeId, 'regenerate-storyboard')`（Task 5 提供 `packages/local/src/backup/localSnapshot.js` 的 `snapshotEpisode(dramaId, reason)`；Task 5 未完成时钩子为空函数，不要阻塞）。
  - `GET /dramas/:id/scenes`、`POST /characters/:id/add-to-team-library`（前端在调、后端未注册；先读 `apps/renderer/src/api/scenes.js`、`useCharacters.js` 等找到确切路径与形状，保持前端不改）、`POST /episodes/:id/characters/extract`（现在是空实现：实现为调用现有“提取角色 / 场景 / 道具”的生成服务并返回已创建项；找不到可复用的服务时，返回 501 + 明确错误码，并在 notes 里说明，前端 T7 据此降级）。
  - 同时修前端 bug：`apps/renderer/src/composables/filmCreate/useCharacters.js:408` 的 `dramaAPI.getCharacters` 改为现有的 `GET /dramas/:id/characters`（`api/studio.js:53` 已有示例）。**这一行的修改归 T3**，T7 不要再碰这个文件之外的逻辑。

- [ ] **Step 1: 阅读**：`docs/kernel-design.md` §3、§12；`kernel/compat.js`；`kernel/legacy.js`；找出 `resetGraph` 的所有调用点与现有的 `deleteShot`/`addShot` 意图（`kernel/intentTable.js`）。
- [ ] **Step 2: 写失败测试 `storyboardRegenerate.test.js`**（用假服务商，参考 `packages/local/test/kernelCompat.test.js` 的起服务方式）：建项目 + 3 条剧本行 + 已有 2 个镜头且其中 1 个有已采用的首帧版本；调用重新生成；断言 ① 镜头数与内容为新分镜 ② `can_undo=true` ③ undo 后镜头 id、首帧采用版本与旧表行都恢复 ④ redo 回新分镜 ⑤ 全程 `graph_ops` 里没有“重置”操作、`seq` 单调增加 ⑥ 内核一致性不变量（调用 `packages/kernel` 的 `staleSet` 与从零重建结果一致，参考 I5）。
- [ ] **Step 3: 运行确认失败**；**Step 4: 实现**（事务封装放在 `kernel/compat.js` 一个函数 `replaceEpisodeShots(db, episodeId, newShots, {txId})`，内部只用现有意图 / op）；**Step 5: 测试通过**。
- [ ] **Step 6: `GET /episodes/:id` 测试 + 实现**。**Step 7: 缺失接口各一个测试 + 实现**。**Step 8: 修 `useCharacters.js:408`**（renderer 里为它补一个最小的单元测试，或在 notes 里写明手动验证）。
- [ ] **Step 9: 运行 `cd packages/local && node --test test/*.test.js`（约 1–2 分钟，输出用 `sed 's/\x1b\[[0-9;]*m//g'` 去颜色，看 `ℹ pass`/`ℹ fail`）**，再跑 `node packages/kernel/test/conformance/report.js`（后台运行，6 分钟），Expected: 0 失败；`git checkout docs/kernel-conformance.md`。
- [ ] **Step 10: 提交；notes 写 `docs/superpowers/notes/backend-regenerate.md`**（含 kernel-design.md §12.5 需要的文字更新建议）。

---

## Task 4: 后端 — 草稿 / 成片质量档（波 0）

**Files:**
- Create: `packages/local/src/generation/qualityProfiles.js`
- Modify: `packages/local/src/generation/service.js`、`packages/local/src/generation/models.js`（只在 `pickModel` 前后加质量档参数，不改现有选择顺序）、`packages/local/src/routes/drama.js`（`PUT /dramas/:id/quality`、`GET` 带回 `quality`）、`packages/local/src/db`（迁移：`dramas.quality TEXT DEFAULT 'final'`，先读现有迁移机制）
- Create: `packages/local/src/routes/qualityRerun.js`（`GET /episodes/:id/quality/draft-nodes`、`POST /episodes/:id/quality/rerun`）
- Test: `packages/local/test/qualityTier.test.js`

**Interfaces:**
- Produces:
  - `qualityProfiles.js`：`PROFILES = { draft: { bailian: { image: {model, size}, video: {model, resolution}, ... }, ark: {...} }, final: null }`、`profileFor(quality, provider, kind): { model?, resolution?, size? } | null`。草稿档的具体取值：先读 `providers/bailian/*`、`providers/ark/*` 与 `docs/bailian-flow-coverage.md` 里已验证过的模型和参数，选已验证的最便宜档（百炼视频：`wan2.2-kf2v-flash`，分辨率取适配器支持的最低值；图片：最小支持尺寸）；取值写在数据表里并在 notes 记录依据。
  - `PUT /dramas/:id/quality` body `{ quality: 'draft'|'final' }` → `{ quality }`；非法值 400。
  - 生成服务读取项目的 `quality`，把档位对应的 `model` / `resolution` 作为**默认**（用户在节点上显式选的模型优先）；新产物的版本元数据写入 `quality`（addVersion 的 `metadata.quality`），**不进入 cacheKey**，因此切换档位不会让任何产物过期。
  - `GET /episodes/:id/quality/draft-nodes` → `{ count, nodes: [{ node, kind, shot }], estimate: { amount, currency } }`（估价用现有 `spend` 估价函数，先读 `packages/local/src/spend`）；`POST /episodes/:id/quality/rerun` → 对这些节点以 `final` 档入队（走现有队列 `POST /episodes/:id/generate` 的内部函数，`force: true` 使其重生成而不是复用缓存），返回入队清单。执行前调用 `backupHooks.beforeDestructive(episodeId, 'quality-rerun')`。
- Review Focus 测试：切档位后 `GET /episodes/:id/graph` 的 `stale` 集合不变；`draft-nodes` 只含 `quality=draft` 的采用版本；估价数与入队任务的预估合计相等。

- [ ] **Step 1: 阅读**：`generation/service.js` 的 `buildParams`、`addVersion + adoptVersion` 路径（约第 105–300 行、第 380 行起），`queue/providerAdapter.js`，spend 估价，现有 DB 迁移方式。
- [ ] **Step 2: 写失败测试**（假服务商）：① 默认 `quality=final`，行为与现状一致（用现有测试作回归）② 设为 draft 后入队任务的 `model`/`resolution` 来自档位表 ③ 节点显式模型优先 ④ 产物版本 `metadata.quality==='draft'` ⑤ 切回 final 后 stale 集合不变 ⑥ `draft-nodes` 与 `rerun` 行为、估价一致。
- [ ] **Step 3–6**：实现 → 通过；迁移文件；`PUT` 路由；rerun 路由。
- [ ] **Step 7: 全量 `packages/local` 测试 + 内核一致性报告**（同 Task 3 Step 9）。
- [ ] **Step 8: 提交；notes `docs/superpowers/notes/backend-quality.md`**（档位表与依据、与 `docs/bailian-flow-coverage.md` 的差异）。

---

## Task 5: 后端 — 完整项目备份与本地快照（波 0）

**Files:**
- Create: `packages/local/src/backup/kernelSnapshot.js`、`packages/local/src/backup/localSnapshot.js`、`packages/local/src/routes/projectBackup.js`
- Modify: `packages/local/src/services/dramaExportService.js`（`EXPORT_VERSION` → `'1.5'`，ZIP 内追加 `kernel/episode-<n>.json`）、`packages/local/src/services/dramaImportService.js`（识别 1.5，还原内核快照）、`packages/local/src/routes/index.js`（注册）
- Test: `packages/local/test/kernelSnapshot.test.js`、`projectBackup.test.js`、`localSnapshot.test.js`

**Interfaces:**
- Produces:
  - `kernelSnapshot.js`：`exportEpisode(db, episodeId): Snapshot`（图、各节点版本及采用关系、`graph_ops` 历史、`seq`；媒体仍由 ZIP 里的文件携带）；`importEpisode(db, newEpisodeId, snapshot, idMap): { applied }`（把旧 id 映射到新项目里的新 id，包括镜头 / 剧本行 / 版本 / 媒体路径；映射表来自 `dramaImportService` 创建旧表行时产生的 id 对应关系）。**风险**：id 映射复杂。要求先写“导出再导入后，`staleSet`、采用版本、撤销可用”的测试；如果在合理工作量内无法还原撤销历史，退化为：只还原图与采用版本，历史清空（`can_undo=false`），并在 UI 文案里如实说明，notes 记录。
  - `POST /dramas/:id/backup/full` → 流式下载 `*.talekiln.zip`（ZIP 版本 1.5）；`POST /dramas/restore`（multipart `file`）→ `{ drama_id }`，**总是新建项目**；包损坏、版本高于支持 → 400 带错误码 `BACKUP_CORRUPT` / `BACKUP_VERSION_UNSUPPORTED`，且不留下半成品项目（失败时在同一事务里回滚，已拷贝的媒体文件删除）。
  - `localSnapshot.js`：`snapshotEpisode(dramaId, reason): { id, created_at, file }`（保存在应用数据目录 `snapshots/<dramaId>/`，保留最近 5 份，超出的自动删除）；`listSnapshots(dramaId)`；`restoreSnapshot(dramaId, id)` → 恢复为新项目（同 restore）。路由：`GET /dramas/:id/snapshots`、`POST /dramas/:id/snapshots/:sid/restore`。
  - `backupHooks`：`packages/local/src/backup/hooks.js` 导出 `beforeDestructive(episodeId, reason)`（默认空；本任务把它接到 `localSnapshot.snapshotEpisode`，Task 3 / Task 4 调用它）。**先创建 hooks.js 的空实现并提交，使 Task 3 / 4 可以引用**。
  - 兼容：旧版（≤1.4）ZIP 仍可导入（无内核快照时走 `importLegacy` 重建）。
- Review Focus 测试：损坏包不留项目；高版本包报错；恢复后原项目逐字段不变；快照第 6 份写入时最老的被删。

- [ ] **Step 1: 先提交 `backup/hooks.js` 空实现**（让其他任务能引用）。
- [ ] **Step 2: 阅读** `services/dramaExportService.js`、`dramaImportService.js`、`backup/service.js`（云备份用同一个 ZIP 格式，要保持兼容）、`kernel/store.js`、`kernel/legacy.js`。
- [ ] **Step 3: 写失败测试 `kernelSnapshot.test.js`**：建项目 + 剧本行 + 镜头 + 图片版本（采用）+ 几次编辑；导出快照、导入到新剧集；断言图结构等价（忽略 id）、stale 一致、采用版本一致；再断言撤销可用（或退化模式下 `can_undo=false`）。
- [ ] **Step 4–6**：实现 `kernelSnapshot`、导出 / 导入 1.5、路由；测试通过。
- [ ] **Step 7: `projectBackup.test.js`**（HTTP 级：full 导出 → restore → 新项目；损坏包；高版本包；旧版 1.4 包）。
- [ ] **Step 8: `localSnapshot.test.js`**（保留 5 份、restore 为新项目）。
- [ ] **Step 9: 全量 `packages/local` 测试 + 一致性报告**；确认云备份相关测试（`backupService`）仍通过。
- [ ] **Step 10: 提交；notes `docs/superpowers/notes/backend-backup.md`**。

---

## Task 6: 剧本 lane（波 1）

**Files:** 见归属表。Modify `ScriptView.vue`；Create `src/components/script/{AiWriteDialog,ImportScriptDialog,EpisodeDialogs,ProjectSettingsDialog,FullTextEditor}.vue`、`src/utils/scriptTools.js`、`src/api/episodes.js`；填 `shell/actions/script.js`、`shell/dialogs/script.js`、`messages/script.js`。
Test: `test/scriptTools.test.js`、`episodesApi.test.js`。

**Interfaces:**
- Consumes: Task 1 `t()`；Task 2 的 `registerAction`、`dialogs` 表、`useShellStore().episodes`；Task 3 的 `GET /episodes/:id`。
- Produces（action id 固定）: `script.addEpisode`、`script.importEpisodes`（批量导入，搬 `EpisodeBatchImportDialog.vue`）、`script.renameEpisode`、`script.deleteEpisode`、`script.reorderEpisodes`；对话框 id: `script.aiWrite`、`script.importScript`、`home.projectSettings`（项目设置：标题、画幅、风格、语言、片段时长、大纲，写入 `PUT /dramas/:id`，字段与 `DramaDetail` / `FilmCreate` 的项目设置保持一致）。

- [ ] **Step 1: 盘点**：读 `DramaDetail.vue` 的剧集管理与项目信息部分、`FilmCreate.vue` 的剧本生成 / 导入 / 选择剧本部分、`useStoryGeneration.js`，列出每个接口与参数（写进 notes）。
- [ ] **Step 2: 纯函数先行**：`scriptTools.js` 导出 `splitNovelIntoEpisodes(text, {by})`、`buildStoryRequest(form)`、`episodeOrderAfterMove(episodes, from, to)`、`canEditFullText({hasShots})`（生成分镜后返回 false）。每个先写失败测试（含空文本、超长文本、重复章节名、中英文混排）再实现。
- [ ] **Step 3: 工具条**（对照线框“剧本视图”）：AI 写剧本、导入剧本 / 小说、提取角色·场景·道具（调用 T7 注册的 `assets.extract`，未注册时 toast）、按剧本生成分镜（调用 T8 的 `storyboard.regenerate` 或首次 `storyboard.generate`，未注册时 toast）、逐行 / 全文切换（`canEditFullText`）。
- [ ] **Step 4: 检查器**：选中行显示台词编辑、挂的镜头与状态、出场 `@角色 #场景 #道具`（来自镜头绑定 + 剧本文本里的引用，数据从 T7 的 `useAssetsStore` 读取，未就绪时隐藏该区块）、按钮“重新配音这一镜”（`POST /episodes/:id/voiceover`，参考 `api/voiceover.js`）、“在分镜中查看”（导航，保持选择）、“打开镜头工作台”。
- [ ] **Step 5: 分集管理**：新建 / 批量导入 / 改名 / 删除（删除前确认，且提示可通过“项目备份”恢复）/ 排序，完成后 `useShellStore().loadProject()` 刷新左栏。
- [ ] **Step 6: i18n**：`messages/script.js` 中英文；登记 `test/i18n-migrated/script.json`（`views/ScriptView.vue`、`components/script/*`、`shell/*/script.js`）。
- [ ] **Step 7: 测试 + 浏览器走查**：新建项目 → AI 写剧本（假服务商）→ 导入小说 → 增删改集 → 全文 / 逐行；中英文各截图一次。
- [ ] **Step 8: 提交 + notes**。

---

## Task 7: 资产 lane（波 1）

**Files:** 见归属表。
Test: `test/assetsStore.test.js`、`assetPanelModel.test.js`、`assetGeneration.test.js`。

**Interfaces:**
- Produces:
  - `useAssetsStore()`（`stores/assets.js`）：`byKind: { characters, scenes, props }`、`refs(shotRef)`、`load(dramaId)`、`create/update/remove(kind, ...)`、`lock(kind, id, imageId)`。**全局可引用**：`resolveMention('@林夏' | '#旧书店')` 返回资产对象，供所有视图的检查器、提示词编辑器使用。
  - `components/assets/AssetPanel.vue`（左侧可收起面板，四个视图都能打开，由外壳的 `assetsPanelOpen` 控制；线框“画布视图与资产面板”左侧）。
  - `AssetLibrary.vue`（`/p/:dramaId/assets`，取代 `ReferenceLibrary.vue`，改名并删除旧文件）：角色 / 场景 / 道具三个标签；每项编辑描述、提示词、视觉锚点、多阶段造型；候选图生成、上传、锁定 / 解锁、自动挑选；存入 / 导入全局库；方舟可用时 SD2 认证与 SD2 音色。
  - Action: `assets.extract`（从剧本提取）、`assets.importFromGlobal`；对话框: `assets.pick`（选择资产，供提示词编辑器的 `@` 补全）。
- 数据：继续使用旧表与现有 REST；**出图改走队列**（`api/queuedGeneration.js` 的 `queueShot` 不适用于资产图，查看 `POST /episodes/:id/generate` 是否支持资产类型；不支持时，先在 notes 里记录，并临时保留对 `POST /images` 的调用但在 `generation.legacy_enabled=false` 时显示明确说明“需要在 AI 配置里开启旧版直连生成”并禁用按钮，不允许出现 402 弹窗。**不得修改后端队列代码**，由协调者另行决定）。

- [ ] **Step 1: 盘点** `FilmCreate.vue`（角色 / 场景 / 道具提取与 CRUD、视觉锚点、多阶段造型、全局库、SD2）和 `composables/filmCreate/{useCharacters,useProps,useScenes}.js`、`DramaDetail.vue` 的素材部分、`MediaLibrary.vue`、`ReferenceLibrary.vue`（含 `utils/referenceLibrary.js`），写功能对照表进 notes。
- [ ] **Step 2: store + 纯函数先行**（失败测试 → 实现）：`resolveMention`（同名、重名、带括号别名、找不到）、`assetCounts`、`candidateOrder`。
- [ ] **Step 3: AssetPanel**，再 AssetLibrary 三个标签，再全局库对话框（合并 FilmList 的三个素材对话框的功能；这一对话框的入口由 T11 在首页接入，本 lane 导出组件 `components/assets/GlobalLibraryDialog.vue`）。
- [ ] **Step 4: 资产出图的队列方案**（见上）。
- [ ] **Step 5: i18n + 登记；浏览器走查**（创建角色 → 生成候选（假服务商）→ 锁定 → 存入全局库 → 在另一项目导入）。
- [ ] **Step 6: 删除 `ReferenceLibrary.vue` 与 `utils/referenceLibrary.js` 中不再使用的部分，更新引用它的测试。提交 + notes。**

---

## Task 8: 分镜 lane（波 1）

**Files:** 见归属表。Test: `test/shotInspectorModel.test.js`、`frameSlots.test.js`、`shotParams.test.js`、`storyboardMultiSelect.test.js`。

**Interfaces:**
- Produces:
  - `components/shot/ShotInspector.vue`（props: `shotId: string`, `compact?: boolean`）：被分镜页、镜头工作台使用；T6 / T10 在剧本 / 画布里也引用它（它们读取同一个组件，未就绪时先不显示）。
  - `components/shot/ShotParamsDialog.vue`（更多镜头参数：灯光 12 项、景深 4 项、视角、布局锚点、氛围、动作、对白、旁白、按配音拆分、对白 / 旁白配音）。
  - Action: `storyboard.generate`（首次生成分镜）、`storyboard.regenerate`（调用 Task 3 改造后的接口，**成功后提示“可用撤销恢复上一版”**）、`storyboard.inferParams`（批量推断景别运镜）、`storyboard.addShot`；对话框: `storyboard.shotParams`。
- 功能范围（见 spec §4.2 分镜部分）：卡片 / 表格、多选批量生成或删除、`ShotInspector`（画面描述、视频提示词 + AI 润色 + 模板、资产绑定与 @图片N 顺序、首帧 / 尾帧槽位（生成 / 上传 / 提示词 / 历史 / 超分）、尾帧衔接、景别 / 运镜 / 时长）、通用片段模式（仅当模型能力支持多参考图时显示，读取 `providers/capabilities` 对应的前端接口）、镜头工作台整页保留，**删除“旧流程生成”按钮**，并把 `ShotWorkbench.vue:326` 改走队列；`ReferenceLibrary.vue:160`/`ShotWorkbench.vue:326` 的 `POST /images`/`/videos` 调用全部移除。
- 写入路径：所有镜头字段编辑走内核 `setShotField` 等意图（`kernelAPI.intent`），资产绑定走 `PUT /storyboards/:id`（已改道）。

- [ ] **Step 1: 盘点** FilmCreate 的第 5–7 步（分镜配置、单镜图片 / 视频、通用片段、视频参数对话框）、`StoryboardPage.vue`、`ShotWorkbench.vue`、`utils/{storyboardTable,shotWorkbench,storyboardMedia}.js`、`UniversalSegmentOmniAtEditor.vue`、`PromptEditor.vue`，写对照表进 notes。
- [ ] **Step 2: 纯函数先行**（失败测试 → 实现）：`frameSlots`（首 / 尾帧状态机：无 → 生成中 → 有 → 过期，含“用上一镜尾帧”衔接）、`shotParams` 选项表与校验、`atImageOrder`（@图片N 与参考图顺序互相转换，含删除中间一张后的重排）、`multiSelectModel`（Shift/Ctrl 选择、批量操作可用性）。
- [ ] **Step 3: ShotInspector → ShotParamsDialog → 卡片 / 表格与多选 → 工具条**。
- [ ] **Step 4: 通用片段模式**按能力开关；Grok 格式转换不实现。
- [ ] **Step 5: 重新生成分镜**接 Task 3 的接口；若接口尚未完成，用 `storyboard.regenerate` 调用现有路由并带确认对话框“会清空这一集的撤销历史”，Task 3 完成后切换（读取 `can_undo` 字段判断）。
- [ ] **Step 6: i18n + 登记；浏览器走查**（假服务商：生成分镜 → 编辑镜头 → 生成首帧 → 生成视频 → 重新生成分镜 → 撤销）。
- [ ] **Step 7: 提交 + notes。**

---

## Task 9: 生成与导出 lane（波 1）

**Files:** 见归属表。Test: `test/pipelinePlan.test.js`、`exportMenuActions.test.js`、`exportSrt.test.js`、`exportDialogModel.test.js`。

**Interfaces:**
- Consumes: Task 2 的菜单 / action；Task 4 的 `draft-nodes` 与 `rerun`；Task 5 的 `/dramas/:id/backup/full`。
- Produces: 对 `menus.js` 中所有 `generate.*` 与 `export.*` action 的实现；`composables/usePipeline.js`（`usePipeline(episodeId)`：`plan()` 返回步骤与预估花费，`run()`、`pause()`、`resume()`、`cancel()`，状态 `idle|running|paused|done|failed`）；`utils/pipelinePlan.js`（纯函数：`buildPlan(state)` 根据现有进度跳过已完成步骤）；`components/export/ExportDialog.vue`（取代 `ExportPage`：分辨率、帧率、编码器、输出路径、AIGC 标识、草稿产物提示、开始 / 取消 / 打开文件夹）。

- [ ] **Step 1: 盘点** `FilmCreate.vue` 的一键全流程（9 步，含暂停 / 倒计时）、`onExportStoryboardSheet`（约 5673 行）、`onExportNarrationSrt`（约 5788 行）、`ExportPage.vue`、`BatchPage.vue`、`TimelineEditor.vue` 的导出入口、`packages/local/src/export/service.js`。
- [ ] **Step 2: 纯函数先行**：`exportSrt.js`（由剧本行与配音时间生成，含空行、重叠、超长行拆分、毫秒进位）、`exportStoryboardSheet.js`（沿用已有，补测试）、`pipelinePlan.js`（失败测试：已有分镜则跳过生成分镜；有锁定参考图则跳过出图；暂停点位置）。
- [ ] **Step 3: `usePipeline`**：只负责编排与状态机，实际调用走已有 API；保留暂停 / 继续，去掉阶段间倒计时；执行前显示计划与预估，需用户确认。
- [ ] **Step 4: 生成菜单 8 个 action**；`generate.rerunDraft` 先 `GET draft-nodes` 展示数量 / 预估，确认后 `POST rerun`。
- [ ] **Step 5: 导出菜单 8 个 action**：`export.video` 打开 `ExportDialog`，没有渲染核心时禁用（`menus.js` 已处理）；`export.jianying` / `export.premiere` 复用现有导出任务；`export.srt`、`export.storyboardSheet` 用上面纯函数；`export.projectZip` 用现有项目导出；`export.fullBackup` 调 `POST /dramas/:id/backup/full`；`export.assetPack`（素材包：按镜头整理首帧、视频、配音；后端缺接口时放进 notes 并先在前端用现有文件 URL 打 ZIP，若工作量过大则在菜单里置灰并 notes 记录，不阻塞其他项）。
- [ ] **Step 6: 路由 `episode-export`** 改为重定向到 timeline 并打开 `ExportDialog`；`BatchPage` 搬进外壳（返回键与标题）。
- [ ] **Step 7: i18n + 登记；浏览器走查**（每个导出项点一遍；没有渲染核心时的置灰；假服务商跑一次一键成片的计划与暂停 / 继续）。
- [ ] **Step 8: 提交 + notes。**

---

## Task 10: 画布 lane（波 1）

**Files:** 见归属表。Test: `test/canvasAssetRefs.test.js`。

**Interfaces:**
- Consumes: Task 7 的 `useAssetsStore`；Task 8 的 `ShotInspector`（节点为镜头时嵌入，未就绪则忽略）。
- Produces: 画布工具条“显示资产引用”开关（把镜头引用的角色 / 场景 / 道具画成**只读**的资产节点和连线，不写入内核，位置自动排布在镜头左侧）；节点检查器增加“应用并重新生成”（`setNodeParam` 后走 `gen.ask`）和“版本历史”（打开已有 `VersionHistoryDrawer` 并定位到该节点）；“只看过期”开关读取外壳的待生成标志；`utils/canvasAssetRefs.js`: `buildAssetRefLayout(graph, assets)`（纯函数：无引用 / 引用已删除的资产 / 同一资产被 100 个镜头引用时的布局都不崩）。

- [ ] 步骤同上：盘点 `CanvasView.vue` 与 `components/canvas/*` → 纯函数失败测试 → 实现 → i18n → 浏览器走查（含 100 镜头压力数据：用脚本通过 `POST /intent` 批量建镜头，不超过 30 秒）→ 提交 + notes。

---

## Task 11: 首页 lane（波 1）

**Files:** 见归属表。Test: `test/homeModel.test.js`、`lastVisited.test.js`。

**Interfaces:**
- Consumes: Task 2 的 `shell.rememberView`/`lastView`；Task 5 的 restore 接口；Task 7 的 `GlobalLibraryDialog`。
- Produces: 首页（线框“首页与新建项目”）：四个新建入口（一句话写剧本 → `NewProject`、导入剧本 / 小说、空白项目、导入项目包 / **从完整备份恢复**）；项目卡片点击进入上次停留的集和视图；卡片更多菜单（导出项目包、**完整备份**、改名、删除（删除前自动本地快照一次，提示可从备份恢复））；顶栏入口（全局素材库、模板、任务、花费、设置、语言切换）；示例项目入口保留；`MediaLibrary` 与全局素材库合并为一个页面的四个标签；`TaskCenter` 保持页面形式，同时被外壳的抽屉复用其数据源。`utils/homeModel.js`：`cardNextStop(project, lastVisited)`（没有记录 / 集已被删除时回退到第 1 集剧本，没有剧集时回退到剧本空状态）。

- [ ] 步骤：盘点 `FilmList.vue`（含 729、768 行的跳转）→ 纯函数失败测试 → 实现 → i18n（`FilmList` 整页迁移）→ 浏览器走查（新建 4 种入口、卡片进入、备份恢复）→ 提交 + notes。

---

## Task 12: 清理、端到端、文档与验收（波 2，协调者）

**Files:**
- Delete: `views/{FilmCreate,DramaDetail,DramaCanvas,FreeCreate}.vue`、`components/dramaCanvas/`、`composables/useCanvas*.js`、`utils/{dramaCanvasAdapter,canvasLayout,canvasWorkflow}.js` 及其测试、路由里的旧记录与 `legacyRoutes` 之外的所有 `/film/`、`/drama/` 引用
- Modify: `docs/phase1-status.md`、`docs/bailian-flow-coverage.md`、`docs/kernel-design.md` §12.5、`docs/phase3-plan.md`（决定记录）、`docs/windows-test-results/2026-10-03.md`
- Test: `apps/renderer/test/noLegacyLinks.test.js`、`apps/renderer/e2e/` 更新

- [ ] **Step 1:** 删除前确认每个 lane 的 notes 中“功能对照表”均已勾完；缺口要么补齐要么写入 `docs/phase3-plan.md` 的“已知缺口”。
- [ ] **Step 2:** `noLegacyLinks.test.js`：扫描 `src/` 除 `utils/legacyRoutes.js` 外不得出现 `'/film/'`、`'/drama/'`、`` `/film/ ``、`` `/drama/ ``。
- [ ] **Step 3:** 删除旧页面与死代码；`pnpm --filter @talekiln/renderer build` 通过；`composables/filmCreate/*` 里已搬走或不再使用的文件一并清理（先 grep 引用）。
- [ ] **Step 4:** 全量测试：`pnpm test`（renderer + local + kernel）、一致性报告、`pnpm secrets:scan`、`pnpm licenses:check`。
- [ ] **Step 5:** e2e：更新 `apps/renderer/e2e/run.mjs`，覆盖“首页 → 新建 → 剧本 → 生成分镜 → 时间线 → 导出菜单 → 切英文 → 完整备份 → 恢复”。
- [ ] **Step 6:** 真实浏览器验收（chrome-devtools）：中英文各走一遍，截图附在 PR。
- [ ] **Step 7:** 合并各 lane 的 notes 进上述文档；写测试结果文档；开 PR（基于 `win/four-view-impl`，包含波次提交），PR 描述写明：已验证项、只能用假服务商验证的项、遗留缺口。**不合并、不改 draft 状态。**

---

## 自检（对照 spec）

- **覆盖**：§4.1 外壳 → Task 2；§4.2 剧本 / 分镜 / 时间线 / 画布 → Task 6 / 8 / 9 / 10；§4.3 资产 → Task 7；§4.4 生成菜单 → Task 9（含 §10.2 的重跑草稿）；§4.5 导出菜单 → Task 9（快速拼接已删除）；§4.6 首页 → Task 11；§5 后端与 D3 → Task 3；§6 重定向 → Task 2；§7 测试 → 各任务 + Task 12；§10.2 质量档 → Task 4；§10.3 备份 → Task 5（+ Task 9 / 11 入口）；§10.4 i18n → Task 1 及各 lane；D5 字幕烧录 / 水印 → 仅记录缺口（Task 12 Step 1）。
- **已知偏离“每步都附完整代码”**：本计划只在契约层（Task 1 i18n、外壳接口）给出完整代码；各 lane 给出精确的接口、文件归属、测试用例清单与验收标准，由 worker 在盘点旧代码后写出实现。原因：旧功能散布在 1 万多行的单文件里，不先读代码无法写出准确实现；强行写会产生与现有接口不符的假代码。
- **类型一致性**：action id、对话框 id、路由 name、`useShellStore` 字段、`useAssetsStore` 方法名、`backupHooks.beforeDestructive`、`ShotInspector` props 在各任务间保持同名；如需改名，先改本文件再通知所有 worker。
