'use strict';
// 随机会话：四种视图的随机意图 + 随机撤销/重做/崩溃重载，全程用同一套 harness（每步 I1–I8 + 独立预言机 + 崩溃重放矩阵）。
// 种子固定，失败可复现（消息里带 故事/种子/步号）。
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../../src');
const O = require('./oracle');
const S = require('./stories');
const H = require('./harness');
const { prng } = require('../helpers');

const { script, shot, timeline, canvas } = K.intents;
const WORDS = ['雨', '夜', '你好', '再见', '走吧', '等等', '天亮了', '。', '，', '？'];
const STEPS = 18;

/** 随机挑一个当前图上可行的意图；不可行（INTENT 错误）就换一个。 */
function randomTx(g, r, o) {
  const lines = O.linesInOrder(g);
  const shots = O.shotsInOrder(g);
  const cid = O.composeNode(g);
  const segs = cid ? g.nodes[cid].params.segments : [];
  const nodes = Object.keys(g.nodes);
  const groups = g.group_order;
  const stale = K.staleSet(g);
  const gens = [
    ['rewriteLine', 3, () => lines.length && script.rewriteLine(g, r.pick(lines), { text: r.pick(WORDS) + r.pick(WORDS) }, o)],
    ['insertLine', 2, () => groups.length && script.insertLine(g, { group: r.pick(groups), index: r.int(6), kind: r.pick(K.LINE_KINDS), speaker: 's', text: r.pick(WORDS), shot_ids: shots.length ? r.shuffle(shots).slice(0, r.int(3)) : [] }, o)],
    ['deleteLine', 1, () => lines.length > 3 && script.deleteLine(g, r.pick(lines), o)],
    ['splitLine', 1, () => { const c = lines.filter((l) => g.nodes[l].params.text.length >= 2); if (!c.length) return null; const id = r.pick(c); return script.splitLine(g, id, 1 + r.int(g.nodes[id].params.text.length - 1), o); }],
    ['mergeLines', 1, () => { if (!lines.length) return null; const id = r.pick(lines); const gl = g.groups[K.groupOf(g, id)].children.filter((c) => g.nodes[c].type === 'script_line'); const nx = gl[gl.indexOf(id) + 1]; return nx ? script.mergeLines(g, id, nx, { sep: r.pick(['', ' ']) }, o) : null; }],
    ['reorderLines', 1, () => { if (!groups.length) return null; const gid = r.pick(groups); return script.reorderLines(g, gid, r.shuffle(g.groups[gid].children.filter((c) => g.nodes[c].type === 'script_line')), o); }],
    ['setShotField', 3, () => shots.length && shot.setShotField(g, r.pick(shots), r.pick([{ title: r.pick(WORDS) }, { image_prompt: r.pick(WORDS) }, { duration_ms: 500 + r.int(8000) }, { characters: [r.pick(WORDS)] }]), o)],
    ['addShot', 2, () => groups.length && shot.addShot(g, { group: r.pick(groups), index: r.int(5), params: { title: 'n', duration_ms: 500 + r.int(5000) }, lines: lines.length ? r.shuffle(lines).slice(0, r.int(3)) : [] }, o)],
    ['deleteShot', 1, () => shots.length > 2 && shot.deleteShot(g, r.pick(shots), o)],
    ['splitShot', 1, () => { if (!shots.length) return null; const id = r.pick(shots); return shot.splitShot(g, id, r.int(K.linesOfShot(g, id).length + 1), o); }],
    ['mergeShots', 1, () => { if (shots.length < 3) return null; const [a, b] = r.shuffle(shots); return shot.mergeShots(g, a, b, o); }],
    ['reorderShots', 2, () => { if (!groups.length) return null; const gid = r.pick(groups); return shot.reorderShots(g, gid, r.shuffle(g.groups[gid].children.filter((c) => g.nodes[c].type === 'shot')), o); }],
    ['moveShotToGroup', 2, () => shots.length && groups.length && shot.moveShotToGroup(g, r.pick(shots), r.pick(groups), r.int(5), o)],
    ['regenerateShot', 2, () => shots.length && shot.regenerateShot(g, r.pick(shots), r.pick([{}, { targets: ['video'] }, { targets: ['image'] }, { seed: r.int(5) }]), o)],
    ['setVoice', 1, () => shots.length && shot.setVoice(g, r.pick(shots), { voice: r.pick(['a', 'b', 'c']), speed: r.pick([1, 1.2]) }, o)],
    // 生成：随机挑一些过期节点生成（产出内容签名 = 预言机签名）
    ['generate', 5, () => stale.length && S.generateTx(g, r.shuffle(stale).slice(0, 1 + r.int(4)), o)],
    ['trimSegment', 3, () => { if (!segs.length) return null; const s = r.pick(segs); const dur = g.nodes[s.shot_id].params.duration_ms; const a = r.int(dur - 1); return timeline.trimSegment(g, s.id, { in_ms: a, out_ms: a + 1 + r.int(dur - a) }, o); }],
    ['moveSegment', 2, () => { if (!segs.length) return null; const s = r.pick(segs); const other = segs.filter((x) => x.id !== s.id); const mode = r.int(3); if (mode === 0 || !other.length) return timeline.moveSegment(g, s.id, { gap_before_ms: r.int(900) }, o); return timeline.moveSegment(g, s.id, mode === 1 ? { before_segment_id: r.pick(other).id } : { after_segment_id: r.pick(other).id }, o); }],
    ['splitSegment', 2, () => { const c = segs.filter((s) => s.out_ms - s.in_ms >= 2); if (!c.length) return null; const s = r.pick(c); return timeline.splitSegment(g, s.id, s.in_ms + 1 + r.int(s.out_ms - s.in_ms - 1), o); }],
    ['deleteSegment', 1, () => segs.length > 2 && timeline.deleteSegment(g, r.pick(segs).id, o)],
    ['setTransition', 1, () => segs.length && timeline.setTransition(g, r.pick(segs).id, r.pick([null, 'fade', 'wipe']), o)],
    ['addMusic', 1, () => cid && timeline.addMusic(g, { asset_ref: 'bgm.mp3', start_ms: r.int(5000), duration_ms: 1 + r.int(9000), volume: 0.5 }, o)],
    ['moveNode', 6, () => nodes.length && canvas.moveNode(g, r.pick(nodes), { x: r.int(2000) - 500, y: r.int(2000) - 500 }, o)],
    ['connectNodes', 2, () => nodes.length > 1 && canvas.connectNodes(g, r.pick(nodes), r.pick(nodes), {}, o)],
    ['disconnectNodes', 1, () => g.edges.length && canvas.disconnectNodes(g, { edge_id: r.pick(g.edges).id }, o)],
    ['addNodeAt', 2, () => canvas.addNodeAt(g, r.pick(['script_line', 'shot', 'image', 'video', 'narration']), { x: r.int(500), y: r.int(500), group: groups.length ? r.pick(groups) : undefined }, o)],
    ['deleteNode', 2, () => { const c = nodes.filter((n) => g.nodes[n].type !== 'compose'); return c.length > 4 && canvas.deleteNode(g, r.pick(c), o); }],
  ];
  const total = gens.reduce((a, x) => a + x[1], 0);
  for (let tries = 0; tries < 40; tries++) {
    let k = r.int(total);
    for (const [name, w, f] of gens) {
      if (k < w) {
        let tx;
        try { tx = f(); } catch (e) { if (e instanceof K.KernelError && e.code === 'INTENT') break; throw e; }
        if (tx) {
          // 画布随意连线可能让图校验失败（环、端口）——那属于被拒绝的事务，换一个；其余错误是真缺陷
          try { K.applyTx(g, tx); return { name, tx }; } catch (e) { if (e instanceof K.KernelError && ['INTENT', 'VALIDATION'].includes(e.code) && ['connectNodes', 'addNodeAt', 'disconnectNodes', 'deleteNode'].includes(name)) break; throw e; }
        }
        break;
      }
      k -= w;
    }
  }
  return null;
}

function fuzzVariant(seed) {
  return {
    name: `seed:${seed}`,
    steps: (g0, story) => {
      const r = prng(seed * 1000 + story.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0));
      let depth = 0; // 可撤销的事务数（重载点之后）
      let future = 0;
      const out = [];
      for (let i = 0; i < STEPS; i++) {
        out.push((g, o) => {
          const roll = r.next();
          if (roll < 0.08 && depth > 0) { depth--; future++; return { undo: true }; }
          if (roll < 0.14 && future > 0) { depth++; future--; return { redo: true }; }
          if (roll < 0.19) { const back = r.int(4); depth = Math.min(depth, back); future = 0; return { crash: { back } }; }
          const pick = randomTx(g, r, o);
          assert.ok(pick, `step ${i}: no applicable intent`);
          depth++; future = 0;
          return { tx: pick.tx };
        });
      }
      return out;
    },
  };
}

for (const seed of [1, 2, 3]) {
  test(`随机会话（种子 ${seed}）：每个故事 ${STEPS} 步，全程 I1–I8 + 预言机 + 崩溃重放`, () => {
    const scenario = { id: 'fuzz', entries: { canvas: [] } };
    const failures = [];
    for (const story of S.loadStories()) {
      try {
        H.runVariant({ story, scenario, view: 'mixed', variant: { name: `seed:${seed}`, steps: fuzzVariant(seed).steps(S.prepared(story), story) }, initial: S.prepared(story) });
      } catch (e) { failures.push(`[${story.id}] ${e.message.split('\n')[0]}`); }
    }
    assert.deepEqual(failures, []);
  });
}
