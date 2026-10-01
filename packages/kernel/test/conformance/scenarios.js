'use strict';
// 场景库。每个场景：{ id, title, applicable(g,story)->原因|null, equivalence?, entries:{ script|shot|timeline|canvas: [变体] } }
// 变体：{ name, steps(g0, story) -> [步骤函数] }；步骤函数 (g, o, env) -> { tx, writes, invalidated, ... }。
// 入口视图通过“该视图自己的投影”定位目标（scriptView 的行 id、shotView 的行、timelineView 的片段/字幕 clip、canvasView 的节点），
// 再调用该视图的意图；画布没有“改参数”意图，用 canvasEdit（一条纯 setParam 事务，等价于属性面板编辑）。
// 期望的失效集合全部手工推导（写在每个场景旁边），不是从内核结果复制。
const assert = require('node:assert/strict');
const K = require('../../src');
const O = require('./oracle');
const S = require('./stories');

const { script, shot, timeline, canvas } = K.intents;

// ---------- 通用小工具 ----------
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const W = (...res) => res.map((r) => (r instanceof RegExp ? r : new RegExp(r)));
const mid = (a) => a[Math.floor((a.length - 1) / 2)];
const uniq = (a) => [...new Set(a)];
const flatShots = (g) => K.shotView(g).groups.flatMap((x) => x.shots);
const shotGroups = (g) => K.shotView(g).groups.filter((x) => x.shots.length);
const allLines = (g) => K.scriptView(g).groups.flatMap((x) => x.lines.map((l) => ({ ...l, group: x.id })));
const spokenAttached = (g) => allLines(g).filter((l) => O.SPOKEN.includes(l.kind) && l.shot_ids.length);
const composeId = (g) => O.composeNode(g);
const clipRuns = (g) => { // 视频轨按“镜头连续段”分组：每个镜头一组片段 id（与镜头顺序一一对应，由 I1 保证）
  const segs = Object.fromEntries(g.nodes[composeId(g)].params.segments.map((s) => [s.id, s.shot_id]));
  const runs = [];
  for (const c of K.timelineView(g).tracks.find((t) => t.kind === 'video').clips) {
    const sid = segs[c.id];
    if (!runs.length || runs[runs.length - 1].shot !== sid) runs.push({ shot: sid, clips: [] });
    runs[runs.length - 1].clips.push(c);
  }
  return runs;
};
const composeParam = (g, k) => g.nodes[composeId(g)].params[k];
const composeW = (g, ...ks) => W(...ks.map((k) => `^nodes\\.${esc(composeId(g))}\\.params\\.${k}$`));
const compose1 = (g) => [composeId(g)];
const chainsPlusCompose = (g, shotIds) => (shotIds.length ? sortedUniq([...shotIds.flatMap((s) => O.chainIds(g, s)), composeId(g)]) : []);
const sortedUniq = (a) => uniq(a).sort();

/** 画布“属性面板”编辑：一条纯 setParam 事务（内核没有对应的画布意图，见报告“缺口”）。 */
const canvasEdit = (o, edits) => ({ tx_id: o.tx_id, label: 'canvasEdit', ops: edits.map(([node, key, value]) => ({ op: 'setParam', node, path: [key], value })) });

const needShots = (n) => (g) => (O.shotsInOrder(g).length >= n ? null : `需要至少 ${n} 个镜头`);
const needTwoShotGroups = (g) => (shotGroups(g).length >= 2 ? null : '需要至少两个含镜头的场景');
const needLine = (g) => (spokenAttached(g).length ? null : '没有挂到镜头的对白/旁白行');
const all = (...fs) => (g, s) => { for (const f of fs) { const r = f(g, s); if (r) return r; } return null; };

const variant = (name, steps) => ({ name, steps });
const one = (fn) => () => [fn];

// ---------- 场景：改一行台词 ----------
function rewriteTarget(g0) { return mid(spokenAttached(g0)); }
function lineEditEntries(kind) { // kind: 'text' | 'kind'
  const NEW = (T) => (kind === 'text' ? `改写后的台词：${T.id}` : 'action');
  const patch = (T) => (kind === 'text' ? { text: NEW(T) } : { kind: 'action' });
  const key = kind;
  const expect = (g, T) => ({
    writes: W(`^nodes\\.${esc(T.id)}\\.params\\.${key}$`),
    invalidated: chainsPlusCompose(g, O.shotsOfLine(g, T.id)),
    check: (before, after) => {
      const L = allLines(after).find((l) => l.id === T.id);
      assert.equal(L[key === 'text' ? 'text' : 'kind'], NEW(T), 'scriptView shows the edit');
      const rows = flatShots(after).filter((s) => s.line_ids.includes(T.id));
      for (const r of rows) {
        if (kind === 'text') assert.ok(r.dialogue.includes(NEW(T)), 'shotView dialogue shows the edit');
        else assert.ok(!r.dialogue.includes(T.text), 'a line turned into action leaves the dialogue');
      }
      const sub = K.timelineView(after).tracks.find((t) => t.kind === 'subtitle').clips;
      if (kind === 'text') assert.ok(sub.some((c) => c.text.includes(NEW(T))), 'timeline subtitle shows the edit');
      assert.equal(K.canvasView(after).nodes.find((n) => n.id === T.id).params[key], NEW(T), 'canvasView shows the edit');
      if (kind === 'kind') {
        const rowsLegacy = K.toLegacyRows(after).storyboards.filter((r) => rows.some((x) => x.id === r.shot_id));
        assert.ok(rowsLegacy.every((r) => r.action.includes(T.text)), 'legacy action column gets the line');
      }
    },
  });
  const locate = {
    script: (g, T) => { const L = allLines(g).find((l) => l.id === T.id); assert.equal(L.text, T.text); return T.id; },
    shot: (g, T) => { const r = flatShots(g).find((s) => s.line_ids.includes(T.id)); assert.ok(r, 'shot row carries the line'); assert.ok(r.dialogue.includes(T.text) || !O.SPOKEN.includes(T.kind)); return T.id; },
    timeline: (g, T) => {
      const sub = K.timelineView(g).tracks.find((t) => t.kind === 'subtitle').clips.find((c) => c.text.includes(T.text));
      assert.ok(sub, 'subtitle clip carries the text');
      const row = flatShots(g).find((s) => s.id === sub.id.replace(/^sub_/, ''));
      assert.ok(row.line_ids.includes(T.id));
      return T.id;
    },
    canvas: (g, T) => { assert.equal(K.canvasView(g).nodes.find((n) => n.id === T.id).params.text, T.text); return T.id; },
  };
  const mk = (view) => variant(view === 'canvas' ? 'setParam' : 'rewriteLine', (g0) => {
    const T = rewriteTarget(g0);
    return [(g, o) => {
      const id = locate[view](g, T);
      const tx = view === 'canvas' ? canvasEdit(o, [[id, key, patch(T)[key]]]) : script.rewriteLine(g, id, patch(T), o);
      return { tx, ...expect(g, T) };
    }];
  });
  return { script: [mk('script')], shot: [mk('shot')], timeline: [mk('timeline')], canvas: [mk('canvas')] };
}

// ---------- 场景：镜头顺序（交换相邻镜头） ----------
function swapTarget(g) {
  const grp = shotGroups(g).find((x) => x.shots.length >= 2);
  return grp ? { gid: grp.id, ids: grp.shots.map((s) => s.id) } : null;
}
function crossTarget(g, neutral) {
  const gs = shotGroups(g);
  if (gs.length < 2) return null;
  if (neutral) { const A = gs[0]; const B = gs[1]; return { A, B, x: A.shots[A.shots.length - 1].id }; } // A 的最后一个 -> B 的开头：全局顺序不变
  const A = gs[0]; const B = gs[gs.length - 1];
  return { A, B, x: A.shots[0].id }; // A 的第一个 -> B 的末尾：全局顺序改变
}
const shotOrderAfterMove = (g, x, toGroup, atEnd) => { // 手工推导移动后的全局镜头顺序（不调内核）
  const order = O.shotsInOrder(g).filter((s) => s !== x);
  const dest = g.groups[toGroup].children.filter((c) => g.nodes[c].type === 'shot' && c !== x);
  if (atEnd) { const at = dest.length ? order.indexOf(dest[dest.length - 1]) + 1 : order.length; order.splice(at, 0, x); } else { const at = dest.length ? order.indexOf(dest[0]) : order.length; order.splice(at, 0, x); }
  return order;
};

// ---------- 步骤库（会话类场景复用；全部基于“当前图”现算目标，保证任意前序编辑后仍可用） ----------
const STEP = {
  scriptRewrite: (g, o) => { const L = mid(spokenAttached(g)) || allLines(g)[0]; return script.rewriteLine(g, L.id, { text: `${L.text}（会话改）` }, o); },
  scriptInsert: (g, o) => { const grp = shotGroups(g)[0] || K.scriptView(g).groups[0]; const sh = grp.shots ? grp.shots[0].id : undefined; return script.insertLine(g, { group: grp.id, index: 0, text: '会话新增行', kind: 'narration', shot_ids: sh ? [sh] : [] }, o); },
  shotTitle: (g, o) => shot.setShotField(g, mid(flatShots(g)).id, { title: '会话标题', image_prompt: '会话提示词' }, o),
  shotAdd: (g, o) => { const grp = K.shotView(g).groups[K.shotView(g).groups.length - 1]; return shot.addShot(g, { group: grp.id, params: { title: '会话新镜头', duration_ms: 2500 }, lines: [] }, o); },
  shotRegen: (g, o) => shot.regenerateShot(g, flatShots(g)[0].id, { seed: 4242 }, o),
  shotVoice: (g, o) => { const f = flatShots(g).find((x) => O.chain(g, x.id).narration) || flatShots(g)[0]; return shot.setVoice(g, f.id, { voice: '会话音色' }, o); },
  timelineTrim: (g, o) => { const c = clipRuns(g)[0].clips[0]; const s = g.nodes[composeId(g)].params.segments.find((x) => x.id === c.id); const d = s.out_ms - s.in_ms; return timeline.trimSegment(g, s.id, { in_ms: s.in_ms + Math.floor(d / 10), out_ms: s.out_ms - Math.floor(d / 10) }, o); },
  timelineMoveLast: (g, o) => { const runs = clipRuns(g); const last = runs[runs.length - 1].clips[0]; return timeline.moveSegment(g, last.id, { before_segment_id: runs[0].clips[0].id }, o); },
  timelineTransition: (g, o) => timeline.setTransition(g, clipRuns(g)[0].clips[0].id, 'fade', o),
  timelineMusic: (g, o) => timeline.addMusic(g, { asset_ref: 'music/bgm.mp3', start_ms: 500, duration_ms: 4000, volume: 0.6 }, o),
  canvasMove: (g, o) => canvas.moveNode(g, mid(flatShots(g)).id, { x: 123.5, y: -40 }, o),
  canvasDeleteNar: (g, o) => canvas.deleteNode(g, flatShots(g).map((x) => O.chain(g, x.id).narration).find(Boolean), o),
  canvasConnectBack: (g, o) => { const f = flatShots(g)[0]; const c = O.chain(g, f.id); return g.nodes[c.narration] ? canvas.moveNode(g, c.narration, { x: 9, y: 9 }, o) : canvas.moveNode(g, f.id, { x: 9, y: 9 }, o); },
};
const asStep = (fn) => (g, o) => ({ tx: fn(g, o) });
const VIEW_STEPS = {
  script: [STEP.scriptRewrite, STEP.scriptInsert],
  shot: [STEP.shotAdd, STEP.shotRegen],
  timeline: [STEP.timelineTrim, STEP.timelineMoveLast],
  canvas: [STEP.canvasMove, STEP.canvasDeleteNar],
};
const ROT = ['script', 'shot', 'timeline', 'canvas'];
const rotated = (lead) => { const i = ROT.indexOf(lead); return [...ROT.slice(i), ...ROT.slice(0, i)]; };
const sessionApplicable = all(needShots(3), needTwoShotGroups, needLine);
function mixedSession(lead) {
  return variant(`lead:${lead}`, () => {
    const vs = rotated(lead);
    const txs = [...vs.map((v) => VIEW_STEPS[v][0]), ...vs.map((v) => VIEW_STEPS[v][1])].map(asStep);
    const U = () => ({ undo: true });
    const R = () => ({ redo: true });
    return [...txs, U, U, U, R, asStep(STEP.shotVoice), U, U, R, R, asStep(STEP.timelineTransition), asStep(STEP.timelineMusic)];
  });
}
function crashSession(lead) {
  return variant(`lead:${lead}`, () => {
    const vs = rotated(lead);
    const t = (v, i) => asStep(VIEW_STEPS[v][i]);
    const U = () => ({ undo: true });
    const R = () => ({ redo: true });
    return [
      t(vs[0], 0), t(vs[1], 0), t(vs[2], 0),
      () => ({ crash: { back: 2 } }),
      t(vs[3], 0), U, U, R,
      () => ({ crash: { back: 0 } }),
      t(vs[0], 1), t(vs[1], 1),
      () => ({ crash: { back: 1 } }),
      t(vs[2], 1), t(vs[3], 1),
      () => ({ crash: { back: 99 } }),
      U, R,
    ];
  });
}

// ---------- 场景定义 ----------
const SCENARIOS = [
  {
    id: 'rewrite_line', title: '改写一行台词（旁白/对白）', applicable: needLine, equivalence: 'graph',
    // 手工推导：该行挂到的每个镜头，其 image/video/narration 都过期，合成过期；其它镜头不动。
    entries: lineEditEntries('text'),
  },
  {
    id: 'change_line_kind', title: '把台词行改成动作行（对白 -> action）', applicable: needLine, equivalence: 'graph',
    entries: lineEditEntries('kind'),
  },
  {
    id: 'split_line', title: '拆一行台词为两行', applicable: (g) => (spokenAttached(g).some((l) => l.text.length >= 4) ? null : '没有长度>=4 的挂镜头台词'),
    entries: {
      script: [variant('splitLine', (g0) => {
        const T = mid(spokenAttached(g0).filter((l) => l.text.length >= 4));
        return [(g, o) => {
          const at = Math.floor(T.text.length / 2);
          const tx = script.splitLine(g, T.id, at, o);
          return {
            tx, invalidated: chainsPlusCompose(g, O.shotsOfLine(g, T.id)),
            check: (b, a) => {
              const newId = tx.meta.line_id;
              const A = allLines(a);
              assert.equal(A.find((l) => l.id === T.id).text + A.find((l) => l.id === newId).text, T.text, 'no characters lost or duplicated');
              assert.deepEqual(A.find((l) => l.id === newId).shot_ids, T.shot_ids, 'new half attaches to the same shots');
              assert.equal(A.length, allLines(b).length + 1);
            },
          };
        }];
      })],
    },
  },
  {
    id: 'merge_lines', title: '合并两行相邻台词', applicable: (g) => (K.scriptView(g).groups.some((x) => x.lines.length >= 2) ? null : '没有相邻行'),
    entries: {
      script: [variant('mergeLines', (g0) => {
        const pairs = K.scriptView(g0).groups.flatMap((x) => x.lines.slice(1).map((l, i) => [x.lines[i], l]));
        const [a, b] = mid(pairs);
        return [(g, o) => {
          const tx = script.mergeLines(g, a.id, b.id, { sep: '' }, o);
          const shots = sortedUniq([...O.shotsOfLine(g, a.id), ...O.shotsOfLine(g, b.id)]);
          return {
            tx, invalidated: chainsPlusCompose(g, shots),
            check: (bf, af) => {
              const A = allLines(af);
              assert.ok(!A.some((l) => l.id === b.id), 'b removed');
              assert.equal(A.find((l) => l.id === a.id).text, a.text + b.text);
              assert.deepEqual(A.find((l) => l.id === a.id).shot_ids, shots.filter((s) => O.shotsInOrder(af).includes(s)).sort((x, y) => O.shotsInOrder(af).indexOf(x) - O.shotsInOrder(af).indexOf(y)));
            },
          };
        }];
      })],
    },
  },
  {
    id: 'reorder_lines', title: '反转一个场景里的行顺序', applicable: (g) => (K.scriptView(g).groups.some((x) => x.lines.length >= 2) ? null : '没有可重排的场景'),
    entries: {
      script: [variant('reorderLines', (g0) => {
        const grp = mid(K.scriptView(g0).groups.filter((x) => x.lines.length >= 2));
        return [(g, o) => {
          const ids = grp.lines.map((l) => l.id).reverse();
          const tx = script.reorderLines(g, grp.id, ids, o);
          // 手工推导：新的全局行序；某镜头的行相对顺序变了，它的整条链和合成过期
          const cur = O.linesInOrder(g);
          const first = cur.indexOf(grp.lines[0].id);
          const next = [...cur.slice(0, first), ...ids, ...cur.slice(first + ids.length)];
          const changed = O.shotsInOrder(g).filter((s) => {
            const ls = O.linesOf(g, s);
            const before = ls.join();
            const after = [...ls].sort((x, y) => next.indexOf(x) - next.indexOf(y)).join();
            return before !== after;
          });
          return { tx, invalidated: chainsPlusCompose(g, changed), writes: W(`^groups\\.${esc(grp.id)}\\.children$`) };
        }];
      })],
    },
  },
  {
    id: 'delete_line', title: '删除一行台词', applicable: needLine, equivalence: 'graph',
    entries: ['script', 'canvas'].reduce((acc, view) => {
      acc[view] = [variant(view === 'script' ? 'deleteLine' : 'deleteNode', (g0) => {
        const T = mid(spokenAttached(g0));
        return [(g, o) => ({
          tx: view === 'script' ? script.deleteLine(g, T.id, o) : canvas.deleteNode(g, T.id, o),
          invalidated: chainsPlusCompose(g, O.shotsOfLine(g, T.id)),
          check: (b, a) => { assert.ok(!allLines(a).some((l) => l.id === T.id)); assert.ok(!K.canvasView(a).nodes.some((n) => n.id === T.id)); assert.ok(flatShots(a).every((s) => !s.line_ids.includes(T.id))); },
        })];
      })];
      return acc;
    }, {}),
  },
  {
    id: 'insert_line', title: '在场景里新增一行并挂到镜头', applicable: (g) => (shotGroups(g).length ? null : '没有含镜头的场景'), equivalence: 'graph-no-layout',
    entries: {
      script: [variant('insertLine', (g0) => {
        const grp = shotGroups(g0)[0];
        return [(g, o) => ({
          tx: script.insertLine(g, { group: grp.id, kind: 'narration', text: '新插入的一句旁白。', shot_ids: [grp.shots[0].id] }, o),
          invalidated: chainsPlusCompose(g, [grp.shots[0].id]),
        })];
      })],
      canvas: [variant('addNodeAt+connectNodes', (g0) => {
        const grp = shotGroups(g0)[0];
        return [
          (g, o) => ({ tx: canvas.addNodeAt(g, 'script_line', { x: 40, y: 60, group: grp.id, params: { kind: 'narration', text: '新插入的一句旁白。' } }, o), invalidated: [] }),
          (g, o) => {
            const id = K.canvasView(g).nodes.find((n) => n.type === 'script_line' && n.params.text === '新插入的一句旁白。').id;
            return { tx: canvas.connectNodes(g, id, grp.shots[0].id, { port: 'lines' }, o), invalidated: chainsPlusCompose(g, [grp.shots[0].id]) };
          },
        ];
      })],
    },
  },

  // ----- 分镜 -----
  {
    id: 'split_shot', title: '拆分镜头', applicable: needShots(1),
    entries: {
      shot: [variant('splitShot', (g0) => {
        const S0 = mid(flatShots(g0));
        return [(g, o) => {
          const at = Math.floor(S0.line_ids.length / 2);
          const moved = S0.line_ids.length - at;
          const tx = shot.splitShot(g, S0.id, at, o);
          const oldChain = O.chainIds(g, S0.id);
          const nu = [tx.meta.image, tx.meta.video, tx.meta.narration];
          return {
            tx,
            // 手工推导：只有“被挪走行”时原镜头的链才变；合成因输入/片段变化必过期；新镜头的三个节点没有采用版本
            invalidated: moved > 0 ? sortedUniq([...oldChain, composeId(g)]) : [composeId(g)],
            stale: sortedUniq([...nu, ...(moved > 0 ? oldChain : []), composeId(g)]),
            check: (b, a) => {
              const order = O.shotsInOrder(a);
              assert.equal(order.length, O.shotsInOrder(b).length + 1);
              assert.equal(order[order.indexOf(S0.id) + 1], tx.meta.shot_id, 'new shot directly after the original');
              const row = flatShots(a).find((s) => s.id === tx.meta.shot_id);
              assert.deepEqual([row.image, row.video, row.narration], ['none', 'none', 'none']);
              assert.deepEqual(row.line_ids.length, moved);
              assert.equal(row.segment_count, 1);
              assert.equal(K.canvasView(a).nodes.filter((n) => n.type === 'shot').length, order.length);
            },
          };
        }];
      })],
    },
  },
  {
    id: 'merge_shots', title: '合并两个相邻镜头', applicable: needShots(2),
    entries: {
      shot: [variant('mergeShots', (g0) => {
        const shots = flatShots(g0);
        const k = Math.min(Math.floor((shots.length - 1) / 2), shots.length - 2);
        const [a, b] = [shots[k], shots[k + 1]];
        return [(g, o) => ({
          tx: shot.mergeShots(g, a.id, b.id, o),
          // a 的时长变了（两者之和），它的 image/video 过期；配音只看行：行被并入时才过期；合成过期
          invalidated: sortedUniq([O.chain(g, a.id).image, O.chain(g, a.id).video, ...(O.linesOf(g, b.id).some((l) => !O.linesOf(g, a.id).includes(l)) ? [O.chain(g, a.id).narration] : []), composeId(g)].filter(Boolean)),
          check: (bf, af) => {
            assert.ok(!K.canvasView(af).nodes.some((n) => n.id === b.id));
            const row = flatShots(af).find((s) => s.id === a.id);
            assert.equal(row.planned_ms, a.planned_ms + b.planned_ms);
            assert.deepEqual(row.line_ids, sortedUniq([...a.line_ids, ...b.line_ids]).sort((x, y) => O.linesInOrder(af).indexOf(x) - O.linesInOrder(af).indexOf(y)));
            assert.equal(row.segment_count, 1);
          },
        })];
      })],
    },
  },
  {
    id: 'reorder_shots_swap', title: '交换同场景相邻两个镜头（分镜重排 = 移动到组 = 时间线跨镜头边界移动）', applicable: (g) => (swapTarget(g) ? null : '没有含 2 个镜头的场景'), equivalence: 'graph',
    entries: (() => {
      const expect = (g, T) => ({
        // 手工推导：只有顺序变了：合成过期，所有镜头的链（含它们的 key）不动
        invalidated: [composeId(g)], writes: W(`^groups\\.${esc(T.gid)}\\.children$`),
        check: (b, a) => {
          const order = O.shotsInOrder(a);
          const [x, y] = T.ids;
          assert.deepEqual(order.slice(O.shotsInOrder(b).indexOf(x), O.shotsInOrder(b).indexOf(x) + 2), [y, x]);
          assert.deepEqual(flatShots(a).map((s) => s.id), order);
          assert.deepEqual(K.canvasView(a).groups.find((gg) => gg.id === T.gid).children.filter((c) => a.nodes[c].type === 'shot'), a.groups[T.gid].children.filter((c) => a.nodes[c].type === 'shot'));
          const runs = clipRuns(a).map((r) => r.shot);
          assert.deepEqual(runs, order, 'timeline order follows');
        },
      });
      return {
        shot: [
          variant('reorderShots', (g0) => { const T = swapTarget(g0); return [(g, o) => ({ tx: shot.reorderShots(g, T.gid, [T.ids[1], T.ids[0], ...T.ids.slice(2)], o), ...expect(g, T) })]; }),
          variant('moveShotToGroup', (g0) => { const T = swapTarget(g0); return [(g, o) => ({ tx: shot.moveShotToGroup(g, T.ids[0], T.gid, 1, o), ...expect(g, T) })]; }),
        ],
        timeline: [variant('moveSegment(cross-boundary)', (g0) => {
          const T = swapTarget(g0);
          return [(g, o) => {
            const runs = clipRuns(g);
            const ix = O.shotsInOrder(g).indexOf(T.ids[0]);
            const x = runs[ix].clips[0];
            const y = runs[ix + 1].clips[runs[ix + 1].clips.length - 1];
            return { tx: timeline.moveSegment(g, x.id, { after_segment_id: y.id }, o), ...expect(g, T) };
          }];
        })],
      };
    })(),
  },
  ...[true, false].map((neutral) => ({
    id: neutral ? 'move_shot_across_scenes_neutral' : 'move_shot_across_scenes', title: neutral ? '跨场景移动镜头（全局顺序不变：A 的末尾镜头 -> B 的开头）' : '跨场景移动镜头（全局顺序改变：A 的首个镜头 -> B 的末尾）',
    applicable: (g) => (crossTarget(g, neutral) ? null : '需要两个含镜头的场景'), equivalence: 'graph',
    entries: (() => {
      const expect = (g, T) => {
        const newOrder = shotOrderAfterMove(g, T.x, T.B.id, !neutral);
        const orderChanged = newOrder.join() !== O.shotsInOrder(g).join();
        return {
          // 手工推导：合成只在全局先后顺序变化时过期；场景归属变化本身不影响任何生成节点
          invalidated: orderChanged ? [composeId(g)] : [],
          writes: W(`^groups\\.(${esc(T.A.id)}|${esc(T.B.id)})\\.children$`),
          check: (b, a) => {
            assert.equal(O.shotsInOrder(a).join(), newOrder.join());
            assert.ok(a.groups[T.B.id].children.includes(T.x) && !a.groups[T.A.id].children.includes(T.x));
            assert.equal(K.canvasView(a).nodes.find((n) => n.id === T.x).group, T.B.id);
            assert.equal(K.toLegacyRows(a).storyboards.find((r) => r.shot_id === T.x).scene_group_id, T.B.id);
            assert.deepEqual(clipRuns(a).map((r) => r.shot), newOrder);
          },
        };
      };
      return {
        shot: [variant('moveShotToGroup', (g0) => { const T = crossTarget(g0, neutral); return [(g, o) => ({ tx: shot.moveShotToGroup(g, T.x, T.B.id, neutral ? 0 : 999, o), ...expect(g, T) })]; })],
        timeline: [variant('moveSegment(cross-scene)', (g0) => {
          const T = crossTarget(g0, neutral);
          return [(g, o) => {
            const runs = clipRuns(g);
            const segOf = (sid) => runs.find((r) => r.shot === sid).clips;
            const tx = neutral
              ? timeline.moveSegment(g, segOf(T.x)[0].id, { before_segment_id: segOf(T.B.shots[0].id)[0].id }, o)
              : timeline.moveSegment(g, segOf(T.x)[0].id, { after_segment_id: segOf(T.B.shots[T.B.shots.length - 1].id).slice(-1)[0].id }, o);
            return { tx, ...expect(g, T) };
          }];
        })],
      };
    })(),
  })),
  {
    id: 'delete_shot', title: '删除一个镜头（分镜删除 = 画布删节点 = 时间线删最后一个片段）', applicable: needShots(1), equivalence: 'graph',
    entries: (() => {
      const expect = (g, T) => ({
        invalidated: [composeId(g)], stale: [composeId(g)], // 手工推导：合成的输入与片段变了；其余镜头不受影响
        check: (b, a) => {
          assert.ok(!flatShots(a).some((s) => s.id === T.id));
          assert.ok(!K.canvasView(a).nodes.some((n) => n.id === T.id));
          assert.ok(!K.timelineView(a).tracks.flatMap((t) => t.clips).some((c) => c.storyboard_id !== null && c.storyboard_id === g.nodes[T.id]?.legacy_id));
          assert.ok(allLines(a).length === allLines(b).length, 'script lines stay');
          assert.ok(allLines(a).every((l) => !l.shot_ids.includes(T.id)));
        },
      });
      const mk = (name, f) => variant(name, (g0) => { const T = mid(flatShots(g0)); return [(g, o) => ({ tx: f(g, o, T), ...expect(g, T) })]; });
      return {
        shot: [mk('deleteShot', (g, o, T) => shot.deleteShot(g, T.id, o))],
        timeline: [
          mk('deleteSegment(last)', (g, o, T) => timeline.deleteSegment(g, clipRuns(g).find((r) => r.shot === T.id).clips[0].id, o)),
          // 先切成两段再逐段删：删到最后一个片段时整个镜头消失，终态与直接删镜头相同
          variant('splitSegment+deleteSegment×2', (g0) => {
            const T = mid(flatShots(g0));
            let second;
            return [
              (g, o) => { const seg = clipRuns(g).find((r) => r.shot === T.id).clips[0]; const s0 = composeParam(g, 'segments').find((x) => x.id === seg.id); const tx = timeline.splitSegment(g, s0.id, s0.in_ms + 1, o); second = tx.meta.segment_id; return { tx, invalidated: [composeId(g)] }; },
              (g, o) => ({ tx: timeline.deleteSegment(g, second, o), check: (b, a) => assert.ok(O.shotsInOrder(a).includes(T.id)) }),
              (g, o) => ({ tx: timeline.deleteSegment(g, clipRuns(g).find((r) => r.shot === T.id).clips[0].id, o), ...expect(g, T), invalidated: [] }), // 合成在第一步就已过期
            ];
          }),
        ],
        canvas: [mk('deleteNode(shot)', (g, o, T) => canvas.deleteNode(g, T.id, o))],
      };
    })(),
  },
  {
    id: 'add_shot', title: '新增镜头（分镜新增 = 画布新建节点）', applicable: (g) => (K.shotView(g).groups.length ? null : '没有场景'), equivalence: 'graph-no-layout',
    entries: (() => {
      const check = (g, T) => (b, a, r) => {
        const nu = O.shotsInOrder(a).find((s) => !O.shotsInOrder(b).includes(s));
        const ch = O.chainIds(a, nu);
        assert.equal(ch.length, 3, 'new shot got image/video/narration');
        assert.deepEqual(K.staleSet(a), sortedUniq([...K.staleSet(b), ...ch, composeId(a)]), 'stale = new nodes + compose');
        const row = flatShots(a).find((s) => s.id === nu);
        assert.equal(row.segment_count, 1);
        assert.equal(row.planned_ms, 3000);
        assert.equal(O.shotsInOrder(a).length, O.shotsInOrder(b).length + 1);
      };
      const gidOf = (g) => K.shotView(g).groups[K.shotView(g).groups.length - 1].id;
      return {
        shot: [variant('addShot', () => [(g, o) => ({ tx: shot.addShot(g, { group: gidOf(g), params: { title: '新增镜头', duration_ms: 3000 } }, o), invalidated: [composeId(g)], check: check(g) })])],
        canvas: [variant('addNodeAt(shot)', () => [(g, o) => ({ tx: canvas.addNodeAt(g, 'shot', { x: 10, y: 20, group: gidOf(g), params: { title: '新增镜头', duration_ms: 3000 } }, o), invalidated: [composeId(g)], check: check(g) })])],
      };
    })(),
  },
  {
    id: 'set_shot_title', title: '改镜头字段（标题/画面提示词）', applicable: needShots(1), equivalence: 'graph',
    entries: (() => {
      const expect = (g, T) => ({
        // 手工推导（K1 备注）：配音只看行，不看画面参数，所以 narration 不过期；image、video、合成过期
        invalidated: sortedUniq([O.chain(g, T.id).image, O.chain(g, T.id).video, composeId(g)]),
        writes: W(`^nodes\\.${esc(T.id)}\\.params\\.(title|image_prompt)$`),
        check: (b, a) => {
          assert.equal(K.shotView(a).groups.flatMap((x) => x.shots).find((s) => s.id === T.id).params.title, '新标题');
          assert.equal(K.canvasView(a).nodes.find((n) => n.id === T.id).params.title, '新标题');
          assert.equal(K.toLegacyRows(a).storyboards.find((r) => r.shot_id === T.id).title, '新标题');
          const nar = O.chain(a, T.id).narration;
          assert.equal(K.nodeState(a, nar), 'fresh', 'narration stays fresh');
        },
      });
      return {
        shot: [variant('setShotField', (g0) => { const T = mid(flatShots(g0)); return [(g, o) => ({ tx: shot.setShotField(g, T.id, { title: '新标题', image_prompt: '新的首帧提示词' }, o), ...expect(g, T) })]; })],
        canvas: [variant('setParam', (g0) => { const T = mid(flatShots(g0)); return [(g, o) => ({ tx: canvasEdit(o, [[T.id, 'title', '新标题'], [T.id, 'image_prompt', '新的首帧提示词']]), ...expect(g, T) })]; })],
      };
    })(),
  },
  {
    id: 'set_shot_duration', title: '改镜头时长（片段跟随；被裁过的片段裁进新时长）', applicable: needShots(1),
    entries: {
      shot: [
        variant('grow-then-shrink', (g0) => {
          const T = mid(flatShots(g0));
          return [
            (g, o) => ({
              tx: shot.setShotField(g, T.id, { duration_ms: T.planned_ms + 1000 }, o),
              invalidated: sortedUniq([O.chain(g, T.id).image, O.chain(g, T.id).video, composeId(g)]),
              check: (b, a) => assert.equal(K.timelineView(a).duration_ms, K.timelineView(b).duration_ms + 1000, 'untrimmed segment follows the longer shot'),
            }),
            (g, o) => ({
              tx: shot.setShotField(g, T.id, { duration_ms: Math.max(1, Math.floor(T.planned_ms / 2)) }, o),
              invalidated: [], // 已经过期，不再算新失效
              check: (b, a) => { const s = a.nodes[composeId(a)].params.segments.filter((x) => x.shot_id === T.id); assert.ok(s.every((x) => x.out_ms <= Math.max(1, Math.floor(T.planned_ms / 2)))); },
            }),
          ];
        }),
        variant('shrink-with-split-segments', (g0) => {
          const T = mid(flatShots(g0));
          const d = T.planned_ms;
          return [
            (g, o) => { const seg = clipRuns(g).find((r) => r.shot === T.id).clips[0]; return { tx: timeline.splitSegment(g, seg.id, Math.max(1, Math.floor(d * 0.75)), o), invalidated: [composeId(g)] }; },
            (g, o) => ({
              tx: shot.setShotField(g, T.id, { duration_ms: Math.max(2, Math.floor(d / 2)) }, o),
              check: (b, a) => { for (const s of a.nodes[composeId(a)].params.segments.filter((x) => x.shot_id === T.id)) assert.ok(s.in_ms < s.out_ms && s.out_ms <= Math.max(2, Math.floor(d / 2))); },
            }),
          ];
        }),
        variant('shrink-under-trimmed-segment', (g0) => {
          const T = mid(flatShots(g0));
          const d = T.planned_ms;
          return [
            (g, o) => { const seg = clipRuns(g).find((r) => r.shot === T.id).clips[0]; return { tx: timeline.trimSegment(g, seg.id, { in_ms: Math.floor(d / 4), out_ms: d - 100 }, o), invalidated: [composeId(g)] }; },
            (g, o) => ({
              tx: shot.setShotField(g, T.id, { duration_ms: Math.floor(d / 2) }, o),
              check: (b, a) => { const s = a.nodes[composeId(a)].params.segments.find((x) => x.shot_id === T.id); assert.ok(s.in_ms < s.out_ms && s.out_ms <= Math.floor(d / 2)); },
            }),
          ];
        }),
      ],
    },
  },
  {
    id: 'regenerate_shot', title: '单镜头重新生成（只有该镜头的 image/video 链 + 合成过期，旧版本保留）', applicable: needShots(1), equivalence: 'graph',
    entries: (() => {
      const mk = (name, f) => variant(name, (g0) => {
        const T = mid(flatShots(g0));
        return [
          (g, o) => {
            const c = O.chain(g, T.id);
            const keys0 = K.cacheKeys(g);
            return {
              tx: f(g, o, T, c),
              // 手工推导：换种子只动 image 和 video 参数；narration 的输入是行，不受影响；合成通过 video 过期
              invalidated: sortedUniq([c.image, c.video, composeId(g)]),
              stale: sortedUniq([c.image, c.video, composeId(g)]),
              writes: W(`^nodes\\.(${esc(c.image)}|${esc(c.video)})\\.params\\.seed$`),
              check: (b, a) => {
                const keys1 = K.cacheKeys(a);
                for (const id of Object.keys(a.nodes)) if (![c.image, c.video, composeId(g)].includes(id)) assert.equal(keys1[id], keys0[id], `unrelated node ${id} key unchanged`);
                for (const id of [c.image, c.video]) { assert.equal(a.versions[id].length, 1, 'old version kept'); assert.equal(a.adopted[id], 'v_1'); }
                for (const s of flatShots(a)) if (s.id !== T.id) assert.deepEqual([s.image, s.video, s.narration], ['fresh', 'fresh', 'fresh']);
              },
            };
          },
          (g, o) => { const c = O.chain(g, T.id); return { tx: S.generateTx(g, [c.image, c.video, composeId(g)], o), revalidated: sortedUniq([c.image, c.video, composeId(g)]), stale: [], check: (b, a) => { for (const x of O.shotsInOrder(a)) assert.equal(K.sceneKey(a, x) === K.sceneKey(b, x), x !== T.id, 'adopting the new video changes only that shot scene key'); for (const id of [c.image, c.video]) { assert.equal(a.versions[id].length, 2); assert.equal(a.versions[id][0].id, 'v_1'); assert.equal(a.adopted[id], 'v_2'); } } }; },
        ];
      });
      return {
        shot: [mk('regenerateShot', (g, o, T) => shot.regenerateShot(g, T.id, { seed: 777 }, o))],
        canvas: [mk('setParam(seed)', (g, o, T, c) => canvasEdit(o, [[c.image, 'seed', 777], [c.video, 'seed', 777]]))],
      };
    })(),
  },
  {
    id: 'regenerate_video_only', title: '只重新生成视频（图片保持新鲜）', applicable: needShots(1), equivalence: 'graph',
    entries: (() => {
      const mk = (name, f) => variant(name, (g0) => {
        const T = flatShots(g0)[0];
        return [(g, o) => { const c = O.chain(g, T.id); return { tx: f(g, o, T, c), invalidated: sortedUniq([c.video, composeId(g)]), stale: sortedUniq([c.video, composeId(g)]) }; }];
      });
      return {
        shot: [mk('regenerateShot(video)', (g, o, T) => shot.regenerateShot(g, T.id, { seed: 31, targets: ['video'] }, o))],
        canvas: [mk('setParam(seed)', (g, o, T, c) => canvasEdit(o, [[c.video, 'seed', 31]]))],
      };
    })(),
  },
  {
    id: 'change_voice', title: '换音色（只有该镜头的配音 + 合成过期）', applicable: needShots(1), equivalence: 'graph',
    entries: (() => {
      const mk = (name, f) => variant(name, (g0) => {
        const T = mid(flatShots(g0));
        return [(g, o) => {
          const c = O.chain(g, T.id);
          return {
            tx: f(g, o, T, c),
            invalidated: sortedUniq([c.narration, composeId(g)]), stale: sortedUniq([c.narration, composeId(g)]),
            writes: W(`^nodes\\.${esc(c.narration)}\\.params\\.voice$`),
            check: (b, a) => { const row = flatShots(a).find((s) => s.id === T.id); assert.deepEqual([row.image, row.video, row.narration], ['fresh', 'fresh', 'stale']); assert.equal(a.nodes[c.narration].params.voice, '温柔女声'); },
          };
        }];
      });
      return {
        shot: [mk('setVoice', (g, o, T) => shot.setVoice(g, T.id, { voice: '温柔女声' }, o))],
        canvas: [mk('setParam(voice)', (g, o, T, c) => canvasEdit(o, [[c.narration, 'voice', '温柔女声']]))],
      };
    })(),
  },

  // ----- 时间线 -----
  {
    id: 'timeline_trim', title: '时间线裁剪片段', applicable: needShots(1),
    entries: { timeline: [variant('trimSegment', (g0) => {
      const T = mid(clipRuns(g0));
      return [(g, o) => {
        const seg = clipRuns(g).find((r) => r.shot === T.shot).clips[0];
        const s = composeParam(g, 'segments').find((x) => x.id === seg.id);
        const d = Math.max(1, Math.floor((s.out_ms - s.in_ms) / 10));
        const keysBefore = Object.fromEntries(O.shotsInOrder(g).map((x) => [x, K.sceneKey(g, x)]));
        return {
          tx: timeline.trimSegment(g, s.id, { in_ms: s.in_ms + d, out_ms: s.out_ms - d }, o),
          invalidated: [composeId(g)], stale: [composeId(g)], writes: composeW(g, 'segments'),
          check: (b, a) => {
            assert.equal(K.timelineView(a).duration_ms, K.timelineView(b).duration_ms - 2 * d);
            for (const x of O.shotsInOrder(a)) assert.equal(K.sceneKey(a, x) === keysBefore[x], x !== T.shot, 'only the trimmed shot gets a new scene key');
            assert.equal(flatShots(a).find((r) => r.id === T.shot).used_ms, s.out_ms - s.in_ms - 2 * d);
          },
        };
      }];
    })] },
  },
  {
    id: 'timeline_split_segment', title: '时间线切分片段 / 删除其中一半', applicable: needShots(1),
    entries: { timeline: [variant('splitSegment+deleteSegment', (g0) => {
      const T = mid(clipRuns(g0));
      let newSeg;
      return [
        (g, o) => {
          const seg = clipRuns(g).find((r) => r.shot === T.shot).clips[0];
          const s = composeParam(g, 'segments').find((x) => x.id === seg.id);
          const at = s.in_ms + Math.floor((s.out_ms - s.in_ms) / 2);
          const tx = timeline.splitSegment(g, s.id, at, o);
          newSeg = tx.meta.segment_id;
          return {
            tx, invalidated: [composeId(g)], writes: composeW(g, 'segments'),
            check: (b, a) => {
              const row = flatShots(a).find((r) => r.id === T.shot);
              assert.equal(row.segment_count, 2);
              assert.equal(row.used_ms, flatShots(b).find((r) => r.id === T.shot).used_ms, 'splitting keeps the used duration');
              assert.equal(K.timelineView(a).duration_ms, K.timelineView(b).duration_ms, 'splitting keeps the total duration');
              const mine = clipRuns(a).find((r) => r.shot === T.shot).clips;
              assert.equal(mine[1].start_ms, mine[0].start_ms + mine[0].duration_ms, 'halves are adjacent');
            },
          };
        },
        (g, o) => ({
          tx: timeline.deleteSegment(g, newSeg, o), writes: composeW(g, 'segments'),
          check: (b, a) => { assert.equal(flatShots(a).find((r) => r.id === T.shot).segment_count, 1); assert.ok(O.shotsInOrder(a).includes(T.shot), 'deleting one half keeps the shot'); },
        }),
      ];
    })] },
  },
  {
    id: 'timeline_reorder_within_shot', title: '切分后在同一镜头内交换两个片段', applicable: needShots(1),
    entries: { timeline: [variant('splitSegment+moveSegment', (g0) => {
      const T = mid(clipRuns(g0));
      let secondId;
      return [
        (g, o) => { const seg = clipRuns(g).find((r) => r.shot === T.shot).clips[0]; const s = composeParam(g, 'segments').find((x) => x.id === seg.id); const tx = timeline.splitSegment(g, s.id, s.in_ms + Math.floor((s.out_ms - s.in_ms) / 2), o); secondId = tx.meta.segment_id; return { tx, invalidated: [composeId(g)] }; },
        (g, o) => {
          const first = clipRuns(g).find((r) => r.shot === T.shot).clips[0].id;
          return {
            tx: timeline.moveSegment(g, secondId, { before_segment_id: first }, o), invalidated: [], stale: [composeId(g)], writes: composeW(g, 'segments'),
            check: (b, a) => {
              const mine = clipRuns(a).find((r) => r.shot === T.shot).clips;
              assert.deepEqual(mine.map((c) => c.id), [secondId, first]);
              assert.deepEqual(O.shotsInOrder(a), O.shotsInOrder(b), 'shot order unaffected');
            },
          };
        },
      ];
    })] },
  },
  {
    id: 'timeline_gap', title: '时间线改片段前空隙（gap）', applicable: needShots(2),
    entries: { timeline: [variant('moveSegment(gap)', (g0) => {
      const T = clipRuns(g0)[1];
      return [(g, o) => {
        const seg = clipRuns(g)[1].clips[0];
        const keys0 = Object.fromEntries(O.shotsInOrder(g).map((x) => [x, K.sceneKey(g, x)]));
        return {
          tx: timeline.moveSegment(g, seg.id, { gap_before_ms: 700 }, o),
          invalidated: [composeId(g)], stale: [composeId(g)], writes: composeW(g, 'segments'),
          check: (b, a) => {
            assert.equal(K.timelineView(a).duration_ms, K.timelineView(b).duration_ms + 700);
            const later = clipRuns(a).slice(1).flatMap((r) => r.clips);
            const was = clipRuns(b).slice(1).flatMap((r) => r.clips);
            later.forEach((c, i) => assert.equal(c.start_ms, was[i].start_ms + 700, 'every later clip shifts by the gap'));
            for (const x of O.shotsInOrder(a)) assert.equal(K.sceneKey(a, x), keys0[x], 'gap is not part of the scene key');
          },
        };
      }];
    })] },
  },
  {
    id: 'timeline_transition', title: '设置/清除转场', applicable: needShots(1),
    entries: { timeline: [variant('setTransition', (g0) => {
      const T = mid(clipRuns(g0));
      return [
        (g, o) => {
          const seg = clipRuns(g).find((r) => r.shot === T.shot).clips[0];
          const keys0 = Object.fromEntries(O.shotsInOrder(g).map((x) => [x, K.sceneKey(g, x)]));
          return {
            tx: timeline.setTransition(g, seg.id, 'fade', o), invalidated: [composeId(g)], stale: [composeId(g)], writes: composeW(g, 'segments'),
            check: (b, a) => {
              assert.equal(clipRuns(a).find((r) => r.shot === T.shot).clips[0].style.transition, 'fade');
              for (const x of O.shotsInOrder(a)) assert.equal(K.sceneKey(a, x) === keys0[x], x !== T.shot, 'transition changes only that shot scene key');
            },
          };
        },
        (g, o) => ({ tx: timeline.setTransition(g, clipRuns(g).find((r) => r.shot === T.shot).clips[0].id, null, o), revalidated: [composeId(g)], stale: [], check: (b, a) => assert.equal(clipRuns(a).find((r) => r.shot === T.shot).clips[0].style, null) }),
      ];
    })] },
  },
  {
    id: 'timeline_add_music', title: '加音乐（不影响场景缓存键）', applicable: needShots(1),
    entries: { timeline: [variant('addMusic', () => {
      const keys = {};
      return [
        (g, o) => {
          for (const x of O.shotsInOrder(g)) keys[x] = K.sceneKey(g, x);
          return {
            tx: timeline.addMusic(g, { asset_ref: 'music/bgm.mp3', start_ms: 250, duration_ms: 3000 }, o),
            invalidated: [composeId(g)], stale: [composeId(g)], writes: composeW(g, 'music'),
            check: (b, a) => {
              for (const x of O.shotsInOrder(a)) assert.equal(K.sceneKey(a, x), keys[x], 'music not in scene key');
              const m = K.timelineView(a).tracks.find((t) => t.kind === 'music').clips;
              assert.equal(m.length, 1);
              assert.deepEqual([m[0].start_ms, m[0].duration_ms], [250, 3000]);
              assert.equal(K.timelineView(a).duration_ms, Math.max(K.timelineView(b).duration_ms, 3250));
            },
          };
        },
        (g, o) => ({ tx: timeline.addMusic(g, { asset_ref: 'music/long.mp3', start_ms: 100, duration_ms: 900000 }, o), writes: composeW(g, 'music'), check: (b, a) => assert.equal(K.timelineView(a).duration_ms, 900100, 'music longer than the video extends the total') }),
      ];
    })] },
  },

  // ----- 画布 -----
  {
    id: 'canvas_move_node', title: '画布移动节点（不得改变过期集合 / cacheKey / 其它视图）', applicable: needShots(1),
    entries: { canvas: [
      variant('moveNode', (g0) => { const T = mid(flatShots(g0)); return [(g, o) => ({ tx: canvas.moveNode(g, T.id, { x: 321.5, y: -17 }, o), layoutOnly: true, invalidated: [], writes: W(`^layout\\.${esc(T.id)}$`), check: (b, a) => { const n = K.canvasView(a).nodes.find((x) => x.id === T.id); assert.deepEqual(n.layout, { x: 321.5, y: -17 }); assert.equal(n.layout_auto, false); } })]; }),
      variant('moveNodes(多选)', (g0) => { const ids = O.shotsInOrder(g0).slice(0, 3); return [(g, o) => ({ tx: canvas.moveNodes(g, Object.fromEntries(ids.map((id, i) => [id, { x: i * 10, y: i * 20 }])), o), layoutOnly: true, invalidated: [], writes: W('^layout\\.') })]; }),
      variant('move compose + line + generated', (g0) => [
        (g, o) => ({ tx: canvas.moveNode(g, composeId(g), { x: 1, y: 2 }, o), layoutOnly: true }),
        (g, o) => ({ tx: canvas.moveNode(g, O.linesInOrder(g)[0], { x: 3, y: 4 }, o), layoutOnly: true }),
        (g, o) => ({ tx: canvas.moveNode(g, O.chain(g, O.shotsInOrder(g)[0]).video, { x: 5, y: 6 }, o), layoutOnly: true }),
        (g, o) => ({ tx: canvas.moveNode(g, composeId(g), { x: 1, y: 2 }, o), layoutOnly: true, check: (b, a) => assert.equal(K.toJSON(a), K.toJSON(b), 'moving to the same place is a no-op on the graph') }),
      ]),
    ] },
  },
  {
    id: 'canvas_connect_disconnect', title: '画布连线 / 断线', applicable: all(needShots(1), needLine),
    entries: { canvas: [
      variant('line->shot 断开再连回', (g0) => {
        const T = mid(spokenAttached(g0));
        const S0 = T.shot_ids[0];
        return [
          (g, o) => ({
            tx: canvas.disconnectNodes(g, { from: T.id, to: S0 }, o), invalidated: chainsPlusCompose(g, [S0]), writes: W('^edges\\.', '^edges#order$'),
            check: (b, a) => { assert.ok(!allLines(a).find((l) => l.id === T.id).shot_ids.includes(S0)); assert.ok(!flatShots(a).find((s) => s.id === S0).line_ids.includes(T.id)); },
          }),
          (g, o) => ({
            tx: canvas.connectNodes(g, T.id, S0, { port: 'lines' }, o), revalidated: chainsPlusCompose(g, [S0]), stale: [], writes: W('^edges\\.', '^edges#order$'),
            check: (b, a) => { assert.deepEqual(K.shotView(a), K.shotView(g0), 'shotView returns to the original'); },
          }),
        ];
      }),
      variant('image->video 断开再连回', (g0) => {
        const T = mid(flatShots(g0));
        return [
          (g, o) => { const c = O.chain(g, T.id); return { tx: canvas.disconnectNodes(g, { from: c.image, to: c.video }, o), invalidated: sortedUniq([c.video, composeId(g)]), stale: sortedUniq([c.video, composeId(g)]) }; },
          (g, o) => { const c = O.chain(g, T.id); return { tx: canvas.connectNodes(g, c.image, c.video, { port: 'image' }, o), revalidated: sortedUniq([c.video, composeId(g)]), stale: [] }; },
        ];
      }),
      variant('连线替换单连接端口', (g0) => {
        const T = mid(flatShots(g0));
        let nu;
        return [
          (g, o) => { const tx = canvas.addNodeAt(g, 'image', { x: 500, y: 500 }, o); nu = tx.meta.node_id; return { tx, invalidated: [] }; },
          (g, o) => { const c = O.chain(g, T.id); return { tx: canvas.connectNodes(g, nu, c.video, { port: 'image' }, o), invalidated: sortedUniq([c.video, composeId(g)]), stale: sortedUniq([nu, c.video, composeId(g)]), check: (b, a) => assert.equal(a.edges.filter((e) => e.to.node === c.video && e.to.port === 'image').length, 1, 'single-connection port holds one edge') }; },
        ];
      }),
    ] },
  },
  {
    id: 'canvas_delete_node', title: '画布删除生成节点（image / video / narration）', applicable: needShots(1),
    entries: { canvas: ['image', 'video', 'narration'].map((kind) => variant(`deleteNode(${kind})`, (g0) => {
      const T = mid(flatShots(g0));
      return [(g, o) => {
        const c = O.chain(g, T.id);
        const id = c[kind];
        return {
          tx: canvas.deleteNode(g, id, o),
          // 手工推导：删 image -> video 缺输入，video+合成过期；删 video / narration -> 合成缺输入，只有合成过期
          invalidated: kind === 'image' ? sortedUniq([c.video, composeId(g)]) : [composeId(g)],
          writes: W(`^nodes\\.${esc(id)}\\.`, '^edges\\.', '^edges#order$', `^layout\\.${esc(id)}$`, `^versions\\.${esc(id)}$`, `^adopted\\.${esc(id)}$`),
          check: (b, a) => { assert.equal(flatShots(a).find((s) => s.id === T.id)[kind], 'none'); assert.ok(!K.canvasView(a).nodes.some((n) => n.id === id)); },
        };
      }];
    })) },
  },
  {
    id: 'canvas_rewire', title: '画布重连：删 image、新建 image、接回 shot 和 video', applicable: needShots(1),
    entries: { canvas: [variant('delete+addNodeAt+connect×2', (g0) => {
      const T = mid(flatShots(g0));
      let nu;
      return [
        (g, o) => { const c = O.chain(g, T.id); return { tx: canvas.deleteNode(g, c.image, o), invalidated: sortedUniq([c.video, composeId(g)]) }; },
        (g, o) => { const tx = canvas.addNodeAt(g, 'image', { x: 60, y: 60 }, o); nu = tx.meta.node_id; return { tx, invalidated: [] }; },
        (g, o) => ({ tx: canvas.connectNodes(g, T.id, nu, { port: 'shot' }, o), invalidated: [] }),
        (g, o) => { const c = O.chain(g, T.id); // 手工推导（内容寻址）：新 image 与旧 image 同类型、同参数、同输入，key 相同，所以 video/合成重新“新鲜”；
        // 只有新 image 自己没有采用版本（从未生成过）仍是过期
        return { tx: canvas.connectNodes(g, nu, c.video, { port: 'image' }, o), invalidated: [], revalidated: sortedUniq([c.video, composeId(g)]), stale: [nu], check: (b, a) => assert.equal(flatShots(a).find((s) => s.id === T.id).image, 'none', 'new image has never been generated') }; },
        (g, o) => ({ tx: S.generateTx(g, [nu], o), revalidated: [nu], stale: [] }),
      ];
    })] },
  },

  {
    id: 'adopt_old_version', title: '采用旧版本（版本回退）：版本不被覆盖，采用旧版本后按 key 判断新鲜', applicable: needShots(1),
    entries: { shot: [variant('regenerate+generate+adoptVersion', (g0) => {
      const T = mid(flatShots(g0));
      return [
        (g, o) => ({ tx: shot.regenerateShot(g, T.id, { seed: 9, targets: ['image'] }, o) }),
        (g, o) => { const c = O.chain(g, T.id); return { tx: S.generateTx(g, [c.image, c.video, composeId(g)], o), stale: [] }; },
        // 手工推导：回退到旧版本（v_1 是 seed=0 时的产物），image 的当前 key 与之不符 -> 只有 image 变过期；下游只看上游 key，不看采用，所以 video / 合成不动
        (g, o) => { const c = O.chain(g, T.id); return { tx: { tx_id: o.tx_id, label: 'adoptVersion', ops: [{ op: 'adoptVersion', node: c.image, version_id: 'v_1' }] }, invalidated: [c.image], stale: [c.image], writes: W(`^adopted\\.${esc(c.image)}$`), check: (b, a) => assert.equal(a.versions[c.image].length, 2, 'both versions retained') }; },
        (g, o) => { const c = O.chain(g, T.id); return { tx: { tx_id: o.tx_id, label: 'adoptVersion', ops: [{ op: 'adoptVersion', node: c.image, version_id: 'v_2' }] }, revalidated: [c.image], stale: [] }; },
      ];
    })] },
  },
  {
    id: 'reorder_after_split', title: '先切分片段，再跨镜头边界重排（时间线）或改镜头顺序（分镜）：多片段镜头整体移动', applicable: (g) => (swapTarget(g) ? null : '没有含 2 个镜头的场景'), equivalence: 'graph',
    entries: (() => {
      const splitStep = (g0) => { const T = swapTarget(g0); return (g, o) => { const seg = clipRuns(g).find((r) => r.shot === T.ids[0]).clips[0]; const s0 = composeParam(g, 'segments').find((x) => x.id === seg.id); return { tx: timeline.splitSegment(g, s0.id, s0.in_ms + 1, o), invalidated: [composeId(g)] }; }; };
      const expect = (g, T) => ({ invalidated: [], stale: [composeId(g)], check: (b, a) => { const runs = clipRuns(a); const ix = runs.findIndex((r) => r.shot === T.ids[0]); assert.equal(runs[ix].clips.length, 2, 'both halves moved with their shot'); assert.equal(runs[ix - 1].shot, T.ids[1]); } });
      return {
        shot: [variant('splitSegment(timeline)+reorderShots', (g0) => { const T = swapTarget(g0); return [splitStep(g0), (g, o) => ({ tx: shot.reorderShots(g, T.gid, [T.ids[1], T.ids[0], ...T.ids.slice(2)], o), ...expect(g, T) })]; })],
        timeline: [variant('splitSegment+moveSegment(cross-boundary)', (g0) => {
          const T = swapTarget(g0);
          return [splitStep(g0), (g, o) => {
            const runs = clipRuns(g);
            const ix = runs.findIndex((r) => r.shot === T.ids[0]);
            return { tx: timeline.moveSegment(g, runs[ix].clips[1].id, { after_segment_id: runs[ix + 1].clips.slice(-1)[0].id }, o), ...expect(g, T) };
          }];
        })],
      };
    })(),
  },
  {
    id: 'compose_created_late', title: '项目还没有合成节点时先编辑，再从画布新建 compose（片段补齐、接线补齐）',
    initial: (story) => S.preparedNoCompose(story), applicable: needShots(1),
    entries: (() => {
      const addCompose = (g, o) => {
        const tx = canvas.addNodeAt(g, 'compose', { x: 900, y: 10 }, o);
        const n = O.shotsInOrder(g).length;
        return {
          tx, invalidated: [], // 新节点不计入
          check: (b, a) => {
            const cid = composeId(a);
            assert.ok(cid);
            assert.equal(a.nodes[cid].params.segments.length, n, 'one default segment per shot');
            assert.equal(K.nodeState(a, cid), 'none', 'a new compose has never been rendered');
            assert.deepEqual(K.staleSet(a), sortedUniq([cid, ...K.staleSet(b)]), 'only the new compose is added to the stale set');
            assert.equal(K.timelineView(a).duration_ms, O.shotsInOrder(a).reduce((acc, s) => acc + a.nodes[s].params.duration_ms, 0));
            assert.equal(a.edges.filter((e) => e.to.node === cid).length, K.nodesOfType(a, 'video').length + K.nodesOfType(a, 'narration').length, 'every video/narration wired');
          },
        };
      };
      const trim = (g, o) => { const seg = composeParam(g, 'segments')[0]; return { tx: timeline.trimSegment(g, seg.id, { in_ms: 1 }, o), invalidated: [] }; };
      return {
        script: [variant('rewriteLine -> addNodeAt(compose)', () => [(g, o) => { const L = mid(spokenAttached(g)); return { tx: script.rewriteLine(g, L.id, { text: '先改词' }, o), invalidated: O.shotsOfLine(g, L.id).flatMap((s) => O.chainIds(g, s)).sort() }; }, addCompose, trim])],
        shot: [variant('addShot -> addNodeAt(compose)', () => [(g, o) => ({ tx: shot.addShot(g, { group: K.shotView(g).groups[0].id, params: { title: '先加镜头', duration_ms: 2000 } }, o), invalidated: [] }), (g, o) => { const r = addCompose(g, o); return r; }, trim])],
        canvas: [variant('deleteNode(narration) -> addNodeAt(compose)', () => [(g, o) => ({ tx: canvas.deleteNode(g, O.chain(g, O.shotsInOrder(g)[0]).narration, o), invalidated: [] }), addCompose, trim])],
        timeline: [variant('addNodeAt(compose) -> trim/split/music', () => [addCompose, trim, (g, o) => ({ tx: timeline.addMusic(g, { asset_ref: 'm.mp3', start_ms: 0, duration_ms: 1000 }, o) })])],
      };
    })(),
  },
  // ----- 会话 -----
  {
    id: 'mixed_session_undo_redo', title: '四种视图混合编辑的会话 + 批量撤销/重做（分四种起手视图）', applicable: sessionApplicable,
    entries: { script: [mixedSession('script')], shot: [mixedSession('shot')], timeline: [mixedSession('timeline')], canvas: [mixedSession('canvas')] },
  },
  {
    id: 'crash_reload_mid_session', title: '会话中途崩溃重载（快照 + 日志重放）后继续编辑（分四种起手视图）', applicable: sessionApplicable,
    entries: { script: [crashSession('script')], shot: [crashSession('shot')], timeline: [crashSession('timeline')], canvas: [crashSession('canvas')] },
  },
];

module.exports = { SCENARIOS, STEP, helpers: { flatShots, allLines, clipRuns, spokenAttached, canvasEdit, mid, sortedUniq, composeId } };
