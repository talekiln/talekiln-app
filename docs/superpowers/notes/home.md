# 首页（四视图改造 Task 11）

规格：spec §4.6、§10.3；计划 Task 11。代码在 `apps/renderer/src/views/{FilmList,NewProject,MediaLibrary,TaskCenter}.vue`、`src/components/home/**`、`src/utils/homeModel.js`、`src/shell/{actions,dialogs}/home.js`、`src/i18n/messages/home.js`。

## 结构

| 文件 | 作用 |
|---|---|
| `views/FilmList.vue` | 首页：顶栏 + 四个创建入口 + 示例 + 项目网格（搜索）。挂 `DialogHost`、`AnnouncementBar`、AI 配置弹窗 |
| `components/home/HomeTopBar.vue` | 全局素材库 / 模板 / 任务 / 花费 / 设置菜单 / 语言切换 |
| `components/home/ProjectCard.vue` | 项目卡片 + 更多菜单（导出 ZIP、完整备份、重命名、删除） |
| `components/home/{NewBlank,ImportScript,ImportPackage,Rename}Dialog.vue` | 经 `openDialog('home.*')` 打开，`emit('close', result)` |
| `components/home/MediaAssetsPanel.vue`、`GlobalLibraryPanel.vue` | 素材库页的 4 个标签 |
| `components/home/homeApi.js` | 接口与浏览器副作用（下载、本机存储） |
| `components/home/projectFlows.js`、`homeNav.js`、`utils/homeModel.js` | 纯逻辑（依赖注入），有 node 测试 |
| `views/MediaLibrary.vue` | `/media-library?tab=media\|character\|scene\|prop` |

action（`shell/actions/home.js`）：`home.oneLine`、`home.newBlank`、`home.importScript`、`home.importPackage`、`home.globalLibrary`。
对话框（`shell/dialogs/home.js`）：`home.newBlank`、`home.importScript`、`home.importPackage`、`home.rename`。

## 行为

- 点卡片：shell store 的 `lastView(dramaId)` 里的集仍存在 -> 那一集的那个视图；否则第 1 集（按集号）剧本；没有剧集 -> `project-home`。永远是具名路由（`episode-<view>` / `project-home`），不出现 `/film/`、`/drama/`。
- 新建（空白 / 导入剧本）：先建项目再 `PUT /dramas/:id/episodes` 写入剧集；写剧集失败会删除刚建的项目。成功后进 `episode-script`。
- 一句话写剧本：`/new-project`，成功后进 `episode-script`。
- 导入项目包：先试 `POST /dramas/restore`（完整备份），404/405/501 时回退到 `/dramas/import`。总是新建项目。成功后按"上次停留 -> 第 1 集 -> project-home"落点。
- 删除：确认 -> `POST /dramas/:id/snapshots`（本机快照）-> 删除 -> 记入"最近删除"（localStorage，最多 5 条）-> 可在导入项目包对话框里恢复。快照不可用或失败时再确认一次。
- 完整备份：`POST /dramas/:id/backup/full`，整个响应经 fetch 读成 blob 再保存（超大项目会占内存，见缺口）。

## 旧功能 -> 新位置（对照表）

| 旧（FilmList） | 新位置 |
|---|---|
| 素材角色 / 素材场景 / 素材道具 三个弹窗（搜索、列表、编辑、换图、AI 生成、删除） | 素材库页 `/media-library` 的「角色 / 场景 / 道具」标签（`GlobalLibraryPanel`，同样的搜索、编辑、上传、AI 生成、删除、分页）；顶栏「全局素材库」先打开 `assets.globalLibrary` 浏览对话框，再经其「管理素材库」进入（见缺口 5） |
| 隐藏的「素材库」（媒体素材） | 素材库页「媒体素材」标签（`MediaAssetsPanel`：类型过滤、搜索、上传、多选批量删除、预览） |
| 隐藏的「自由创作」按钮 | 已删除（Task 12）：`FreeCreate` 页面不存在，旧地址 `/free-create` 由 `utils/legacyRoutes.js` 重定向到首页 |
| 模板 | 顶栏「模板」-> `templates` |
| 任务中心 | 顶栏「任务」-> `task-center`（页面已国际化） |
| 花费统计 | 顶栏「花费」-> `spend` |
| 云备份 | 顶栏「设置」菜单 -> `/settings/backup` |
| 关于 | 设置菜单 -> `/settings/about` |
| 快捷键 / 插件 / 工作室 | 设置菜单（路由沿用） |
| 暗色 / 浅色切换 | 设置菜单（`useTheme`） |
| AI 配置弹窗 | 设置菜单 -> 弹窗里仍是 `AIConfigContent` |
| 语言切换 | 顶栏 `LocaleSwitch` |
| 内置示例项目（`seedSample`） | 创建入口下方「试试示例项目」，进入示例的分镜视图（`episode-storyboard`） |
| 示例导入（`listExamples/importExample`） | 同一行，有示例时显示 |
| 导入项目（ZIP） | 创建入口「导入项目包」（兼容完整备份） |
| 导出项目 | 卡片菜单「导出项目 ZIP」 |
| 编辑（标题 / 描述） | 卡片菜单「重命名」（`home.rename`） |
| 新建项目（标题 / 描述 / 画幅） | 创建入口「空白项目」 |
| 从故事生成分镜 | 创建入口「一句话写剧本」-> `/new-project` |
| 删除 | 卡片菜单「删除」（先做本机快照） |
| 四视图按钮 | 去掉；点卡片即进入上次的视图 |
| 状态 / 题材 / 画风 徽标 | 去掉；卡片显示集数、镜头数、画幅、更新时间、上次停留位置 |

## 缺口与偏差

1. **删除前的本机快照没有可调用的接口。** T5 只有 `GET /dramas/:id/snapshots` 与 `POST /dramas/:id/snapshots/:sid/restore`，快照只在破坏性操作的钩子里产生，`DELETE /dramas/:id` 不做快照，也没有 `POST /dramas/:id/snapshots`。首页按 `POST /dramas/:id/snapshots` 写好了（返回 `{ id }`），现在得到 404，于是走"没有本机快照，仍要删除吗"的第二次确认，并提示用完整备份。需要后端补 `POST /dramas/:id/snapshots`（或让 DELETE 先快照并返回快照 id）后才满足"删除前自动快照"。
2. **没有剧集的项目**点卡片落到 `project-home`（外壳决定落点），不是剧本。空白项目与导入剧本都会带至少 1 集，所以这只发生在旧数据 / 导入的空项目。
3. **画幅不可改**：`updateDrama` 只支持 title / description / genre / status，重命名对话框不含画幅。重命名也无法把描述清成空（与旧版一致）。
4. **完整备份下载经内存**：`fetch` 读完整个响应再保存，非常大的项目会占内存。后端是流式的，改成 `showSaveFilePicker` / 原生 `<a>` 需要 GET 路由或桌面端下载钩子。
5. **与 T7 的重复（Task 12 已合并为一个入口）**：首页顶栏「全局素材库」现在运行 `home.globalLibrary`，它用 `openDialog('assets.globalLibrary', { kind: 'characters', scope: 'global', browseOnly: true })` 打开 assets lane 的 `GlobalLibraryDialog`（和项目内左栏「从素材库导入」是同一个对话框）。首页没有当前项目，所以 `browseOnly` 隐藏「导入所选」和「本项目资料库」来源，也不使用外壳 store 里可能残留的上一个项目 id。`GlobalLibraryPanel` 只留在 `/media-library` 的「角色 / 场景 / 道具」标签里，负责对话框没有的编辑 / 删除 / 换图 / AI 生成；对话框底部的「管理素材库（编辑 / 删除）」按当前类别跳到对应标签。代价：首页进入编辑多一次点击；「媒体素材」标签只能经该按钮（或命令面板）到达。
6. **`home.projectSettings` 不在我这里**：LeftRail 打开它，计划由 T6（剧本）提供；`dialogs/home.js` 刻意没有注册（合并表是后者覆盖前者，home 在最后）。卡片的重命名用我自己的 `home.rename`。
7. **导出类 action**（`export.projectZip` / `export.fullBackup`）属于 T9，没有在 home 注册；`homeApi.downloadProjectZip` / `downloadFullBackup` 可复用。
8. **仍是中文的数据**：画风名（`constants/styleOptions`）、题材模板名 / 描述（`/scriptgen/templates` 返回）、服务端 `error_readable`（仅在错误码不认识时使用）。这些不是首页的文件。
9. `/new-project` 的校验用 `validateOneLine` 返回的错误码，在组件里翻译；请求体仍由 `utils/storyboardTable.buildProjectRequest` 生成。
10. 本机"最近删除"记录只存在这台机器的浏览器存储里；清掉站点数据后无法从界面找到快照（快照文件仍在应用数据目录）。

## 测试

`apps/renderer`：`homeModel`、`lastVisited`、`projectFlows`、`libraryKinds`、`homeNav`、`homeI18n` + `i18nLiterals` / `i18nParity` / `i18n`。命令：`cd apps/renderer && node --test test/<file>.test.js`。`test/i18n-migrated/home.json` 登记了已迁移的文件（不得含中文字面量）。
