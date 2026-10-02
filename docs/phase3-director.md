# P3-D 导演模式：自然语言 → 执行计划 → 一笔可撤销的事务

状态：云端会话完成并通过自动化测试（文本模型在测试里用录制的回复回放，不联网）。**没有用真实 Key 跑过模型**，提示词与计划质量要按真实项目调，见第 9 节。

## 1. 它做什么

用户在右侧抽屉里用一句话说要改什么（「第二镜改成夜景特写，第三镜的旁白短一点」）。本地服务：

1. 把项目图投影成紧凑上下文，连同「可用动作」清单交给用户自己配置的文本模型（百炼默认 `qwen-plus`），要求只输出一份 JSON 计划；
2. 计划只能用内核已有的意图（REST 白名单减去几个模型拿不到输入的），参数按参数表逐项检查，编造的动作或参数直接拒绝；
3. 在克隆图上按顺序干跑每一步（`kernel.applyTx`），记录每步的 op 数与它新造成过期的节点；
4. 对比干跑前后的图算出**会改 / 不会改**的镜头、总时长变化、要重新生成的节点，并用花费服务估价；
5. 记一行 `director_turns`（status `planned` 或 `rejected`，拒绝也留记录和模型原文）；
6. 用户点「执行」：在最新图上重跑同样的步骤合成**一个**内核事务（`tx_id = director:<turnId>`，标签「导演模式」），一次 `store.commit`，旧表随物化同步；
7. 「撤销」：只在该事务位于撤销栈顶时 `store.undo`，否则告诉用户栈顶是什么。顶栏的撤销 / 重做同样作用于这笔事务。

不做的事：不建生成任务、不花钱（估价只是告诉用户执行后再点「生成」要花多少）；不碰画布布局；不做跨分集的修改。

## 2. 文件

| 位置 | 作用 |
|---|---|
| `packages/local/migrations/33_director_turns.sql` | `director_turns` 表 |
| `packages/local/src/kernel/intentTable.js` | 从 `routes/kernel.js` 搬出来的 REST 意图白名单（`INTENTS` / `viewOf` / `lookupIntent`），两边共用，REST 行为不变 |
| `packages/local/src/director/intentSchemas.js` | 开放给模型的 20 个意图的参数表、`EXCLUDED` 及原因、`checkArgs`、提示词里的动作描述 |
| `packages/local/src/director/prompt.js` | `buildContext`（图 → 紧凑 JSON）、`buildMessages`（system + user）、`repairMessages`（修正回合） |
| `packages/local/src/director/plan.js` | 纯函数：`parsePlan` / `normalizePlan` / `checkPlan` / `dryRun` / `compileOps` / `structureHash` / `computeImpact` / `estimateCost` |
| `packages/local/src/director/index.js` | `createDirectorService`：`plan` / `apply` / `undo` / `list` / `get`，`DirectorError` |
| `packages/local/src/routes/director.js`、`routes/index.js` 末尾 `// P3-D` 块 | REST |
| `packages/local/configs/config.yaml` `director:` | `model`（默认 qwen-plus）、`max_attempts`（默认 2） |
| `packages/local/src/errors/error-codes.json` | `NO_TEXT_PROVIDER`、`DIRECTOR_MODEL_FAILED`、`DIRECTOR_PLAN_REJECTED`、`DIRECTOR_TURN_STATE`、`DIRECTOR_STALE_PLAN`、`DIRECTOR_NOT_ON_TOP` |
| `apps/renderer/src/components/DirectorPanel.vue` | 右侧抽屉（设计稿 P3-03），挂在 `App.vue` |
| `apps/renderer/src/composables/useDirectorPanel.js` | `openDirector(episodeId)` / `closeDirector` 开关 |
| `apps/renderer/src/utils/director.js` | 面板的纯逻辑（状态、步骤描述、影响摘要、节奏条、估价文案、预览） |
| `apps/renderer/src/api/director.js` | 四个接口 |
| `apps/renderer/src/utils/builtinCommands.js` 末尾 `// P3-D` | 命令面板「导演模式」 |
| `StoryboardPage.vue`、`ShotWorkbench.vue` 顶栏 | 「导演模式」按钮；工作台另监听 `views.revision` 以便执行 / 撤销后重读镜头 |
| `packages/local/test/director.test.js`、`test/fixtures/director/*.json` | 本地测试与录制计划 |
| `apps/renderer/test/director.test.js` | 面板纯逻辑测试 |

## 3. 提示词

`prompt.js` 的 `SYSTEM`（中文）＋ 动作清单。要点：

- 只能用清单里的动作，`view` / `name` 逐字取自清单；清单外的动作、编造的参数一律拒绝。
- 所有 id 必须逐字照抄上下文（镜头 / 行 / 场景组 / 片段 / 节点），不能用序号代替。
- 时长单位毫秒整数。
- 花费意识：镜头字段与台词行都是生成的输入——改镜头任何字段、改台词、拆镜、合镜、新增镜头、换种子都会让相关镜头已生成的图 / 视频过期；只改顺序、裁剪、移动片段、转场不花钱。能不花钱就不花钱，能只改一个镜头就不碰别的镜头。
- 步骤按执行顺序、尽量少而准；同一镜头的多个字段放进同一步 `setShotField`。
- 信息不足或超出能力时 `steps` 给空数组并在 `summary` 说明。
- `summary` / `reason` / `untouched` 用中文；`untouched` 列出有意不改的内容。
- 只输出一个 JSON 对象，不要解释文字和 Markdown 代码块（解析时仍容忍代码块与闲聊）。

动作清单由 `describeIntent` 从参数表生成，一行一个，例如：

```
- shot.setShotField(shot_id*: string, patch*: object{title:string,description:string,…,duration_ms:integer})：改镜头字段。…
- shot.reorderShots(group_id*: string, ids*: string[])：在一个场景组内重排镜头，ids 必须是该组全部镜头的一个排列。只让合成过期，不花钱。
```

`*` 必填，`?` 可选，`<a|b>` 枚举，`{…}` 对象允许的键，`|null` 可为 null。

用户消息 = `项目上下文（JSON）：` + `buildContext(graph)` + `用户要求：…`。上下文每个镜头带 `id / no / group / title / description(≤200 字) / location / shot_type / angle / movement / image_prompt(≤160) / video_prompt / characters / duration_ms / used_ms / dialogue / line_ids / state{image,video,narration} / nodes{image,video,narration} / segments[{id,in_ms,out_ms,gap_before_ms,transition}]`；每行带 `id / group / kind / speaker / text / shot_ids`；另有 `groups`、`total_ms`、`shot_count`。

修正回合：计划不合法时把模型上一次的输出（assistant）和问题清单（user，最多 15 条）追加到对话再要一次完整 JSON；总尝试次数 `director.max_attempts`（默认 2）。用完仍不合法 → 记为 `rejected`。

## 4. 计划 JSON 契约

```json
{
  "summary": "一句话概括这次修改",
  "steps": [
    { "view": "shot", "name": "setShotField", "args": { "shot_id": "shot_2", "patch": { "shot_type": "特写" } }, "reason": "为什么这样改" }
  ],
  "untouched": ["其余镜头的画面与台词不变"]
}
```

`view` 取 `script | shot | timeline | canvas`（`shots` 作为 `shot` 的别名也接受）；`args` 是该意图的 JSON 参数，与 `POST /episodes/:id/intent` 完全一致。

## 5. 开放的意图与参数表

白名单（规格 §3 的 26 个）减去 `EXCLUDED`：

| 排除 | 原因 |
|---|---|
| `timeline.addMusic` | 需要音乐素材的 asset_ref，模型看不到素材库 |
| `canvas.moveNode` | 只改画布坐标，对成片没有意义 |
| `canvas.connectNodes` / `disconnectNodes` / `addNodeAt` / `deleteNode` | 画布级结构编辑，连错线会破坏项目图；镜头与台词的增删已有专门意图 |

开放的 20 个（`intentSchemas.js` 是唯一来源，测试断言 `allowedIntents() = 白名单 − EXCLUDED`）：

| 意图 | 参数（* 必填） | 对生成的影响 |
|---|---|---|
| `script.rewriteLine` | `line_id*`, `patch*{text,speaker,kind}` | 该行所属镜头的配音过期；已生成的图 / 视频也过期（行是镜头输入） |
| `script.insertLine` | `group*`, `index?`, `kind?<narration|dialogue|action|scene_heading>`, `speaker?`, `text?`, `shot_ids?` | 挂上的镜头过期 |
| `script.deleteLine` | `line_id*` | 所属镜头过期 |
| `script.splitLine` | `line_id*`, `at*` | 同上 |
| `script.mergeLines` | `a_id*`, `b_id*`, `sep?` | 同上 |
| `script.reorderLines` | `group_id*`, `ids*` | 不花钱 |
| `shot.setShotField` | `shot_id*`, `patch*{title,description,location,time,shot_type,angle,movement,image_prompt,video_prompt,atmosphere,characters[],duration_ms}` | 镜头全部字段都是下游输入：已生成的图 / 视频 / 配音过期；`duration_ms` 变时时间线片段跟随 |
| `shot.splitShot` | `shot_id*`, `at_line_index*` | 新镜头要生成图 / 视频 |
| `shot.mergeShots` | `a_id*`, `b_id*` | a 过期 |
| `shot.reorderShots` | `group_id*`, `ids*` | 不花钱 |
| `shot.moveShotToGroup` | `shot_id*`, `group_id*`, `index?` | 不花钱 |
| `shot.addShot` | `group*`, `index?`, `params?{同 patch}`, `lines?` | 新镜头要生成图 / 视频 |
| `shot.deleteShot` | `shot_id*` | 不花钱 |
| `shot.regenerateShot` | `shot_id*`, `seed?`, `targets?<image|video>[]` | 强制重生成 |
| `timeline.trimSegment` | `segment_id*`, `in_ms?`, `out_ms?` | 不花钱 |
| `timeline.moveSegment` | `segment_id*`, `gap_before_ms?`, `before_segment_id?`, `after_segment_id?` | 不花钱 |
| `timeline.splitSegment` | `segment_id*`, `at_ms*` | 不花钱 |
| `timeline.deleteSegment` | `segment_id*` | 不花钱 |
| `timeline.setTransition` | `segment_id*`, `transition*|null` | 不花钱 |
| `canvas.setNodeParam` | `node_id*`, `path*`, `value*|null` | 该节点及下游过期（取值校验在内核 `NODE_PARAM_RULES`） |

## 6. 校验规则（按顺序，任一失败整份计划拒绝）

1. **解析**：去掉 Markdown 围栏后取最外层 JSON 对象（`scriptgen.extractJson`，容忍尾逗号等可修复错误）；不是对象 → `模型输出不是 JSON：…`。
2. **结构**：`steps` 必须是非空数组（空数组 → `steps 为空：模型没有给出可执行的步骤（summary）`，把模型的说明带给用户）；最多 40 步。
3. **动作**：`view.name` 必须在白名单里（`lookupIntent`，用 hasOwnProperty 防原型链）；在 `EXCLUDED` 里 → `不对导演模式开放（原因）`。
4. **参数**（`checkArgs`）：`args` 必须是对象；必填不能缺（`null` 视为缺，除非 `nullable`）；类型匹配（string / integer / number / boolean / object / string[] / any）；枚举限定取值（数组逐项）；object 带 shape 时键必须在 shape 里且类型匹配、不能是空对象；**参数表外的键一律拒绝**（模型编的参数不能悄悄丢掉）。
5. **干跑**：在克隆图上顺序执行，每步 `lookupIntent(...).fn(g, args)` → `kernel.applyTx`；内核报错（镜头不存在、排列不完整、越界……）→ `第 N 步 view.name 执行失败：<内核消息>`，后面的步骤不再评估；全部步骤 op 数为 0 → `计划不会产生任何改动`。

错误全部是中文、带步骤号，直接显示在面板上；原始模型文本保留在记录里（`raw`），面板可展开查看。

## 7. 影响范围与估价

**影响**（`computeImpact(before, after, staleNodes)`）：按镜头对比干跑前后——

- `changed_shots[]`：`added / removed / moved / modified`，`modified` 带 `changes`（`content` 镜头字段、`lines` 台词、`generation` 生成节点参数、`segments` 时间线片段、`group` 场景、`order` 顺序）；
- `unchanged_shots[]`：计划后完全没变的镜头；
- `duration {before_ms, after_ms}`：`timelineView` 的总时长；
- `shots_before[] / shots_after[]`：序号、标题、时长、变化类型（面板画节奏条与「计划后」预览）；
- `stale_nodes[]`：计划新造成过期的节点（`applyTx.invalidated` ∪ 新建的生成节点），带所属镜头与造成它的步骤。

「不会改」= `unchanged_shots` + 模型自己声明的 `untouched`。

**估价**（`estimateCost`）：只对**计划新造成过期或新建**的节点计费，从未生成过的节点（本来就要生成）不算这次的新增花费；合成节点不计费。

- 图 / 视频：有生成服务时用 `generation.planGraph(dryGraph, …)`，与点击「生成」看到的模型、提示词、时长、首尾帧一致，缓存命中记 0；没有生成服务时按已启用服务商与默认模型粗估。
- 配音：按该镜头可配音文字的字数（`voiceover.spokenText`），没有文字记 0。
- 一次 `spend.checkBatch`：`total / max / currency / sample_prices / known`，超过单次或月度上限时 `allowed=false` 并带 `refusal`——**只是提醒**，执行计划本身不花钱，上限在之后点「生成」时才真正拦。
- 每一步的花费 = 它造成过期的节点估价之和（面板每步右侧显示）。

## 8. API

令牌校验由 app 级 `localTokenGuard` 统一处理。

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/episodes/:id/director/plan` | `{ message, provider? }` → 轮次记录。`rejected` 也是 200（原因在 `validation.errors`，`error.code = DIRECTOR_PLAN_REJECTED`）；没有文本配置 400 `NO_TEXT_PROVIDER`；模型调用失败 502 `DIRECTOR_MODEL_FAILED` |
| `GET` | `/episodes/:id/director/turns?limit=` | `{ turns[] }` 新在前（默认 50，最多 200），带 `history_state` |
| `POST` | `/episodes/:id/director/turns/:turnId/apply` | `{ turn, applied, tx_id, seq, invalidated, revalidated, stale, can_undo, can_redo }`；状态不是 planned → 409 `DIRECTOR_TURN_STATE`；结构摘要不符 → 409 `DIRECTOR_STALE_PLAN` |
| `POST` | `/episodes/:id/director/turns/:turnId/undo` | 同上；不在栈顶 → 409 `DIRECTOR_NOT_ON_TOP`（`details.top` 是栈顶事务，`steps_above` 是上面还有几步） |

轮次记录字段：`id, episode_id, message, status, status_label, history_state, created_at, applied_at, tx_id, summary, untouched[], steps[{index, view, name, args, reason, label, ok, error, op_count, stale_nodes[], cost}], validation{ok, errors[], attempts, base{seq, structure_hash}}, impact, cost_estimate, provider, model, usage, error, raw[]`（`raw` 只在 plan 响应与 get 里）。

`history_state`：`applied`（事务仍在撤销栈）/ `undone`（在重做栈，比如被顶栏撤销）/ `discarded`（被别的修改顶掉）/ `null`（没执行过）。记录的 `status` 只由导演模式自己的执行 / 撤销改；被顶栏撤销的计划 `status` 仍是 `applied`，面板用 `history_state` 显示「已在顶栏撤销」并禁用撤销按钮。

### 执行与撤销的语义

- 计划记下生成时的 `seq` 与**结构摘要**（节点含参数、边、组、顺序的 `sha256(canonicalJSON)`；不含版本、采用、布局）。执行前核对：生成结果写回、采用版本之类的变化不影响；结构改了 → `DIRECTOR_STALE_PLAN`，要重新生成。
- 执行时在**最新图**上重跑步骤得到 ops（确定性 id 分配，与干跑一致），`store.commit(db, ep, builder, { tx_id })`：一个事务、一条历史、同 `tx_id` 重复提交是空操作。`meta.director_turn / summary / labels` 记在事务上，版本历史里显示为「导演模式」。
- 撤销只接受「该事务位于 `history.past` 栈顶」；其它情况报出栈顶是谁、上面还有几步，让用户去顶栏撤销或版本历史回跳。撤销事务 id `director-undo:<turnId>:<seq>`。

## 9. 没有验证的

- **真实模型**：全部测试用录制回复。真 Key 下的计划质量、修正回合是否够用、`qwen-plus` 对 id 照抄的可靠性、长剧集（几十个镜头）的上下文长度都没试过。上下文每镜 ~400 字，100 镜约 4 万字，接近 `qwen-plus` 的舒适区上限，之后可能要按场景组裁剪。
- 方舟（ark）文本模型：`resolveProvider` 支持，但 `director.model` 留空时取该配置的默认模型，没有验证模型名。
- 面板只做了纯逻辑测试与 vite 构建检查，没有浏览器 e2e；节奏条与虚线预览的视觉要真机看。
- 估价沿用 `configs/prices.json` 的示例价目（`sample_prices=true`）。

## 10. 怎么测

```
pnpm --filter ./packages/local test      # 含 test/director.test.js（24 条）
pnpm --filter ./apps/renderer test       # 含 test/director.test.js（11 条）与 commandRegistry 的「导演模式」命令
pnpm --filter ./packages/kernel test
```

`packages/local/test/fixtures/director/*.json`：`{ id, note, message, replies[] }`，`replies` 是模型逐次回复的原文（第二条用于修正回合），`{{seg:shot_2}}` 在回放前换成当前图里该镜头的片段 id（片段 id 来自旧时间线，不是确定的）：

| 文件 | 场景 |
|---|---|
| `valid-multistep` | 带闲聊与代码块；shot / script / timeline 三步；影响、过期节点、估价、执行、撤销 |
| `reorder-only` | 只调顺序：花费 0，镜头标为 moved |
| `repair` | 第一次不是 JSON，修正后通过；时长变化让时间线跟随 |
| `add-shot` | 新增镜头：新节点的估价 = 生成服务计划经花费服务估价之和；撤销后节点与片段全部回收 |
| `unknown-intent` / `bad-args` / `excluded-intent` / `missing-shot` / `empty-steps` | 各类拒绝及其中文原因 |

不变量（测试里断言）：执行 = 一条历史、执行后的图等于干跑结果；执行再撤销后图 `canonicalJSON` 相等、旧表行（除 `updated_at`）相等；估价等于花费服务对过期节点的估价之和；错误码都在 `error-codes.json`；`allowedIntents()` 等于白名单减 `EXCLUDED`。

录新的样例：用真 Key 跑一次 `POST /episodes/:id/director/plan`，把 `raw[]` 粘进新的 fixture，把片段 id 换成 `{{seg:<shot_id>}}` 占位。
