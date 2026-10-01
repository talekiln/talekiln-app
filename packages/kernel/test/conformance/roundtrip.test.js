'use strict';
// 来回一圈：剧本 -> 生成分镜 -> 时间线 -> 画布 -> 用各视图做“恒等编辑”回到剧本，图不变；
// 另外证明：每个意图的写入范围（它改动的图路径）不超过它声明的范围，每类事实由哪些视图携带，且没有任何视图编辑会丢掉它不携带的事实。
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../../src');
const O = require('./oracle');
const I = require('./invariants');
const S = require('./stories');

const { script, shot, timeline, canvas } = K.intents;
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 把 scriptView 渲染回 parseScript 能读的剧本文字。 */
function renderScript(g) {
  const out = [];
  for (const grp of K.scriptView(g).groups) {
    out.push(`# ${grp.title}`);
    for (const l of grp.lines) {
      if (l.kind === 'scene_heading') continue;
      out.push(l.kind === 'dialogue' ? `${l.speaker}：${l.text}` : l.kind === 'action' ? `△${l.text}` : l.text);
    }
  }
  return out.join('\n');
}

/** 故事是否能走“文字 -> parseScript”路径：场景标题行必须等于场景名且只能是第一行。 */
const textPath = (story) => story.scenes.every((sc) => sc.lines.every((l, i) => l.kind !== 'scene_heading' || (i === 0 && l.text === sc.title)));

/** 剧本文字建图，再用 addShot 意图“生成分镜”（外部生成器给出镜头，内核只落图）。 */
function scriptToShots(story) {
  const text = S.scriptText(story);
  let g = K.buildGraphFromScript(`proj-${story.id}`, text);
  const lineIdsByGroup = g.group_order.map((gid) => g.groups[gid].children.filter((c) => g.nodes[c].type === 'script_line'));
  story.scenes.forEach((sc, si) => {
    const hasHeading = sc.lines[0] && sc.lines[0].kind === 'scene_heading';
    for (const sh of sc.shots) {
      const { lines, legacy_id, ...params } = sh;
      const ids = lines.map((i) => lineIdsByGroup[si][hasHeading ? i : i + 1]);
      g = K.applyTx(g, shot.addShot(g, { group: g.group_order[si], params, lines: ids, legacy_id }, { tx_id: `gen:${story.id}:${legacy_id}` })).graph;
    }
  });
  return { text, g };
}

const J = (v) => JSON.stringify(v);
const allViews = (g) => I.viewsJSON(g);
/** 边 id 与顺序是实现细节：语义等价比较时把它们规范掉。 */
function semantic(g) {
  const c = structuredClone(g);
  c.edges = c.edges.map((e) => `${e.from.node}>${e.to.node}.${e.to.port}:${e.type}`).sort();
  return K.canonicalJSON(c);
}
const noLayout = (g) => { const c = structuredClone(g); c.layout = {}; return c; };

for (const story of S.loadStories()) {
  test(`来回一圈 @ ${story.id}`, () => {
    let g;
    if (textPath(story)) {
      const { text, g: built } = scriptToShots(story);
      g = built;
      // 剧本 -> 图 -> 剧本：文字无损
      assert.equal(renderScript(g), text, 'script text survives text -> graph -> text');
      // 和直接结构建图相比：场景、行文字、镜头参数、镜头-行关联一致（行 kind 以解析为准，可能与结构化来源不同）
      const direct = K.buildGraph({ project_id: 'x', scenes: story.scenes });
      assert.deepEqual(K.shotView(g).groups.map((x) => x.shots.map((s) => [s.legacy_id, s.params.duration_ms, s.params.image_prompt])), K.shotView(direct).groups.map((x) => x.shots.map((s) => [s.legacy_id, s.params.duration_ms, s.params.image_prompt])));
    } else {
      g = K.buildGraph({ project_id: `proj-${story.id}`, scenes: story.scenes });
    }
    I.checkGraph(g);
    g = S.adoptEverything(g);
    I.checkGraph(g);
    assert.deepEqual(K.staleSet(g), []);

    // 时间线：产生 F02 形状的四轨，片段数 = 镜头数
    const tl = K.timelineView(g);
    assert.equal(tl.tracks.find((t) => t.kind === 'video').clips.length, O.shotsInOrder(g).length);

    const base = { json: K.toJSON(g), views: allViews(g) };
    const expectUnchanged = (g2, label, { ignoreLayout = false, semanticOnly = false } = {}) => {
      if (semanticOnly) assert.equal(semantic(ignoreLayout ? noLayout(g2) : g2), semantic(ignoreLayout ? noLayout(g) : g), `${label}: graph changed`);
      else assert.equal(ignoreLayout ? K.canonicalJSON(noLayout(g2)) : K.toJSON(g2), ignoreLayout ? K.canonicalJSON(noLayout(g)) : base.json, `${label}: graph changed`);
      const v = allViews(g2);
      for (const name of ['script', 'shot', 'timeline']) assert.equal(v[name], base.views[name], `${label}: ${name} view changed`);
      if (semanticOnly) { // 边 id 是实现细节：画布视图比较节点与分组，边按端点比较
        const c = (x) => { const cv = JSON.parse(x); return J([cv.nodes, cv.groups, cv.group_order, cv.edges.map((e) => `${e.from.node}>${e.to.node}.${e.to.port}`).sort()]); };
        assert.equal(c(v.canvas), c(base.views.canvas), `${label}: canvas view changed`);
      } else if (!ignoreLayout) assert.equal(v.canvas, base.views.canvas, `${label}: canvas view changed`);
      assert.deepEqual(K.staleSet(g2), [], `${label}: nothing may become stale`);
    };
    const run = (tx) => { const r = K.applyTx(g, tx); assert.deepEqual(r.invalidated, [], tx.label); return r.graph; };

    const shots = O.shotsInOrder(g);
    const seg0 = g.nodes[O.composeNode(g)].params.segments[0];
    const line0 = O.linesInOrder(g)[0];
    const grp = g.group_order.find((x) => g.groups[x].children.some((c) => g.nodes[c].type === 'shot'));
    const grpShots = g.groups[grp].children.filter((c) => g.nodes[c].type === 'shot');
    const grpLines = g.groups[grp].children.filter((c) => g.nodes[c].type === 'script_line');
    const edge = g.edges.find((e) => e.type === 'derives' && e.to.port === 'shot');

    // ---- 画布视图的恒等编辑 ----
    expectUnchanged(run(canvas.connectNodes(g, edge.from.node, edge.to.node, { port: 'shot' })), 'canvas.connectNodes(existing edge)');
    // ---- 分镜视图 ----
    expectUnchanged(run(shot.setShotField(g, shots[0], { title: g.nodes[shots[0]].params.title, duration_ms: g.nodes[shots[0]].params.duration_ms })), 'shot.setShotField(same)');
    expectUnchanged(run(shot.reorderShots(g, grp, grpShots)), 'shot.reorderShots(same)');
    expectUnchanged(run(shot.moveShotToGroup(g, grpShots[0], grp, 0)), 'shot.moveShotToGroup(same place)');
    expectUnchanged(run(shot.regenerateShot(g, shots[0], { seed: g.nodes[O.chain(g, shots[0]).image].params.seed, targets: ['image'] })), 'shot.regenerateShot(same seed)');
    expectUnchanged(run(shot.setVoice(g, shots[0], { voice: g.nodes[O.chain(g, shots[0]).narration].params.voice })), 'shot.setVoice(same)');
    // ---- 时间线 ----
    expectUnchanged(run(timeline.trimSegment(g, seg0.id, { in_ms: seg0.in_ms, out_ms: seg0.out_ms })), 'timeline.trimSegment(same)');
    expectUnchanged(run(timeline.moveSegment(g, seg0.id, { gap_before_ms: seg0.gap_before_ms })), 'timeline.moveSegment(same gap)');
    expectUnchanged(run(timeline.setTransition(g, seg0.id, seg0.transition ?? null)), 'timeline.setTransition(same)');
    // ---- 回到剧本 ----
    expectUnchanged(run(script.rewriteLine(g, line0, { text: g.nodes[line0].params.text, speaker: g.nodes[line0].params.speaker, kind: g.nodes[line0].params.kind })), 'script.rewriteLine(same)');
    expectUnchanged(run(script.reorderLines(g, grp, grpLines)), 'script.reorderLines(same)');

    // 先做再还原：每次还原后图回到原样（经过另一个视图的意图）
    // a) 剧本视图：拆行再并回（拆在中点；mergeLines 的拼接与 splitLine 互逆）
    const splittable = O.linesInOrder(g).find((l) => g.nodes[l].params.text.length >= 2);
    let h = K.applyTx(g, script.splitLine(g, splittable, 1)).graph;
    h = K.applyTx(h, script.mergeLines(h, splittable, K.scriptView(h).groups.flatMap((x) => x.lines).find((l, i, arr) => arr[i - 1] && arr[i - 1].id === splittable).id)).graph;
    expectUnchanged(h, 'script.splitLine -> script.mergeLines', { semanticOnly: true });
    // b) 时间线：裁剪再恢复
    h = K.applyTx(g, timeline.trimSegment(g, seg0.id, { in_ms: seg0.in_ms + 1, out_ms: seg0.out_ms })).graph;
    assert.ok(K.staleSet(h).includes(O.composeNode(h)), 'trim makes the compose stale');
    h = K.applyTx(h, timeline.trimSegment(h, seg0.id, { in_ms: seg0.in_ms, out_ms: seg0.out_ms })).graph;
    expectUnchanged(h, 'timeline.trim -> timeline.untrim (compose becomes fresh again)');
    // c) 画布：断线再连回
    h = K.applyTx(g, canvas.disconnectNodes(g, { edge_id: edge.id })).graph;
    h = K.applyTx(h, canvas.connectNodes(h, edge.from.node, edge.to.node, { port: edge.to.port })).graph;
    expectUnchanged(h, 'canvas.disconnect -> canvas.connect', { semanticOnly: true });
    // d) 分镜：拆镜头再并回只在“没有挪走行”时无损（拆在末尾）；这里验证新镜头删除后回到原样
    const spTx = shot.splitShot(g, shots[0], O.linesOf(g, shots[0]).length);
    const g2 = K.applyTx(g, spTx).graph;
    h = K.applyTx(g2, shot.deleteShot(g2, spTx.meta.shot_id)).graph;
    expectUnchanged(h, 'shot.splitShot(at end) -> shot.deleteShot(new shot)', { semanticOnly: true });
    // e) 画布：移动节点再看其余视图（graph 只多了 layout）
    h = K.applyTx(g, canvas.moveNode(g, shots[0], { x: 7, y: 8 })).graph;
    expectUnchanged(h, 'canvas.moveNode', { ignoreLayout: true });
    // f) 全部串起来：以上全部事务依次应用到同一张图，终态 = 原图（忽略 layout / 边 id）
    let chain = g;
    const steps = [
      (x) => canvas.moveNode(x, shots[0], { x: 7, y: 8 }),
      (x) => timeline.trimSegment(x, seg0.id, { in_ms: seg0.in_ms + 1, out_ms: seg0.out_ms }),
      (x) => timeline.trimSegment(x, seg0.id, { in_ms: seg0.in_ms, out_ms: seg0.out_ms }),
      (x) => canvas.disconnectNodes(x, { edge_id: edge.id }),
      (x) => canvas.connectNodes(x, edge.from.node, edge.to.node, { port: edge.to.port }),
      (x) => script.rewriteLine(x, line0, { text: x.nodes[line0].params.text + '!' }),
      (x) => script.rewriteLine(x, line0, { text: g.nodes[line0].params.text }),
    ];
    for (const st of steps) { chain = K.applyTx(chain, st(chain)).graph; I.checkGraph(chain); }
    // 这些事务里，除去 canvas 的 layout 与重连后的新边 id，其余与原图相同；生成节点没有被重新生成，所以过期集合 = 被改过的节点
    assert.equal(semantic(noLayout(chain)), semantic(noLayout(g)));
    assert.deepEqual(K.staleSet(chain), K.staleSet(chain).filter((id) => O.GENERATED.includes(chain.nodes[id].type)));
    assert.deepEqual(I.viewsJSON(chain).script, base.views.script, 'back at the script view: identical');
  });
}

// ---------- 每个意图的写入范围（足迹） ----------
// 对 gf-01 的全新鲜图，逐个意图执行一次非恒等编辑，断言它改动的图路径都落在声明的范围内。
const story0 = S.loadStories().find((s) => s.id === 'gf-01');
test('意图足迹：每个意图只写它声明的路径；内核导出的每个意图都有足迹声明', () => {
  const g = S.prepared(story0);
  const shots = O.shotsInOrder(g);
  const [s0, s1] = shots;
  const c0 = O.chain(g, s0);
  const cid = O.composeNode(g);
  const lines = O.linesInOrder(g);
  const spoken = lines.find((l) => O.SPOKEN.includes(g.nodes[l].params.kind));
  const seg0 = g.nodes[cid].params.segments[0];
  const segs = g.nodes[cid].params.segments;
  const grp = g.group_order[0];
  const grp1 = g.group_order[1];
  const line0Edge = g.edges.find((e) => e.to.port === 'lines');
  const P = (...x) => x.map((r) => new RegExp(r));
  const foot = {
    script: {
      rewriteLine: [() => script.rewriteLine(g, spoken, { text: '新', speaker: '甲' }), P(`^nodes\\.${spoken}\\.params\\.(text|speaker)$`)],
      insertLine: [() => script.insertLine(g, { group: grp, text: 'x', shot_ids: [s0] }), P('^nodes\\.line_\\d+\\.', `^groups\\.${grp}\\.children$`, '^edges\\.', '^edges#order$')],
      deleteLine: [() => script.deleteLine(g, spoken), P(`^nodes\\.${spoken}\\.`, '^edges\\.', '^edges#order$', '^groups\\.')],
      splitLine: [() => script.splitLine(g, spoken, 1), P(`^nodes\\.${spoken}\\.params\\.text$`, '^nodes\\.line_\\d+\\.', '^groups\\.', '^edges\\.', '^edges#order$')],
      mergeLines: [() => { const sv = K.scriptView(g).groups[0].lines; return script.mergeLines(g, sv[0].id, sv[1].id); }, P('^nodes\\.line_\\d+\\.', '^groups\\.', '^edges\\.', '^edges#order$')],
      reorderLines: [() => script.reorderLines(g, grp, [...g.groups[grp].children.filter((c) => g.nodes[c].type === 'script_line')].reverse()), P(`^groups\\.${grp}\\.children$`)],
    },
    shot: {
      setShotField: [() => shot.setShotField(g, s0, { title: '新标题', duration_ms: 3000 }), P(`^nodes\\.${s0}\\.params\\.(title|duration_ms)$`, `^nodes\\.${cid}\\.params\\.segments$`)],
      splitShot: [() => shot.splitShot(g, s0, 1), P('^nodes\\.(shot|img|vid|nar)_\\d+\\.', '^edges\\.', '^edges#order$', '^groups\\.', `^nodes\\.${cid}\\.params\\.segments$`)],
      mergeShots: [() => shot.mergeShots(g, s0, s1), P(`^nodes\\.${s0}\\.params\\.duration_ms$`, '^nodes\\.', '^edges\\.', '^edges#order$', '^groups\\.', '^layout\\.', '^versions\\.', '^adopted\\.')],
      reorderShots: [() => shot.reorderShots(g, grp, [...g.groups[grp].children.filter((c) => g.nodes[c].type === 'shot')].reverse()), P(`^groups\\.${grp}\\.children$`)],
      moveShotToGroup: [() => shot.moveShotToGroup(g, s0, grp1, 0), P(`^groups\\.(${grp}|${grp1})\\.children$`)],
      addShot: [() => shot.addShot(g, { group: grp, params: { title: 'n' } }), P('^nodes\\.(shot|img|vid|nar)_\\d+\\.', '^edges\\.', '^edges#order$', '^groups\\.', `^nodes\\.${cid}\\.params\\.segments$`)],
      deleteShot: [() => shot.deleteShot(g, s0), P(`^nodes\\.(${s0}|${c0.image}|${c0.video}|${c0.narration})\\.`, '^edges\\.', '^edges#order$', '^groups\\.', '^layout\\.', '^versions\\.', '^adopted\\.', `^nodes\\.${cid}\\.params\\.segments$`)],
      setShotReferences: [() => shot.setShotReferences(g, s0, { image_model: 'm-i', video_model: 'm-v', reference_hashes: ['r1'], tail_frame_hash: 't1' }), P(`^nodes\\.(${c0.image}|${c0.video})\\.params\\.(model|reference_hashes|tail_frame_hash)$`)],
      regenerateShot: [() => shot.regenerateShot(g, s0, { seed: 5 }), P(`^nodes\\.(${c0.image}|${c0.video})\\.params\\.seed$`)],
      setVoice: [() => shot.setVoice(g, s0, { voice: 'v', speed: 1.5 }), P(`^nodes\\.${c0.narration}\\.params\\.(voice|speed)$`)],
      recordGeneration: [() => S.generateTx(g, [c0.image]), P(`^versions\\.${c0.image}$`, `^adopted\\.${c0.image}$`)],
    },
    timeline: {
      trimSegment: [() => timeline.trimSegment(g, seg0.id, { in_ms: 100 }), P(`^nodes\\.${cid}\\.params\\.segments$`)],
      moveSegment: [() => timeline.moveSegment(g, seg0.id, { gap_before_ms: 300 }), P(`^nodes\\.${cid}\\.params\\.segments$`)],
      splitSegment: [() => timeline.splitSegment(g, seg0.id, seg0.in_ms + 1000), P(`^nodes\\.${cid}\\.params\\.segments$`)],
      deleteSegment: [() => timeline.deleteSegment(g, seg0.id), P(`^nodes\\.(${s0}|${c0.image}|${c0.video}|${c0.narration})\\.`, '^edges\\.', '^edges#order$', '^groups\\.', '^layout\\.', '^versions\\.', '^adopted\\.', `^nodes\\.${cid}\\.params\\.segments$`)],
      setTransition: [() => timeline.setTransition(g, segs[1].id, 'fade'), P(`^nodes\\.${cid}\\.params\\.segments$`)],
      addMusic: [() => timeline.addMusic(g, { asset_ref: 'm.mp3', start_ms: 0, duration_ms: 1000 }), P(`^nodes\\.${cid}\\.params\\.music$`)],
    },
    canvas: {
      moveNode: [() => canvas.moveNode(g, s0, { x: 1, y: 2 }), P(`^layout\\.${s0}$`)],
      setNodeParam: [() => canvas.setNodeParam(g, c0.narration, ['voice'], '另一个声音'), P(`^nodes\\.${c0.narration}\\.params\\.voice$`)],
      moveNodes: [() => canvas.moveNodes(g, { [s0]: { x: 1, y: 2 }, [cid]: { x: 3, y: 4 } }), P('^layout\\.')],
      connectNodes: [() => canvas.connectNodes(g, lines[1], s1, { port: 'lines' }), P('^edges\\.', '^edges#order$')],
      disconnectNodes: [() => canvas.disconnectNodes(g, { edge_id: line0Edge.id }), P('^edges\\.', '^edges#order$')],
      addNodeAt: [() => canvas.addNodeAt(g, 'image', { x: 1, y: 2 }), P('^nodes\\.img_\\d+\\.', '^layout\\.img_\\d+$')],
      deleteNode: [() => canvas.deleteNode(g, c0.image), P(`^nodes\\.${c0.image}\\.`, '^edges\\.', '^edges#order$', `^layout\\.${c0.image}$`, `^versions\\.${c0.image}$`, `^adopted\\.${c0.image}$`)],
    },
  };
  for (const [view, intents] of Object.entries(K.intents)) {
    for (const name of Object.keys(intents)) {
      if (['addShotOps', 'removeShotNodesOps'].includes(name)) continue; // 内部构造函数，不是意图
      assert.ok(foot[view] && foot[view][name], `intent ${view}.${name} has no declared write footprint`);
    }
  }
  for (const [view, table] of Object.entries(foot)) {
    for (const [name, [mk, allowed]] of Object.entries(table)) {
      const tx = mk();
      const after = K.applyTx(g, tx).graph;
      const changed = O.changedPaths(g, after);
      assert.ok(changed.length > 0, `${view}.${name} changed nothing`);
      const bad = changed.filter((p) => !allowed.some((re) => re.test(p)));
      assert.deepEqual(bad, [], `${view}.${name} wrote outside its footprint`);
      I.checkGraph(after);
    }
  }
});

// ---------- 每类事实由哪些视图携带 ----------
// 对每类事实做“直接改原始图”的变异，看四个投影里哪些变了；要求和声明的携带表完全一致，
// 并且每一类事实至少被一个视图携带（否则它对用户不可见，也无法被某个视图“误丢”）。
test('携带表：每类事实由哪些视图携带，与声明一致', () => {
  const g = S.prepared(S.loadStories().find((s) => s.id === 'ke-02'));
  const shots = O.shotsInOrder(g);
  const s0 = shots[0];
  const c0 = O.chain(g, s0);
  const cid = O.composeNode(g);
  const spoken = O.linesOf(g, s0).find((l) => O.SPOKEN.includes(g.nodes[l].params.kind));
  const seg0 = g.nodes[cid].params.segments[0];
  const set = (node, key, value) => ({ op: 'setParam', node, path: [key], value });
  const segs = (f) => [{ op: 'setComposeSegments', node: cid, segments: g.nodes[cid].params.segments.map((s, i) => (i === 0 ? f(s) : s)) }];
  const grp0 = g.group_order[0];
  // 事实 -> [变异 ops, 声明的携带视图]
  const facts = {
    'line.text': [[set(spoken, 'text', '变了')], ['script', 'shot', 'timeline', 'canvas']],
    'line.speaker': [[set(spoken, 'speaker', '另一个人')], ['script', 'shot', 'canvas']], // shot 视图只通过 cacheKey 摘要“看到”它
    'line.kind(dialogue<->narration)': [[set(spoken, 'kind', g.nodes[spoken].params.kind === 'dialogue' ? 'narration' : 'dialogue')], ['script', 'shot', 'canvas']], // shot：同上，仅 key 摘要
    'group.title': [[{ op: 'setGroupTitle', group: grp0, title: '改名' }], ['script', 'shot', 'canvas']],
    'shot.title': [[set(s0, 'title', '改')], ['shot', 'canvas']],
    'shot.description': [[set(s0, 'description', '改')], ['shot', 'canvas']],
    'shot.image_prompt': [[set(s0, 'image_prompt', '改')], ['shot', 'canvas']],
    'shot.video_prompt': [[set(s0, 'video_prompt', '改')], ['shot', 'canvas']],
    'shot.characters': [[set(s0, 'characters', ['改'])], ['shot', 'canvas']],
    'shot.duration_ms': [[set(s0, 'duration_ms', g.nodes[s0].params.duration_ms + 1)], ['shot', 'canvas']],
    'shot.legacy_id': [null, ['shot', 'timeline', 'canvas']], // 由下面单独处理（addNode 无法改 legacy_id，用重建图）
    'image.seed': [[set(c0.image, 'seed', 99)], ['shot', 'canvas']], // shot 视图只带 key 摘要与状态
    'video.model': [[set(c0.video, 'model', 'm2')], ['shot', 'canvas']],
    'image.model': [[set(c0.image, 'model', 'm1')], ['shot', 'canvas']],
    'image.reference_hashes（锁定参考图）': [[set(c0.image, 'reference_hashes', ['ref:a'])], ['shot', 'canvas']],
    'video.tail_frame_hash（尾帧）': [[set(c0.video, 'tail_frame_hash', 'tail:a')], ['shot', 'canvas']],
    'narration.voice': [[set(c0.narration, 'voice', '另一个声音')], ['shot', 'canvas']],
    'segment.in/out': [segs((s) => ({ ...s, in_ms: s.in_ms + 1 })), ['shot', 'timeline', 'canvas']],
    'segment.gap_before_ms': [segs((s) => ({ ...s, gap_before_ms: 5 })), ['timeline', 'canvas']],
    'segment.transition': [segs((s) => ({ ...s, transition: 'fade' })), ['timeline', 'canvas']], // 转场不进场景缓存键（G02 目前不渲染转场）
    'compose.music': [[set(cid, 'music', [{ id: 'mus_1', asset_ref: 'm.mp3', start_ms: 0, duration_ms: 500, src_in_ms: 0, volume: 1 }])], ['timeline', 'canvas']],
    'compose.fps/size/aigc_label': [[set(cid, 'fps', 24)], ['canvas']],
    'compose.subtitle_overrides': [[set(cid, 'subtitle_overrides', { [spoken]: { font_size: 40 } })], ['shot', 'timeline', 'canvas']], // shot：字幕样式烧进画面，进场景缓存键
    'layout': [[{ op: 'setLayout', node: s0, pos: { x: 1, y: 2 } }], ['canvas']],
    'shot order (group children)': [[{ op: 'setChildren', group: g.group_order.find((x) => g.groups[x].children.filter((c) => g.nodes[c].type === 'shot').length >= 2), ids: (() => { const gid = g.group_order.find((x) => g.groups[x].children.filter((c) => g.nodes[c].type === 'shot').length >= 2); return [...g.groups[gid].children].reverse(); })() }], ['shot', 'timeline', 'canvas', 'script']],
  };
  delete facts['shot.legacy_id'];
  const base = I.viewsJSON(g);
  const table = {};
  for (const [name, [ops, declared]] of Object.entries(facts)) {
    let after;
    try { after = K.applyTx(g, { tx_id: `fact:${name}`, ops }).graph; } catch (e) { assert.fail(`${name}: ${e.message}`); }
    const v = I.viewsJSON(after);
    const carriers = ['script', 'shot', 'timeline', 'canvas'].filter((k) => v[k] !== base[k]);
    table[name] = carriers;
    assert.deepEqual(carriers, [...declared].sort((a, b) => ['script', 'shot', 'timeline', 'canvas'].indexOf(a) - ['script', 'shot', 'timeline', 'canvas'].indexOf(b)), `fact "${name}" carried by`);
    assert.ok(carriers.length >= 1, `fact "${name}" is invisible in every view`);
  }
  // 画布视图携带“全部”节点参数与布局、边与分组：它是完整视图；其余视图各携带一部分，
  // 一个视图的编辑只写自己携带的事实（见上面的意图足迹测试），所以不会丢掉它不携带的事实。
  assert.ok(Object.values(table).every((c) => c.includes('canvas')), 'canvasView carries every fact family tested');
});

test('shot.legacy_id 由 shot、timeline（storyboard_id）、canvas 视图携带，且任何编辑都不会改它', () => {
  const g = S.prepared(story0);
  const ids = O.shotsInOrder(g).map((s) => g.nodes[s].legacy_id);
  const tl = K.timelineView(g).tracks.find((t) => t.kind === 'video').clips.map((c) => c.storyboard_id);
  assert.deepEqual(tl, ids);
  assert.deepEqual(K.shotView(g).groups.flatMap((x) => x.shots.map((s) => s.legacy_id)), ids);
  assert.deepEqual(K.canvasView(g).nodes.filter((n) => n.type === 'shot').map((n) => n.legacy_id).sort(), [...ids].sort());
  // 经过一整串跨视图编辑（不含删除与拆分）后，镜头 legacy_id 不变
  let h = g;
  const seq = [
    (x) => script.rewriteLine(x, O.linesInOrder(x)[1], { text: 'z' }),
    (x) => shot.reorderShots(x, x.group_order[1], [...x.groups[x.group_order[1]].children.filter((c) => x.nodes[c].type === 'shot')].reverse()),
    (x) => timeline.splitSegment(x, x.nodes[O.composeNode(x)].params.segments[0].id, x.nodes[O.composeNode(x)].params.segments[0].in_ms + 1),
    (x) => canvas.moveNode(x, O.shotsInOrder(x)[0], { x: 1, y: 1 }),
    (x) => shot.mergeShots(x, O.shotsInOrder(x)[2], O.shotsInOrder(x)[3]),
  ];
  for (const f of seq) h = K.applyTx(h, f(h)).graph;
  for (const s of O.shotsInOrder(h)) if (g.nodes[s]) assert.equal(h.nodes[s].legacy_id, g.nodes[s].legacy_id);
});
