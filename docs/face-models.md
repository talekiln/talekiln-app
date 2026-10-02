# 随安装包内置的人脸模型

P3-C 人脸级一致性（`docs/phase3-face.md`）用两个来自 [OpenCV Zoo](https://github.com/opencv/opencv_zoo) 的小模型在本机 CPU 上跑，不联网、不上传任何画面。两个文件合计约 9.7 MB，由 `scripts/fetch-face-models.mjs` 按固定哈希下载到 `apps/desktop/resources/models/face/`（git 忽略），electron-builder 放进安装包的 `resources/models/face/`。

## 1. 模型

| 文件 | 作用 | 大小 | 许可 | 来源 |
|---|---|---|---|---|
| `face_detection_yunet_2023mar.onnx` | YuNet 人脸检测（框 + 5 个关键点），输入固定 640×640 | 232,589 B | MIT（Copyright (c) 2020 Shiqi Yu） | `opencv_zoo/models/face_detection_yunet` |
| `face_recognition_sface_2021dec_int8.onnx` | SFace 人脸特征（112×112 对齐图 → 128 维），int8 量化版 | 9,896,933 B | Apache-2.0 | `opencv_zoo/models/face_recognition_sface` |

可选：`face_recognition_sface_2021dec.onnx`（fp32，38,696,353 B，Apache-2.0，sha256 `0ba9fbfa…34e79`）。脚本不下载它；手动放进模型目录后引擎会优先用它（`status().variant` 显示 `fp32`）。int8 与 fp32 的分数差异没有量过。

URL、sha256、大小与许可文本的 sha256 都固定在 `scripts/face-models-pin.json`。许可全文随模型一起写成 `LICENSE-yunet.txt`、`LICENSE-sface.txt`，与模型同目录进安装包；在应用的“关于 / 开源声明”里要列这两项（与 ffmpeg 的 LGPL 声明并列）。

## 2. 运行时

推理用 [onnxruntime-node](https://www.npmjs.com/package/onnxruntime-node) 1.30.0（MIT，`packages/local` 的依赖），只用 CPU 执行提供者。其 npm 包带着全部平台的二进制（`bin/napi-v6/{win32,darwin,linux}/{x64,arm64}`，近 300 MB）：`scripts/pack-desktop.mjs` 在 `pnpm deploy` 出来的副本里只保留目标平台 / 架构那一份（`platform-lib.mjs` 的 `builderTarget` / `onnxRuntimePrune`），原生 `.node` 文件经 `asarUnpack` 解到 asar 外面。安装期不需要任何下载：onnxruntime-node 的 postinstall 只会去下 CUDA 二进制，pnpm 按仓库设置不运行它（不要把它加进 `pnpm.onlyBuiltDependencies`）；用 npm 的话设 `ONNXRUNTIME_NODE_INSTALL=skip`。

注意：1.30.0 的 npm 包里 `darwin/` 只有 `arm64`——Intel Mac 的包里没有 onnxruntime 二进制，人脸部分报“不可用”，其余评分照常。

## 3. 怎么取、怎么换

```bash
node scripts/fetch-face-models.mjs            # 校验哈希后写入 apps/desktop/resources/models/face（已齐且戳记一致则跳过）
node scripts/fetch-face-models.mjs --force    # 重下
node scripts/fetch-face-models.mjs --out DIR  # 写到别处（例如给 TALEKILN_MODELS_DIR 用）
```

CI 在 Windows `test` 作业和两个打包作业里装完依赖就跑它；没有模型时本机服务的 `face.test.js` 集成用例会跳过并说明原因，其它测试不受影响。

换模型版本：下载新文件，自己算 `sha256sum` 与字节数，连同许可文本的 sha256 一起填进 `scripts/face-models-pin.json`，更新本文的表格与 `docs/phase3-face.md` 第 2 节，再跑 `node --test scripts/platform-lib.test.mjs`（清单的字段校验）和 `pnpm --filter ./packages/local test`（真模型集成，含相似度阈值）。清单里含 TODO / 哈希不是 64 位十六进制 / 缺许可字段的条目会被脚本直接拒绝，不下载、不编造哈希。

## 4. 测试用的人像

`face.test.js` 的真模型用例需要几张真人照片。不提交任何照片：清单的 `fixtures` 段固定了三张美国白宫官方人像（美国政府作品，公有领域；经 `ageitgey/face_recognition` 示例目录分发）的 URL 与 sha256，测试时下到系统临时目录 `talekiln-face-fixtures/`，哈希不符或下不到就跳过该用例。
