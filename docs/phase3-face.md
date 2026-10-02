# P3-C 人脸级一致性（本地小模型）

状态：云端会话完成并通过自动化测试（本机服务：纯函数 + 假引擎的合成规则 + 真模型集成；脚本；渲染端纯函数与构建）。真模型只在 Linux 沙箱里用三张公有领域人像跑过；Windows / macOS 真机、打包后 onnxruntime 二进制的加载与裁剪、真 Key 出图后动漫 / 国风脸上的分数分布都没跑过，见第 8 节。

承接 `docs/phase3-consistency.md` 第 7 节的缺口：原算法（感知哈希 + 直方图 + 主色调）认不出“同构图不同脸”。这里给角色参考图加一道人脸部分：本地 CPU 小模型检测人脸、取特征、比余弦相似度，并入原分数。场景参考图不做人脸。

## 1. 做了什么

| 位置 | 作用 |
|---|---|
| `packages/local/src/consistency/face.js` | 人脸引擎：YuNet 检测（OpenCV `face_detect.cpp` 的解码 + NMS）、SFace 特征（5 点相似变换对齐到 112×112、双线性采样、128 维）、余弦；`available()` / `status()` / `embed()` / `similarity()` / `compare()`；onnxruntime-node 惰性 require，会话缓存，推理串行；视频用 ffmpeg 均匀抽帧 |
| `packages/local/src/consistency/index.js` | `settingsFrom` 读 `consistency.face`；`combineWithFace` 合成规则（纯函数）；`scoreVersion` 对角色参考图追加人脸部分写进 `parts.face`；报告带 `face_available` / `face_reason` |
| `packages/local/configs/config.yaml` | `consistency.face.enabled / min_similarity / models_dir` |
| `packages/local/src/app.js`、`apps/desktop/main.js` | `createApp({ faceEngine?, faceModelsDir })`：桌面端把 `<resources>/models/face` 传进来；测试可注入假引擎（`null` = 不用） |
| `packages/local/package.json` | 新依赖 `onnxruntime-node ^1.30.0`（MIT；锁文件已提交） |
| `scripts/face-models-pin.json`、`scripts/fetch-face-models.mjs` | 固定 URL / sha256 / 大小 / 许可的模型清单与下载脚本（校验通过才写文件，`--force`，`.pin` 戳记）；测试人像也固定在这里 |
| `scripts/platform-lib.mjs`（末尾新块） | `faceModelEntries` / `faceModelsStamp` / `verifyPinnedBuffer`；`builderTarget` / `onnxRuntimePrune`；`extraResources` 多一项 `resources/models → models` |
| `scripts/pack-desktop.mjs` | 打包前只保留目标平台 / 架构的 onnxruntime 二进制；保证模型目录存在 |
| `apps/desktop/package.json` | `asarUnpack` 加 `**/node_modules/onnxruntime-node/**`；`extraResources` 加 `resources/models` |
| `.github/workflows/ci.yml` | Windows `test` 作业与两个打包作业装完依赖后 `node scripts/fetch-face-models.mjs` |
| `apps/renderer/src/utils/consistencyView.js`、`ShotWorkbench.vue`、`StoryboardPage.vue` | `faceText`；芯片提示括号里带「人脸 NN」/「未检测到人脸」/「参考图未检测到人脸」/「人脸模型未安装」 |
| `docs/face-models.md` | 模型、许可、来源、怎么换 |

## 2. 模型与推理

| 环节 | 做法 |
|---|---|
| 检测 | YuNet `face_detection_yunet_2023mar.onnx`（MIT，227 KB）。输入固定 `[1,3,640,640]`，BGR 0–255（OpenCV `blobFromImage` 默认）；图片等比缩到长边 640 后右下补黑（`copyMakeBorder` 的做法）。三个步长 8/16/32 的 anchor-free 输出按 OpenCV `objdetect/src/face_detect.cpp` 解码：`score = sqrt(clamp(cls)·clamp(obj))`，`cx = (c + bbox₀)·s`，`w = exp(bbox₂)·s`，关键点 `(kps + 格点)·s`；分数阈值 0.7，贪心 NMS IoU 0.3；按面积排序，每帧最多给前 5 张脸算特征 |
| 对齐 | 5 个关键点（右眼、左眼、鼻尖、右嘴角、左嘴角）到 OpenCV `FaceRecognizerSF` 的 112×112 标准点做相似变换（旋转 + 等比缩放 + 平移的最小二乘闭式解；在不需要镜像时与 OpenCV 的 Umeyama 解相同），双线性采样、边界补 0（`warpAffine` INTER_LINEAR + BORDER_CONSTANT） |
| 特征 | SFace `face_recognition_sface_2021dec_int8.onnx`（Apache-2.0，9.4 MB）；目录里有 fp32 文件时优先用它。输入 `data [1,3,112,112]`，RGB 0–255 不减均值（`blobFromImage(1, 112×112, 0, swapRB=true)`），输出 `fc1 [1,128]`，L2 归一化后比余弦（`FaceRecognizerSF::match` 的 `FR_COSINE`）。OpenCV 给的同人阈值 0.363 |
| 运行时 | onnxruntime-node 1.30.0，CPU 执行提供者，`intraOpNumThreads = min(4, CPU 数)`（配置 `threads`）；两个会话只建一次并缓存；所有推理过一个串行队列。模块或模型缺失 → `available()` 为 false、`status().reason` 说明原因（`module_missing` / `models_missing` / `load_failed`），服务照常启动 |
| 输入 | 图片用 sharp 解码（EXIF 旋转、去 alpha、灰度转 sRGB 三通道），工作分辨率长边 ≤ 1280，坐标折回原图；视频用 ffmpeg（`utils/ffmpegPath` 定位，`FFMPEG_PATH` 可指定）在 `(i + 0.5)·时长/n` 处抽 `sample_frames` 帧，与 lycore 相同；参考图的特征按 路径 + mtime + 大小 缓存 |
| 模型目录 | `TALEKILN_MODELS_DIR` > 配置 `consistency.face.models_dir` > 桌面端传入的 `<resources>/models/face` > `process.resourcesPath/models/face` > 开发目录 `apps/desktop/resources/models/face`（前两个显式指定、不检查存在；后三个取第一个存在的） |

## 3. 评分规则

原分数 `old`（lycore 的感知哈希 + 直方图 + 主色调，0–100）不变；对**角色**参考图再算人脸部分：

1. 参考图取最大的脸；目标每帧取**与参考图最像的那张脸**（多角色同框时才不会拿错脸；详见第 10 节），有脸的帧取平均余弦 `sim`。
2. 余弦 → 人脸分（`faceScore`）：折线过 `(0, 0)`、`(min_similarity, min_score)`、`(1, 100)`，两端截断。默认 `min_similarity = 0.363`、`min_score = 60`，即 **人脸分 ≥ 60 ⇔ 余弦 ≥ 0.363（OpenCV 的同人线）**；0.6815 → 80，0.1815 → 30。
3. 合成（`combineWithFace`）：

| 情况 | 总分 | 建议 |
|---|---|---|
| 参考图没检测到脸 | `old` | 不变 |
| 参考图有脸，目标帧里有脸 | `round(0.6·人脸分 + 0.4·old)` | 按总分重算（≥ 阈值 ok；低 20 分以上 retry；其间 check） |
| 参考图有脸，目标帧里没脸（或都没匹配上） | `round(0.4·old)`，人脸分 0 | 至少 `check` |

`parts.face = { similarity, score, ref_faces, target_faces, matched_frames, frames: [{ t_ms, faces, similarity }], kind, took_ms }` 存进 `consistency_scores.parts`（JSON）；引擎抛错时这一行按原分存，`parts.face = { error }`。

例（原分 48 = 同素材不同图的典型值）：同人余弦 0.751 → 人脸分 84.4 → 总分 70（ok）；异人 0.106 → 17.5 → 30（retry）；原分 100 但画面里没这张脸 → 40（check）。

## 4. 报告 / REST / 界面

`GET /api/v1/episodes/:id/consistency` 多两项：`face_available`（配置开着、onnxruntime 与模型都加载得了）与 `face_reason`（不可用时 `disabled` / `module_missing` / `models_missing` / `load_failed`，可用为 `null`）；每行 `scores[].parts.face` 如上。重评 `POST /shots/:id/consistency/rescore` 走同一条路，人脸部分一并重算。

渲染端芯片仍是「一致性 NN」（最差分）；悬停提示的括号里多一项，取自最差那一行：「人脸 84」/「未检测到人脸」/「参考图未检测到人脸」；该行没算过人脸且报告 `face_available=false`（非 `disabled`）→「人脸模型未安装」。例：`首帧图与「李雷」的锁定参考图一致（最低 70 分，人脸 84）`。

## 5. 配置

```yaml
consistency:
  face:
    enabled: true          # false：不建引擎，报告 face_reason=disabled
    min_similarity: 0.363  # 余弦同人线（0–1 开区间，非法回退 0.363）；人脸分 ≥ min_score ⇔ 余弦 ≥ 它
    models_dir: ''         # 模型目录；留空按第 2 节的顺序找
```

高级项（不写进默认配置）：`consistency.face.score_threshold`（检测分数阈值，默认 0.7）、`consistency.face.threads`（1–64，默认 min(4, CPU 数)）。

## 6. 模型文件与打包

见 `docs/face-models.md`。要点：`node scripts/fetch-face-models.mjs` 按 `scripts/face-models-pin.json` 校验 sha256 与大小后写入 `apps/desktop/resources/models/face/`（含两份许可文本，git 忽略）；electron-builder `extraResources` 把它放到 `<resources>/models/face`；`pack-desktop.mjs` 只保留目标平台 / 架构的 onnxruntime 二进制（npm 包里近 300 MB → 一份约 70–135 MB），`.node` 经 `asarUnpack` 解到 asar 外。社区版可以不带模型：引擎报不可用，其余评分照常。

## 7. 实测数字（本沙箱，Linux x64，4 线程，int8）

- 相似度（白宫官方人像）：同人 0.751（→ 人脸分 84.4），异人 0.106 / 0.250（→ 17.5 / 41.3）；灰度化后的同人 0.885；同人像循环成的 2 秒视频抽 3 帧 0.750，异人对该视频 < 0.363。阈值 0.363 把三张图分得很开，但样本只有三张真人照片。
- 耗时：两个模型加载约 160 ms；一张 600–1000 px 人像 解码 + 检测 + 对齐 + 特征 中位数 132 ms（88–204 ms；与整套测试并行时 340–470 ms）；1280×720 帧 检测 + 特征 118–144 ms；没有脸的帧只做检测约 16 ms；3 帧视频的 `compare` 含 ffmpeg 抽帧约 1.3 s。
- 包体：YuNet 227 KB + SFace int8 9.4 MB；onnxruntime-node 的 npm 包按平台目录大小 win32 134 MB、darwin（仅 arm64）86 MB、linux 69 MB，裁剪后只剩目标那一份（安装包压缩后的增量以打包产物为准，没有量过）。

## 8. 未验证

- Windows / macOS 真机：onnxruntime-node 的 `.node` 从 `app.asar.unpacked` 加载、与 Electron 39 的 ABI（它是 N-API 模块，理论上不受 ABI 影响）、路径里的中文与空格。
- `pack-desktop.mjs` 的裁剪与 `extraResources` 只有纯函数单测，没有真的用 electron-builder 打过包；macOS 签名是否会对解包后的 onnxruntime dylib 报错（`mac.binaries` 没列它，electron-builder 通常会自动签 asar 外的 Mach-O）。
- 1.30.0 的 npm 包里没有 `darwin/x64`：Intel Mac 包里人脸部分不可用。
- YuNet / SFace 都是在真人照片上训练的：动漫、国风、3D 渲染脸的检出率与 0.363 阈值是否成立没有测过；真 Key 出图后要看分数分布再调 `min_similarity` 与 0.6 / 0.4 的权重。
- 目标帧取“与参考图最像的脸”而不是“最大的脸”：多角色同框时更合理，但有很多路人脸时会略抬高异人的相似度（最多 5 张脸取最大值）。
- int8 与 fp32 的分数差异没有量过；CI Windows runner 上 ffmpeg 不一定存在，`face.test.js` 的视频部分会自动跳过。

## 9. 怎么测

```bash
node scripts/fetch-face-models.mjs                         # 取模型（约 10 MB）
pnpm --filter ./packages/local test                        # face.test.js（纯函数 + 真模型集成，缺模型 / 下不到人像则跳过）、consistency.test.js（假引擎的合成规则、报告、REST）
TALEKILN_MODELS_DIR=/path/to/models node --test packages/local/test/face.test.js   # 指定模型目录
node --test scripts/platform-lib.test.mjs                  # 清单字段、校验、裁剪、extraResources
pnpm --filter @talekiln/renderer test && pnpm --filter @talekiln/renderer build
pnpm secrets:scan
```

手动：锁定一个角色参考图（有清晰正脸）→ 生成该镜头 → 分镜表芯片悬停看「人脸 NN」；把模型目录改名后重启，应看到「人脸模型未安装」且其余评分照常。

## 10. 决定

- 人脸只对角色参考图做，场景不做；都有脸时 0.6 / 0.4 加权，目标没脸时人脸分 0 且至少 check——“画面里没有这个角色”比“颜色不像”更该被看见。
- 余弦 → 分数用过 `(min_similarity, min_score)` 的折线，让“人脸分过线”与“余弦过 OpenCV 的同人线”是同一件事，阈值只调一处。
- 目标帧取与参考图最像的脸（原方案是最大的脸）：多角色同框是常态，取最大的脸会让第二个角色永远低分；偏差见第 8 节，由你决定要不要改回。
- 默认 int8（随包约 10 MB，符合“几十 MB 以内”），目录里有 fp32 时优先用它。
- 人脸引擎的失败都是软失败（记日志、`parts.face.error`），不引入新错误码；不可用时不显示人脸文案以外的任何提示。
- onnxruntime-node 不进 `pnpm.onlyBuiltDependencies`（它的 postinstall 只会去下 CUDA 二进制）；按平台裁剪放在 `pack-desktop.mjs`，不改 `pnpm deploy` 的行为。
