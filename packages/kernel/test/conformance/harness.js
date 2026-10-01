'use strict';
// 一致性套件的运行器：把一个“场景 + 入口视图”在某个故事上跑完，每一步之后检查 I1–I8，
// 并做 撤销/重做、重复 tx_id、崩溃重放（每个事务边界）检查。
const assert = require('node:assert/strict');
const K = require('../../src');
const O = require('./oracle');
const I = require('./invariants');
const S = require('./stories');

const sorted = (a) => [...a].sort();
const VIEWS = ['script', 'shot', 'timeline', 'canvas'];

function writesConfined(before, after, allowed, label) {
  const bad = O.changedPaths(before, after).filter((p) => !allowed.some((re) => re.test(p)));
  assert.deepEqual(bad, [], `${label}: edit wrote paths outside its allowance`);
}

/** 崩溃重放：在每个事务边界 k 取快照，快照 + 日志尾重放得到当前图；日志重复/快照已含的事务重放无副作用。 */
function crashMatrix(states, log, cursor, label) {
  const final = states[cursor];
  for (let k = 0; k <= cursor; k++) {
    const tail = log.slice(k, cursor);
    const snap = () => K.fromJSON(states[k].json);
    // a) 快照 + 日志尾
    const a = K.replay(snap(), tail);
    assert.equal(K.toJSON(a), final.json, `${label}: crash at boundary ${k}: snapshot + log tail`);
    assert.deepEqual(I.viewsJSON(a), final.views, `${label}: crash at boundary ${k}: views`);
    // b) 日志里每条重复一次（含最后一条被重复写入）
    const dup = tail.flatMap((t) => [t, t]);
    assert.equal(K.toJSON(K.replay(snap(), dup)), final.json, `${label}: duplicated log entries at boundary ${k}`);
    // c) 快照已包含前 k 个事务，日志却从头重放：applied 集合里已有的 tx_id 为空操作
    let g = snap();
    const applied = new Set(log.slice(0, k).map((t) => t.tx_id));
    for (const t of log.slice(0, cursor)) g = K.applyTx(g, t, { applied }).graph;
    assert.equal(K.toJSON(g), final.json, `${label}: full log over snapshot ${k} with applied ids`);
  }
  // 从零（初始快照）整段重放
  assert.equal(K.toJSON(K.replay(K.fromJSON(states[0].json), log.slice(0, cursor))), final.json, `${label}: replay from initial`);
}

/**
 * 执行一个变体（一个入口视图下的一串步骤）。步骤函数：(g, o, env) => spec，spec 之一：
 *   { tx, writes?, invalidated?, revalidated?, stale?, layoutOnly?, check? } | { undo: true } | { redo: true } | { crash: { back } }
 * 返回 { json, views }（终态图的规范 JSON 与四视图 JSON）。失败抛 AssertionError。
 */
function runVariant({ story, scenario, view, variant, initial }) {
  const label = `${scenario.id}/${view}/${variant.name}@${story.id}`;
  const env = { story, view, scenario, label };
  let hist = new K.History(initial);
  const record = (g) => ({ json: K.toJSON(g), views: I.viewsJSON(g) });
  const states = [record(initial)];
  const log = [];
  let cursor = 0;
  let floor = 0; // 崩溃重载后，撤销栈只剩重载点之后的事务
  I.tag(`${label} [initial]`, () => I.checkGraph(initial));
  let n = 0;

  for (const stepFn of variant.steps) {
    n++;
    const o = { tx_id: `${label}#${n}` };
    const spec = stepFn(hist.graph, o, env);
    assert.ok(spec, `${label}: step ${n} returned nothing`);
    const where = `${label} [step ${n}${spec.tx ? ` ${spec.tx.label}` : spec.undo ? ' undo' : spec.redo ? ' redo' : ' crash'}]`;

    if (spec.undo || spec.redo) {
      assert.ok(spec.undo ? hist.canUndo() : hist.canRedo(), `${where}: nothing to ${spec.undo ? 'undo' : 'redo'} (scenario bug)`);
      const before = hist.graph;
      const r = spec.undo ? hist.undo() : hist.redo();
      cursor += spec.undo ? -1 : 1;
      assert.equal(K.toJSON(hist.graph), states[cursor].json, `${where}: I6 graph equals the state at that boundary`);
      assert.deepEqual(I.viewsJSON(hist.graph), states[cursor].views, `${where}: I6 all four views identical`);
      assert.deepEqual(r.invalidated, O.expectedDiff(before, hist.graph).invalidated, `${where}: undo/redo invalidated vs oracle`);
      assert.deepEqual(r.revalidated, O.expectedDiff(before, hist.graph).revalidated, `${where}: undo/redo revalidated vs oracle`);
      I.tag(where, () => I.checkGraph(hist.graph));
      continue;
    }

    if (spec.crash) {
      const k = Math.max(0, cursor - (spec.crash.back ?? 0));
      const snap = K.fromJSON(states[k].json);
      const h = new K.History(snap);
      for (const t of log.slice(k, cursor)) assert.equal(h.apply(t).applied, true, `${where}: log tx applies on reload`);
      assert.equal(K.toJSON(h.graph), states[cursor].json, `${where}: I7 reloaded graph == in-memory graph`);
      assert.deepEqual(I.viewsJSON(h.graph), states[cursor].views, `${where}: I7 views after reload`);
      // 同一 tx_id 重放无副作用
      for (const t of log.slice(k, cursor)) assert.equal(h.apply(t).applied, false, `${where}: duplicate tx_id replay is a no-op`);
      assert.equal(K.toJSON(h.graph), states[cursor].json);
      hist = h;
      floor = k;
      log.length = cursor; // 崩溃后被撤销的事务不在落盘日志里
      states.length = cursor + 1;
      I.tag(where, () => I.checkGraph(hist.graph));
      continue;
    }

    // ---- 普通事务 ----
    const { tx } = spec;
    const before = hist.graph;
    const r = hist.apply(tx);
    assert.equal(r.applied, true, `${where}: applied`);
    const after = hist.graph;
    cursor++;
    log.length = cursor - 1;
    log.push(tx);
    states.length = cursor;
    states.push(record(after));

    if (spec.writes) writesConfined(before, after, spec.writes, where);
    const layoutOnly = tx.ops.length > 0 && tx.ops.every((x) => x.op === 'setLayout');
    if (spec.layoutOnly) assert.ok(layoutOnly, `${where}: expected a layout-only tx`);
    if (layoutOnly) I.tag(where, () => I.I4(before, after, r));

    const d = O.expectedDiff(before, after);
    assert.deepEqual(r.invalidated, d.invalidated, `${where}: tx.invalidated vs oracle`);
    assert.deepEqual(r.revalidated, d.revalidated, `${where}: tx.revalidated vs oracle`);
    if (spec.invalidated) assert.deepEqual(r.invalidated, sorted(spec.invalidated), `${where}: hand-derived invalidated set`);
    if (spec.revalidated) assert.deepEqual(r.revalidated, sorted(spec.revalidated), `${where}: hand-derived revalidated set`);
    if (spec.stale) assert.deepEqual(K.staleSet(after), sorted(spec.stale), `${where}: hand-derived stale set after`);
    if (spec.check) spec.check(before, after, r, env);
    I.tag(where, () => I.checkGraph(after));

    // I6（单步）：逆 op 还原到事务前逐字节相同，再重做回到事务后；失效差异对称
    const un = K.applyTx(after, { tx_id: `${tx.tx_id}:undo`, ops: r.inverse });
    assert.equal(K.toJSON(un.graph), K.toJSON(before), `${where}: I6 inverse restores the previous graph`);
    assert.deepEqual(I.viewsJSON(un.graph), states[cursor - 1].views, `${where}: I6 views restored by inverse`);
    assert.deepEqual(un.revalidated, r.invalidated, `${where}: undo revalidates exactly what the tx invalidated`);
    assert.deepEqual(un.invalidated, r.revalidated, `${where}: undo invalidates exactly what the tx revalidated`);
    const re = K.applyTx(un.graph, tx);
    assert.equal(K.toJSON(re.graph), K.toJSON(after), `${where}: I6 redo restores`);
    assert.deepEqual(I.viewsJSON(re.graph), states[cursor].views);

    // I7（重复 tx_id）：History 和纯函数两条路径
    const dupH = hist.apply(tx);
    assert.equal(dupH.applied, false, `${where}: duplicate tx_id rejected by History`);
    assert.equal(hist.graph, after, `${where}: duplicate tx left the graph object untouched`);
    const dupP = K.applyTx(after, tx, { applied: new Set([tx.tx_id]) });
    assert.equal(dupP.applied, false);
    assert.equal(dupP.graph, after);
  }

  // 整段会话撤销到重载点再重做（I6，每个边界）
  const top = cursor;
  while (cursor > floor) {
    hist.undo();
    cursor--;
    assert.equal(K.toJSON(hist.graph), states[cursor].json, `${label}: I6 undo chain at boundary ${cursor}`);
    assert.deepEqual(I.viewsJSON(hist.graph), states[cursor].views, `${label}: I6 views at boundary ${cursor}`);
  }
  while (cursor < top) {
    hist.redo();
    cursor++;
    assert.equal(K.toJSON(hist.graph), states[cursor].json, `${label}: I6 redo chain at boundary ${cursor}`);
    assert.deepEqual(I.viewsJSON(hist.graph), states[cursor].views, `${label}: I6 redo views at boundary ${cursor}`);
  }
  // I7：每个事务边界崩溃
  crashMatrix(states, log, cursor, label);
  return { json: states[cursor].json, views: states[cursor].views, label };
}

const stripLayout = (json) => { const g = JSON.parse(json); g.layout = {}; return K.canonicalJSON(g); };

/**
 * 在一个故事上跑一个场景的所有入口：返回结果行
 * { scenario, view, variant, story, status: 'pass'|'fail'|'skip', error?, reason? }；
 * 若场景声明了 equivalence，另加一行 view:'equiv'（各入口终态图必须一致）。
 */
function runScenarioOnStory(scenario, story) {
  const results = [];
  const mkInitial = () => (scenario.initial ? scenario.initial(story) : S.prepared(story));
  const initial = mkInitial();
  const why = scenario.applicable ? scenario.applicable(initial, story) : null;
  const done = [];
  for (const view of VIEWS) {
    for (const variant of scenario.entries[view] || []) {
      const row = { scenario: scenario.id, view, variant: variant.name, story: story.id };
      if (why) { results.push({ ...row, status: 'skip', reason: why }); continue; }
      try {
        const out = runVariant({ story, scenario, view, variant: { name: variant.name, steps: variant.steps(initial, story) }, initial: mkInitial() });
        results.push({ ...row, status: 'pass' });
        done.push({ view, variant: variant.name, out });
      } catch (e) {
        results.push({ ...row, status: 'fail', error: e });
      }
    }
  }
  if (scenario.equivalence && !why && done.length > 1) {
    const row = { scenario: scenario.id, view: 'equiv', variant: scenario.equivalence, story: story.id };
    try {
      const ref = done[0];
      for (const d of done.slice(1)) {
        if (scenario.equivalence === 'graph') {
          assert.equal(d.out.json, ref.out.json, `${scenario.id}@${story.id}: ${d.view}/${d.variant} and ${ref.view}/${ref.variant} must end at the same graph`);
          assert.deepEqual(d.out.views, ref.out.views);
        } else {
          assert.equal(stripLayout(d.out.json), stripLayout(ref.out.json), `${scenario.id}@${story.id}: ${d.view}/${d.variant} vs ${ref.view}/${ref.variant} (ignoring layout)`);
          for (const name of ['script', 'shot', 'timeline']) assert.equal(d.out.views[name], ref.out.views[name], `${name} view differs between entries`);
        }
      }
      results.push({ ...row, status: 'pass' });
    } catch (e) {
      results.push({ ...row, status: 'fail', error: e });
    }
  }
  return results;
}

module.exports = { VIEWS, runVariant, runScenarioOnStory, crashMatrix, writesConfined };
