# ProjectShell 使用说明（给 Lane 6–11 与 Task 12）

范围：Task 1（i18n）与 Task 2（外壳、路由、action / 对话框 / 菜单注册表）。本文先写“与计划不同的地方”，再写各 lane 怎么接入。

## 1. 与计划的差异（以本节为准）

1. **`menus.js` 的 `requires` 多了一个取值 `'draft'`**（当前集存在草稿档产物，`generate.rerunDraft` 用）。`requires` 也可以是数组。原因键固定为 `shell.menu.reason.{episode,shots,timeline,renderCore,draft}`。没有当前集时，所有带 `requires` 的项统一给 `shell.menu.reason.episode`。项目级项（`generate.batchEpisodes`、`export.projectZip`、`export.assetPack`、`export.fullBackup`）不写 `requires`，没有集也可用。
2. **action 有两种注册方式**，效果相同：
   - 在自己的 `shell/actions/<lane>.js` 里 `export default { 'script.addEpisode': (ctx) => ... }`（推荐；`actions/index.js` 的 `installActions()` 统一注册，ProjectShell 挂载时调用，幂等）。
   - 直接调用 `registerAction(id, fn)`。
   `registry.js` 额外导出 `unregisterAction`、`setActionNotifier`（测试用）。处理函数抛错不会向外抛：提示 `shell.action.failed`（参数 `{id, message}`）。未注册 id 提示 `shell.action.notReady`（参数 `{id}`）。
3. **对话框组件通过 `emit('close', result)` 结束**，`openDialog(id, props)` 的 Promise 以 `result` 兑现；同一时刻只开一个，打开第二个时第一个以 `undefined` 结束。`dialogs/index.js` 额外导出 `registerDialog(id, loader)`、`closeDialog(result)`、`currentDialog`、`setDialogNotifier`。未登记的 id 提示 `shell.dialog.notReady`（参数 `{id}`）并返回 `undefined`。
4. **`stores/shell.js` 比计划多的字段 / 动作**：`loading`、`loadError`、`aspectRatio`、`style`（计算属性）、`staleOnly`、`assetsPanelOpen`、`landingPath(dramaId)`、`refreshTasks()`、`setStaleOnly(v)`、`openAssetsPanel()`、`closeAssetsPanel()`。`setQuality(q)` 返回 `true/false`（404 时只本地保存并返回 `true`；其它失败回滚并返回 `false`）。`lastView(dramaId)` 返回 `{ episodeId, view } | null`。测试用 `setShellApi(fake)` 注入接口。
5. **路由**：`/p/:dramaId(\d+)` 是 `ProjectShell` 的父路由；`/p/:dramaId` 对应子路由 `project-home`（`beforeEnter` 里 `loadProject` 后重定向到 `landingPath`）。旧路由记录保留，但与新路由重名的已改名为 `legacy-*`（`legacy-episode-script|storyboard|timeline|canvas|export`、`legacy-shot-workbench`、`legacy-batch`）；旧 `storyboard`、`reference-library`、`drama-detail`、`film`、`film-canvas` 名字不变。它们永远走不到渲染：`router.beforeEach` 先经 `resolveLegacyRoute` 重定向。`/episodes/:id/storyboard` 的 `resolveDrama` 扫描已删除。
6. **`GET /episodes/:id`（Task 3）还没有时**，`shell/api.js` 的 `episodeToDrama` 回退为扫描 `GET /dramas`（与原 `resolveDrama` 相同）。Task 3 合并后无需改前端。
7. **`/episodes/:id/export` 目前重定向到 `/p/:drama/e/:id/export`（页面形式）**，与计划一致；Task 9 改为对话框时，把 `episode-export` 子路由换成 `beforeEnter: (to) => { queueMicrotask(() => openDialog('export.video', {...})); return { name: 'episode-timeline', params: to.params, replace: true } }` 即可（`openDialog` 只设置“当前对话框”状态，`DialogHost` 挂载后立即渲染，所以放在重定向之后调用即可）。
8. **改动了计划外的 `utils/episodeContext.js`**：`episodeOfRoute` 现在优先读 `route.params.episodeId`（旧的 `params.id` 仍可用）。否则命令面板 / 版本历史 / 导演面板在 `/p/...` 下取不到当前集。
9. **子页面用 `<router-view :key>` 重建**（key = 路由名 + episodeId + shotId），所以切集 / 切镜头时各视图的 `onMounted` 会重新执行，视图自己不必再监听路由参数。视图读取路由参数的方式变了：`route.params.episodeId`、`route.params.dramaId`（不再有 `route.params.id` / `route.query.drama`）。
10. **渲染核心状态**：`GET /export/options?episode_id=` 返回 503 且 `code === 'CORE_UNAVAILABLE'` 视为不可用，其它失败按“未知 = 可用”处理（避免网络抖动把导出按钮误置灰）。结果存在 `shell.renderCoreOk`。

## 2. 路由表（`name` 固定）

| 路径 | name |
|---|---|
| `/p/:dramaId` | `project-home`（重定向） |
| `/p/:dramaId/e/:episodeId/script` | `episode-script` |
| `/p/:dramaId/e/:episodeId/storyboard` | `episode-storyboard` |
| `/p/:dramaId/e/:episodeId/timeline` | `episode-timeline` |
| `/p/:dramaId/e/:episodeId/canvas` | `episode-canvas` |
| `/p/:dramaId/e/:episodeId/shot/:shotId` | `shot-workbench` |
| `/p/:dramaId/e/:episodeId/export` | `episode-export` |
| `/p/:dramaId/assets` | `assets`（暂指向 `ReferenceLibrary.vue`，Lane 7 替换为资产页） |
| `/p/:dramaId/batch` | `batch` |

跳转请用具名路由：`router.push({ name: 'episode-script', params: { dramaId, episodeId } })`。旧路径（`/film/...`、`/drama/...`、`/episodes/...`、`/project/...`）仍可用，但会多一次异步重定向，新代码不要再写。

## 3. 怎么接入

### 3.1 注册 action

在自己的文件 `shell/actions/<lane>.js`（只有该 lane 改）：

```js
export default {
  'script.addEpisode': async (ctx) => {
    // ctx = { router, route, dramaId, episodeId, openDialog, store }  store 是 useShellStore()
    await ctx.openDialog('script.addEpisode', { dramaId: ctx.dramaId })
  },
}
```

菜单项 / 左栏按钮只写 action id，id 固定见计划 Task 2（`generate.*`、`export.*` 菜单项的 action 与 id 同名）。没有注册时用户看到“功能还没接上”的提示，不会报错。

### 3.2 注册对话框

在 `shell/dialogs/<lane>.js`：

```js
export default {
  'script.aiWrite': () => import('@/components/script/AiWriteDialog.vue'),
}
```

对话框组件接收 `openDialog(id, props)` 传入的 props，完成 / 取消时 `emit('close', result)`；用 `<el-dialog :model-value="true" @closed="emit('close')">` 这类写法即可（组件由 `DialogHost` 挂载，卸载就是关闭）。调用：`const result = await openDialog('script.aiWrite', { ... })`，`import { openDialog } from '@/shell/dialogs'`。

### 3.3 菜单项

菜单数据在 `shell/menus.js`（`GENERATE_MENU`、`EXPORT_MENU`）。id 与分组由 Task 2 固定，**lane 不增删项**；要改某项的可用条件，找 Task 2 的负责人（本文件的 owner）。每一项的文案 key 是 `shell.menu.<id>` 与 `shell.menu.<id>.desc`，已在 `messages/shell.js` 里提供，lane 只需注册同名 action。

### 3.4 翻译

- 每个 lane 只改自己的 `i18n/messages/<lane>.js`，key 必须以文件名为前缀（`script.`、`assets.`、`storyboard.`、`generate.`、`export.`、`canvas.`、`home.`），`zh-CN` 与 `en` 键集合必须一致（`test/i18nParity.test.js` 检查）。`catalog.js` 已经显式合并了全部文件，不需要改。
- 组件里：`import { useI18n } from '@/i18n'`，`const { t } = useI18n()`，模板里 `{{ t('script.title') }}`；带参数 `t('script.lines', { n: 3 })`，文案里写 `{n}`。纯 JS 里 `import { t } from '@/i18n'`。语言切换后所有 `t()` 结果会自动更新。
- 缺失的 key：先回退到中文，再回退到 key 本身，页面不会空白。

### 3.5 登记已迁移文件

迁完一个文件（模板和脚本里不再有中文字面量）后，把它加进自己的 `test/i18n-migrated/<lane>.json`（相对 `src/`，支持 `*` 与 `**`）。`test/i18nLiterals.test.js` 会检查这些文件：模板里去掉 `t()` 调用和注释后不能有中文，脚本里字符串字面量不能有中文。必须保留中文的地方（如语言名“中文”）在该行加 `// i18n-ignore`（模板里用 `<!-- i18n-ignore -->`）。不要登记还没迁完的文件。`shell/**` 已整体登记在 `shell.json`。

## 4. 外壳提供给视图的东西

- `useShellStore()`：`dramaId`、`drama`、`episodes`（按集号排序）、`assetCounts`、`quality`、`tasksRunning`、`renderCoreOk`、`staleOnly`（顶栏“待生成”徽标设置；视图自己读取并过滤）、`assetsPanelOpen`（左栏资产项设置；视图自己决定是否打开资产面板）。
- `provide('shellSummary')`（状态栏中间的摘要，如“共 12 镜 · 48 秒”）：视图里 `const summary = inject('shellSummary', null)`，`if (summary) summary.value = '...'`。离开视图时外壳会清空。

## 5. 手工验证

见下方“验证记录”（Task 2 完成时补充）。
