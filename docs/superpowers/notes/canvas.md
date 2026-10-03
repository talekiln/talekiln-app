# T10 画布（CanvasView）实现记录

## 做了什么

- `views/CanvasView.vue` 仍是内核图画布（Vue Flow），在此之上加了：
  - 工具栏：新增节点、**只看过期**开关（读写 shell store 的 `staleOnly`）、**显示资产引用**开关（开关状态记在 localStorage `talekiln.canvas.assetRefs`，读写都包了 try/catch）。
  - 节点侧栏：参数表单（全部 i18n）、`应用`、**应用并重新生成**、**版本历史**、还原、删除。
  - 资产覆盖层节点的侧栏：类别、名称、已删除提示、被几个镜头引用、换参考图的影响镜头列表（点击跳到该镜头）、“打开资产库”按钮（`shell.openAssetsPanel()`）。
  - `GenerateDialog` 挂在画布内，由 `useGeneration` 驱动；生成队列从忙到闲时自动 `views.refresh()`。
- 纯函数：
  - `utils/canvasAssetRefs.js`：`buildAssetRefLayout(canvas, assets)`，只算布局，不碰内核。
  - `components/canvas/canvasModel.js`：译文标签、`staleOnlyCanvas`、`regeneratePlan`、`historyTarget`、`assetOverlayToFlow`、`paramOps` 等。
- 新组件 `components/canvas/AssetRefNode.vue`；`CanvasNodeCard.vue`、`SceneGroupBox.vue` 改为全 i18n。
- 文案：`i18n/messages/canvas.js`（zh-CN / en，约 118 个 key，对称）。`test/i18n-migrated/canvas.json` 登记了需做“无中文字面量”检查的文件。
- 旧的 DramaCanvas 与 workflow-group 页面没有移植（由协调者在清理阶段删除）。

## 资产引用覆盖层的语义

- 覆盖层节点 id 以 `asset:` 开头，边 id 以 `assetref:` 开头，**永远不写进内核**；拖动、点击、连线、删除处理函数都忽略这两类 id。
- 资产来源：资产库 store（`useAssetsStore`，存在且该类非空时优先）；否则取 `shell.drama` 里的 characters / scenes / props。
- 引用规则（`shotAssetRefs`）：角色 `params.characters`（id、名字、`{id,name}` 均可，名字可带前导 `@`/`#`）；场景 `params.scene_id`，或 `params.location` 与某场景的名称 / 地点完全一致（自由文本对不上时不算“引用了已删除的资产”）；道具 `params.prop_ids` / `params.props`。
- 引用了不存在的资产时画一个“已删除”的幽灵节点（不丢引用）。
- 资产按类别排成列，放在内核图最左侧之外；纵向取其引用镜头中心的平均值，再向下推开避免重叠。
- “只看过期”开启时覆盖层只基于过滤后的画布计算。

## 只看过期的语义

- 保留：节点自带 `stale` 标记，或在 `views.staleSet` 里的节点（含**从未生成**的节点）、它们所属的镜头，以及两端都保留的连线；分组只保留还有子节点的。
- 因此一个全新的、什么都没生成的项目里“只看过期”几乎等于全图（100 镜压测项目：401 个节点全部显示）。这是约定的行为，不是 bug。

## 偏离：改了两个不属于我的文件（只做追加）

为了让“版本历史”定位到具体节点：

- `composables/useHistoryDrawer.js`：新增导出 `historyFocusNode`（ref）；`openHistory(nodeId = '')` 现在接受可选节点 id（传进来的不是字符串，例如被当作点击处理函数时的事件对象，则当作空）。
- `components/VersionHistoryDrawer.vue`：`reload()` 里若 `historyFocusNode` 有值就取走并清空，节点存在时选中它并切到“版本”页；watch 多监听了 `historyFocusNode`。

不带参数调用 `openHistory()` 的老用法行为不变。

## 缺口 / 已知问题

- `GenerateDialog.vue` 只有中文（不归我管）：英文界面下“应用并重新生成”弹出的确认框仍是中文。
- `utils/projectViews.js` 里共享的中文标签表画布已不再使用，其他视图如仍用它则仍是中文。
- 画布里的分组标题（如“剧本”）和 `add-group` 选项是项目数据，不翻译。
- `components/shot/ShotInspector.vue`（lane 8）在我收尾时还不存在：画布用 `import.meta.glob` 可选加载，存在时在镜头节点侧栏里折叠显示（props `shotId`、`compact`），不存在则整块不显示。接口形状与此不同时需要协调者在这里调整。
- 资产库 store 已存在（`stores/assets.js`，字段 `characters` / `scenes` / `props`），形状与覆盖层预期一致；覆盖层自己不触发 store 加载。
- 浏览器检查中控制台有一个 503 资源加载错误，与画布无关（疑似渲染核心未连接）。

## 布局假设

`.canvas-view { height: 100%; min-height: 520px }`，依赖 `ProjectShell` 的 `.main {flex:1; overflow:auto; position:relative}`。若外壳高度不再确定，画布会退回 520px 最小高度。

## 验证

- 压测：用 `POST /episodes/:ep/intent`（`shot` / `addShot`）向一次性项目加 100 个镜头，22.0 s 完成（要求 < 30 s）；之后画布 401 个节点正常渲染。脚本在 `.scratch/canvas-stress.mjs`（未提交）。
- 浏览器（本地 Vite 在 3013 端口，3000 端口是别的应用，不要用）：覆盖层开关（9 个资产 / 133 条引用 / 7 个已删除）、点击资产节点与镜头节点、只看过期开关、应用并重新生成（出确认框，取消）、版本历史（定位到该镜头的视频节点）、中英文切换均已手动走过。
- 测试：`node --test test/i18n*.test.js test/canvas*.test.js`。
