#!/usr/bin/env node
'use strict';
// 跑完整个一致性矩阵，打印 场景 × 入口视图 的汇总表，并写 docs/kernel-conformance.md（中文）。
// 用法：node packages/kernel/test/conformance/report.js [--quick] [--no-write]
//   --quick     只跑矩阵，不再跑 roundtrip/atomicity/fuzz/selftest 等其余套件
//   --no-write  只打印，不写文档
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const S = require('./stories');
const { runMatrix, SCENARIOS } = require('./matrix');
const { VIEWS } = require('./harness');

const args = new Set(process.argv.slice(2));
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DOC = path.join(ROOT, 'docs', 'kernel-conformance.md');
const COLS = [...VIEWS, 'equiv'];

const stories = S.loadStories();
const t0 = Date.now();
const rows = runMatrix({ stories });
const secs = ((Date.now() - t0) / 1000).toFixed(0);

// ---- 汇总 ----
const cell = (scn, view) => {
  const rs = rows.filter((r) => r.scenario === scn && r.view === view);
  if (!rs.length) return { text: '—', fail: 0, pass: 0, skip: 0, total: 0 };
  const pass = rs.filter((r) => r.status === 'pass').length;
  const fail = rs.filter((r) => r.status === 'fail').length;
  const skip = rs.filter((r) => r.status === 'skip').length;
  const total = pass + fail;
  return { pass, fail, skip, total, text: `${fail ? '✗ ' : ''}${pass}/${total}${skip ? `（${skip} 个故事不适用）` : ''}` };
};
const variantsOf = (sc, view) => (sc.entries[view] || []).map((v) => v.name);
const exec = rows.filter((r) => r.view !== 'equiv' && r.status !== 'skip');
const equiv = rows.filter((r) => r.view === 'equiv');
const fails = rows.filter((r) => r.status === 'fail');
const skips = rows.filter((r) => r.status === 'skip');

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - [...String(s)].length - ([...String(s)].filter((c) => /[一-鿿（）]/.test(c)).length)));
console.log(`一致性矩阵：${SCENARIOS.length} 个场景 × ${stories.length} 个故事，${exec.length} 次执行（+ ${equiv.length} 次等价性比较），失败 ${fails.length}，不适用 ${skips.length}，用时 ${secs}s\n`);
console.log(pad('场景', 38) + COLS.map((c) => pad(c, 26)).join(''));
for (const sc of SCENARIOS) console.log(pad(sc.id, 38) + COLS.map((c) => pad(cell(sc.id, c).text, 26)).join(''));
const byView = Object.fromEntries(VIEWS.map((v) => [v, exec.filter((r) => r.view === v).length]));
console.log(`\n按入口视图：${VIEWS.map((v) => `${v}=${byView[v]}`).join('  ')}`);
for (const f of fails) console.log(`FAIL ${f.scenario} ${f.view}/${f.variant} @ ${f.story}: ${String(f.error.message).split('\n')[0]}`);

// ---- 其余套件（可选） ----
const extras = [];
if (!args.has('--quick')) {
  for (const [file, label] of [['roundtrip.test.js', '来回一圈 + 意图足迹 + 携带表'], ['atomicity.test.js', '事务原子性 + 意图错误处理'], ['fuzz.test.js', '随机会话（3 个种子 × 13 故事 × 18 步）'], ['selftest.test.js', '套件自检（变异）与缺陷回归']]) {
    const r = spawnSync(process.execPath, ['--test', path.join(__dirname, file)], { encoding: 'utf8', maxBuffer: 1 << 26 });
    const m = (k) => Number((new RegExp(`^# ${k} (\\d+)`, 'm').exec(r.stdout) || [0, 0])[1]);
    extras.push({ file, label, pass: m('pass'), fail: m('fail'), total: m('tests') });
    console.log(`${file}: ${m('pass')}/${m('tests')} 通过`);
  }
}

// ---- 文档 ----
if (!args.has('--no-write')) {
  const L = [];
  const p = (s = '') => L.push(s);
  p('# 数据内核一致性验收报告');
  p();
  p(`> 由 \`node packages/kernel/test/conformance/report.js\` 生成（${new Date().toISOString().slice(0, 10)}），请勿手改；规格见 [kernel-design.md](kernel-design.md) 第 7 节。`);
  p();
  p('## 1. 结论');
  p();
  p(`- 场景 × 入口视图 × 故事共 **${exec.length}** 次执行（${SCENARIOS.length} 个场景，${stories.length} 个样例故事，另有 ${equiv.length} 次“不同入口终态必须一致”的等价性比较），**失败 ${fails.length}**，另有 ${skips.length} 次因故事形状不适用而跳过（见第 4 节）。`);
  p('- 每次执行的**每一步**之后检查 I1–I8，并做逐步撤销/重做、重复 tx_id、独立预言机比对；执行结束再做整段撤销重做链和“每个事务边界崩溃重放”。');
  p(`- 套件抓到 **2 个内核缺陷**，均已修复并各有回归测试（第 6 节）。`);
  if (extras.length) {
    p('- 其余套件：' + extras.map((e) => `${e.label} ${e.pass}/${e.total}`).join('；') + '。');
  }
  p();
  p('## 2. 每一步检查的不变量');
  p();
  p('| 编号 | 检查内容 | 怎么检查（独立性） |');
  p('|---|---|---|');
  p('| I1 | 每个镜头在 shotView / timelineView / canvasView 各出现一次，顺序一致，同镜头片段连续，clip 的 storyboard_id = legacy_id | 期望顺序由 `oracle.js` 直接遍历 group_order / children 得出，不用内核的 orderOf |');
  p('| I2 | 每行在 scriptView 出现一次；line↔shot 关联双向一致；镜头对白 = 关联旁白/对白行拼接；画布上的 line→shot 边与剧本关联一一对应；字幕轨 = 对白文字 | 关联与对白由 oracle 直接读 edges 重新推导 |');
  p('| I3 | 时间线总时长 = 片段与 gap 之和；每个片段起点逐个独立累加比对；无重叠；毫秒整数 | 起点在 `invariants.js` 里自己累加 |');
  p('| I4 | 只含 setLayout 的事务：cacheKey、staleSet、场景缓存键、除 layout 外的图、script/shot/timeline 三个视图逐字节不变 | 事务前后对比 |');
  p('| I5 | staleSet 与“序列化→重建→从零计算”一致；四个视图与重建图的视图逐字节相同；**独立预言机**与内核逐节点一致，且 tx.invalidated/revalidated 与预言机差异一致 | 预言机 `oracle.js`：自己的嵌套签名 + sha1，产出内容签名写进 asset.hash，不读内核 cache_key |');
  p('| I6 | 每步：逆 op 还原到事务前逐字节相同（含四个视图）、重做回到事务后、撤销恰好使“该事务让其过期的节点”重新新鲜；会话结束：撤销链/重做链在每个边界与记录的状态逐字节相同 | |');
  p('| I7 | 每个事务边界崩溃：快照 + 日志尾重放 = 内存图（含四视图）；日志里每条重复一次/最后一条重复无副作用；快照已含前 k 个事务而日志从头重放（applied 集合）无副作用；同 tx_id 重复提交为空操作；会话中途崩溃后继续编辑 | |');
  p('| I8 | `toLegacyRows` 内部一致：storyboards 行 ↔ shotView（对白、时长、状态、video_url、场景归属、动作列）↔ timeline clips 的 storyboard_id（同一 legacy_id 的片段数与总时长）；旧表时间线 = timelineView。**注意：未做 materialize 到 SQLite（持久化在另一条任务线），所以这里只验证纯内核一致，不验证“物化后的旧表”。** | |');
  p('| 写入范围 | 场景步骤声明“这次编辑允许改哪些图路径”，实际改动路径必须落在其中（防止一个视图的编辑悄悄改了它不携带的数据） | `oracle.changedPaths` 拍平对比 |');
  p();
  p('## 3. 场景 × 入口视图 × 故事 矩阵');
  p();
  p('单元格 = 通过次数/执行次数（跨 13 个故事）；`—` 表示该视图无法表达这个场景；`equiv` 列 = 各入口终态必须相同（按场景声明：`graph` 逐字节相同，`graph-no-layout` 忽略画布坐标）。');
  p();
  p('| 场景 | 说明 | script | shot | timeline | canvas | equiv |');
  p('|---|---|---|---|---|---|---|');
  for (const sc of SCENARIOS) {
    const cs = COLS.map((c) => {
      const base = cell(sc.id, c).text;
      const vs = c === 'equiv' ? [sc.equivalence].filter(Boolean) : variantsOf(sc, c);
      return base === '—' ? '—' : `${base}<br>${vs.map((v) => `\`${v}\``).join(' ')}`;
    });
    p(`| \`${sc.id}\` | ${sc.title} | ${cs.join(' | ')} |`);
  }
  p();
  p(`按入口视图的执行次数：${VIEWS.map((v) => `${v} ${byView[v]}`).join('，')}（合计 ${exec.length}）。`);
  p();
  p('## 4. 不适用（跳过）');
  p();
  const skipBy = {};
  for (const r of skips) { const k = `${r.scenario}｜${r.story}｜${r.reason}`; skipBy[k] = true; }
  const grouped = {};
  for (const k of Object.keys(skipBy)) { const [sc, st, why] = k.split('｜'); (grouped[`${sc}｜${why}`] = grouped[`${sc}｜${why}`] || []).push(st); }
  if (!Object.keys(grouped).length) p('无。');
  else { p('| 场景 | 原因 | 故事 |'); p('|---|---|---|'); for (const [k, v] of Object.entries(grouped)) { const [sc, why] = k.split('｜'); p(`| \`${sc}\` | ${why} | ${v.join('、')} |`); } }
  p();
  p('## 5. 样例故事');
  p();
  p('10 个是联网会话里 D02 分镜生成（scriptgen，qwen-plus）的**真实输出**（原件 `packages/local/test/fixtures/scriptgen/recorded/`，经固定规则转成场景/行/镜头，见 `fixtures/stories/README.md`），另有 3 个**手写**边界故事（一场一镜、一镜多行/未挂行/空场景/长独白、纯旁白）。');
  p();
  p('| 故事 | 来源 | 场景数 | 行数 | 镜头数 |');
  p('|---|---|---|---|---|');
  for (const s of stories) p(`| ${s.id} | ${s.origin === 'recorded-real' ? '真实 AI 输出' : '手写'} | ${s.scenes.length} | ${s.scenes.reduce((a, x) => a + x.lines.length, 0)} | ${s.scenes.reduce((a, x) => a + x.shots.length, 0)} |`);
  p();
  p('## 6. 套件抓到的内核缺陷（均已修复，带回归测试）');
  p();
  p('1. **重排镜头不会让合成过期**（`src/invalidation.js`）。`compose` 的 cacheKey 只含 params（片段数组里跨镜头的相对顺序无意义，顺序存在 `group.children`）和上游 key，所以 `reorderShots` / `moveShotToGroup` / 时间线跨镜头 `moveSegment` 之后，已渲染好的合成仍显示“新鲜”，但成片镜头顺序已变。修复：compose 的 key 增加全项目镜头顺序 `shot_order`。回归：`selftest.test.js` “重排镜头必须让合成过期”，以及场景 `reorder_shots_swap` / `move_shot_across_scenes` / `reorder_after_split` / `timeline_reorder_within_shot`。跨场景移动但全局顺序不变时合成保持新鲜（`move_shot_across_scenes_neutral`）。');
  p('2. **图校验接受非有限的画布坐标**（`src/graph.js`）。原始 `setLayout` 带 `NaN`/`Infinity` 通过 `validateGraph`（只检查 `typeof === number`），但规范 JSON 对非有限数抛错，等于事务提交后图无法落盘。`canvas.moveNode` 意图自己检查了，原始 op 没有。修复：校验用 `Number.isFinite`。回归：`atomicity.test.js`（`b14`/`b15`）。');
  p();
  p('另：旧表 `storyboards.duration` 是浮点秒（`duration_ms / 1000`），个别毫秒值乘回 1000 会出现 `8164.999999999999`；I8 按四舍五入还原。这不是缺陷，但物化写回旧表时要注意不要拿它做相等比较。');
  p();
  p('## 7. 数据在四个视图里的携带关系（`roundtrip.test.js` 断言）');
  p();
  p('对每类事实直接改原始图，看哪个视图的投影变了，要求与声明完全一致；每类事实至少一个视图可见，画布视图携带全部。结合“意图足迹”测试（每个内核意图只写它声明的路径，且导出的每个意图都必须有声明），证明经任何一个视图编辑不会丢掉它不携带的事实。');
  p();
  p('| 事实 | script | shot | timeline | canvas |');
  p('|---|---|---|---|---|');
  const T = [
    ['行文字 line.text', 1, 1, 1, 1], ['行说话人 / 行类型', 1, '摘要', 0, 1], ['场景标题 group.title', 1, 1, 0, 1], ['镜头标题/描述/提示词/角色/时长', 0, 1, 0, 1],
    ['image/video/narration 参数（种子、模型、音色）', 0, '摘要', 0, 1], ['片段 in/out', 0, '用时', 1, 1], ['片段 gap_before_ms', 0, 0, 1, 1], ['片段转场', 0, '场景缓存键', 1, 1],
    ['音乐', 0, 0, 1, 1], ['compose.fps / size / aigc_label', 0, 0, 0, 1], ['字幕样式覆盖', 0, 0, 1, 1], ['画布坐标 layout', 0, 0, 0, 1], ['镜头顺序（group.children）', 1, 1, 1, 1],
  ];
  const mark = (v) => (v === 1 ? '✓' : v === 0 ? '' : `（${v}）`);
  for (const r of T) p(`| ${r[0]} | ${[1, 2, 3, 4].map((i) => mark(r[i])).join(' | ')} |`);
  p();
  p('“摘要”= 视图只通过 cacheKey 摘要/状态间接反映变化，不携带内容本身。');
  p();
  p('## 8. 覆盖了什么、没覆盖什么（诚实清单）');
  p();
  p('**覆盖**：');
  p('- 全部 4 个视图的全部意图至少各被执行过一次（足迹测试要求每个导出的意图都有声明）；');
  p('- 任务要求的场景：改台词、拆/合/排镜头、跨场景移动、时间线裁剪/切分/跨镜头边界移动、转场、加音乐、画布移动（不改过期集合）、连线/断线/删节点、单镜头重新生成（只有该镜头链 + 合成过期，旧版本保留）、换音色、混合会话撤销重做（四种起手视图）、中途崩溃重载（四种起手视图）；另有版本回退、没有 compose 时先编辑再新建 compose、先切分再重排；');
  p('- 同一件事从不同视图做必须得到同一张图（镜头重排 = 移动到组 = 时间线跨边界移动；删镜头 = 画布删节点 = 时间线删最后一个片段；改台词 = 四个视图入口；重新生成/换音色/改镜头字段 = 分镜意图 = 画布属性编辑）；');
  p('- 事务原子性、对乱参数只抛 KernelError、随机会话（3 个种子，另在开发时用同一随机驱动额外跑过种子 4–18，均通过）。');
  p();
  p('**没覆盖 / 已知缺口**：');
  p('- **没有验证物化后的旧表**（I8 只验证 `toLegacyRows` 内部一致）：`materialize` / `importLegacy` / SQLite 快照与日志表在 `packages/local/src/kernel` 另一条任务线，这里是纯内核，快照/日志用“规范 JSON + 事务数组”模拟，没有真实的磁盘写入、事务中途断电、并发写入；');
  p('- **画布没有“改参数”意图**：画布属性面板编辑（改种子、音色、台词、镜头字段）在套件里用一条纯 `setParam` 事务代替（`canvasEdit`），它是否应成为正式意图（带校验、带 label）需要内核补一个；');
  p('- 视图是**数据模型**，不是 UI：没有测拖拽、选择、焦点、增量渲染，也没有测真实 UI 在视图间切换时的状态保持；');
  p('- 没有多人协作、并发事务冲突；没有超大图（几千节点）的性能测试（单图最大约 50 个节点）；');
  p('- 场景缓存键 `sceneKey` 只测了“哪些编辑会/不会改它”（裁剪、转场、gap、音乐、重新生成），没有对接真实 G02 渲染计划；字幕文字改动**不**改场景缓存键（规格如此），若 G02 把字幕烧进场景缓存，这是个需要产品确认的点；');
  p('- 故事是 10 个真实分镜表 + 3 个手写边界，没有真实的“用户手写剧本→生成”长链，也没有 50+ 镜头的长片；真实输出里没有多镜头共用一行、一行挂多个镜头的情形（只有手写边界故事里的一镜多行与未挂行；`insert_line` 等场景会制造一行挂一个镜头）；');
  p('- `adoptVersion` / `addVersion` / `setGroupTitle` 等没有对应意图的原子 op 只通过原始事务覆盖（版本回退场景、携带表）；');
  p('- 随机会话的画布连线只在“图校验不报错”时采用，被图校验拒绝的随机连线不计入。');
  p();
  if (fails.length) {
    p('## 9. 当前失败');
    p();
    for (const f of fails) p(`- \`${f.scenario}\` ${f.view}/${f.variant} @ ${f.story}：${String(f.error.message).split('\n')[0]}`);
    p();
  } else {
    p('## 9. 当前失败');
    p();
    p('无。');
    p();
  }
  p('## 10. 怎么跑');
  p();
  p('```');
  p('pnpm --filter @talekiln/kernel test            # 单元 + 一致性套件（node --test，分片并行）');
  p('node packages/kernel/test/conformance/report.js   # 跑完整矩阵、打印表格并重写本文件');
  p('node packages/kernel/test/conformance/report.js --quick --no-write   # 只跑矩阵、只打印');
  p('```');
  fs.writeFileSync(DOC, `${L.join('\n')}\n`);
  console.log(`\n已写 ${path.relative(ROOT, DOC)}`);
}
process.exitCode = fails.length || extras.some((e) => e.fail) ? 1 : 0;
