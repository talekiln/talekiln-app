'use strict';
// 内核快照：导出一集的项目图（含撤销栈与 graph_ops 历史），导入到另一集并把旧 id 映射成新 id。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const kernel = require('@talekiln/kernel');
const store = require('../src/kernel/store');
const legacy = require('../src/kernel/legacy');
const snap = require('../src/backup/kernelSnapshot');
const timelineService = require('../src/timeline/service');
const { seededDb, sbRows } = require('./helpers/kernelDb');

const eq = (a, b, m) => assert.equal(kernel.canonicalJSON(a), kernel.canonicalJSON(b), m);
const REF_A = '/static/projects/sample/talekiln-sample-v1/gen_a.png';

/** 源项目：导入旧表 -> 带角色的镜头、一个新采用的图片版本、一次普通编辑、一次让图片过期的编辑。 */
async function buildSource() {
  const ctx = await seededDb();
  const { db, episodeId: ep } = ctx;
  legacy.importLegacy(db, ep);
  const shots = kernel.shotOrder(store.openProject(db, ep).graph);
  store.commit(db, ep, (g) => kernel.intents.shot.setShotField(g, shots[1], { characters: [1, 2] }, { tx_id: 'c1' }), { tx_id: 'c1' });
  store.commit(db, ep, (g) => kernel.intents.shot.recordGeneration(g, kernel.partsOfShot(g, shots[1]).image,
    { version_id: 'gen_a', asset: { ref: REF_A, kind: 'image', hash: 'hash-a' } }, { tx_id: 'c2' }), { tx_id: 'c2' });
  store.commit(db, ep, (g) => kernel.intents.shot.setShotField(g, shots[2], { title: 'edited title' }, { tx_id: 'c3' }), { tx_id: 'c3' });
  store.commit(db, ep, (g) => kernel.intents.shot.setShotField(g, shots[3], { image_prompt: 'changed prompt' }, { tx_id: 'c4' }), { tx_id: 'c4' });
  return { ...ctx, shots };
}

/** 目标集：同一个库里新建一集、复制分镜行，并建两个新角色。返回映射表。 */
function makeTarget(db, srcEp) {
  const drama = db.prepare('SELECT drama_id FROM episodes WHERE id = ?').get(srcEp).drama_id;
  const ep2 = Number(db.prepare("INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at) VALUES (?, 99, 'restored', datetime('now'), datetime('now'))").run(drama).lastInsertRowid);
  const sbMap = new Map();
  const cols = db.prepare('PRAGMA table_info(storyboards)').all().map((c) => c.name).filter((n) => n !== 'id' && n !== 'episode_id');
  for (const row of sbRows(db, srcEp)) {
    const info = db.prepare(`INSERT INTO storyboards (episode_id, ${cols.join(',')}) VALUES (?, ${cols.map(() => '?').join(',')})`).run(ep2, ...cols.map((c) => row[c]));
    sbMap.set(row.id, Number(info.lastInsertRowid));
  }
  const charMap = new Map();
  for (const oldId of [1, 2]) {
    const info = db.prepare("INSERT INTO characters (drama_id, name, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))").run(drama, `c${oldId}`);
    charMap.set(oldId, Number(info.lastInsertRowid));
  }
  // 目标集的旧表里 characters 列用新 id（和 dramaImportService 一致）
  db.prepare('UPDATE storyboards SET characters = ? WHERE id = ?').run(JSON.stringify([...charMap.values()]), sbMap.get(sbRows(db, srcEp)[1].id));
  const refMap = new Map([[REF_A, '/static/projects/restored/kernel/gen_a_new.png']]);
  return { ep2, idMap: { storyboards: sbMap, characters: charMap, refs: refMap } };
}

const dumpEp = (db, ep) => ({
  sb: sbRows(db, ep),
  ops: db.prepare('SELECT seq, tx_id, tx FROM graph_ops WHERE episode_id = ? ORDER BY seq').all(ep),
  snapshot: db.prepare('SELECT snapshot, snapshot_seq FROM project_graphs WHERE episode_id = ?').get(ep),
  tl: timelineService.loadTimelineByEpisode(db, ep),
});

describe('kernelSnapshot.exportEpisode', () => {
  it('returns null for an episode without a project graph', async () => {
    const { db, episodeId } = await seededDb();
    assert.equal(snap.exportEpisode(db, episodeId), null);
  });

  it('exports graph, undo stacks, ops, legacy map and the list of /static refs', async () => {
    const { db, episodeId } = await buildSource();
    const s = snap.exportEpisode(db, episodeId);
    assert.equal(s.format, 'talekiln-kernel-snapshot');
    assert.equal(s.version, 1);
    assert.equal(s.source_episode_id, episodeId);
    assert.equal(s.history.past.length, 4);
    assert.deepEqual(s.ops.map((o) => o.tx_id).slice(-4), ['c1', 'c2', 'c3', 'c4']);
    assert.equal(s.legacy_map.length, 5);
    assert.ok(s.refs.includes(REF_A), 'refs lists the adopted image');
    assert.ok(s.refs.every((r) => r.startsWith('/static/')));
    JSON.stringify(s); // 必须是纯 JSON
  });
});

describe('kernelSnapshot.importEpisode', () => {
  it('restores the graph with ids remapped: legacy ids, characters, refs, project id', async () => {
    const src = await buildSource();
    const { db, episodeId, shots } = src;
    const { ep2, idMap } = makeTarget(db, episodeId);
    const r = snap.importEpisode(db, ep2, snap.exportEpisode(db, episodeId), idMap);
    assert.equal(r.applied, true);
    assert.equal(r.mode, 'full');
    const a = store.openProject(db, episodeId).graph;
    const b = store.openProject(db, ep2).graph;
    assert.equal(b.project_id, String(ep2));
    assert.deepEqual(kernel.shotOrder(b), shots, 'node ids are kept');
    assert.deepEqual(kernel.shotOrder(b).map((id) => b.nodes[id].legacy_id), kernel.shotOrder(a).map((id) => idMap.storyboards.get(a.nodes[id].legacy_id)));
    assert.deepEqual(b.nodes[shots[1]].params.characters, [...idMap.characters.values()]);
    const img = kernel.partsOfShot(b, shots[1]).image;
    assert.equal(kernel.adoptedVersion(b, img).asset.ref, '/static/projects/restored/kernel/gen_a_new.png');
    assert.equal(kernel.adoptedVersion(b, img).asset.hash, 'hash-a', 'hashes are never rewritten');
    // 除了被映射的字段，其余完全相同：把目标图的映射还原后应与源图逐字节相同
    const back = JSON.parse(kernel.canonicalJSON(b));
    back.project_id = a.project_id;
    for (const id of Object.keys(back.nodes)) {
      const n = back.nodes[id];
      if (n.legacy_id !== undefined) n.legacy_id = [...idMap.storyboards].find(([, v]) => v === n.legacy_id)[0];
    }
    back.nodes[shots[1]].params.characters = [1, 2];
    const s = kernel.canonicalJSON(back).split('/static/projects/restored/kernel/gen_a_new.png').join(REF_A);
    // cache_key 被改写（引用与角色都进 key），先把它们抹掉再比
    const unseg = (v) => (typeof v === 'string' ? v.replace(/^seg([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/, '$1-$2-$3-$4-$5') : v);
    const strip = (txt) => JSON.parse(txt, (k, v) => (k === 'cache_key' ? undefined : unseg(v)));
    eq(strip(s), strip(kernel.canonicalJSON(a)));
  });

  it('keeps the stale set and the adopted versions identical', async () => {
    const { db, episodeId } = await buildSource();
    const { ep2, idMap } = makeTarget(db, episodeId);
    snap.importEpisode(db, ep2, snap.exportEpisode(db, episodeId), idMap);
    const a = store.openProject(db, episodeId).graph;
    const b = store.openProject(db, ep2).graph;
    const staleA = kernel.staleSet(a);
    assert.ok(staleA.length > 0, 'the source has stale nodes');
    assert.ok(kernel.staleSet(a).length < Object.keys(a.nodes).filter((id) => kernel.GENERATED_TYPES.includes(a.nodes[id].type)).length, 'and fresh ones');
    assert.deepEqual(kernel.staleSet(b), staleA);
    eq(b.adopted, a.adopted);
    eq(Object.fromEntries(Object.entries(b.versions).map(([k, v]) => [k, v.map((x) => x.id)])),
      Object.fromEntries(Object.entries(a.versions).map(([k, v]) => [k, v.map((x) => x.id)])));
  });

  it('keeps undo/redo working on the restored episode, and writes the target tables', async () => {
    const { db, episodeId, shots } = await buildSource();
    const { ep2, idMap } = makeTarget(db, episodeId);
    snap.importEpisode(db, ep2, snap.exportEpisode(db, episodeId), idMap);
    const open = store.openProject(db, ep2);
    assert.equal(open.canUndo, true);
    assert.equal(open.history.past.length, 4);
    let g = store.undo(db, ep2).graph; // 撤销 c4
    assert.equal(g.nodes[shots[3]].params.image_prompt !== 'changed prompt', true);
    store.undo(db, ep2); // c3
    g = store.openProject(db, ep2).graph;
    assert.notEqual(g.nodes[shots[2]].params.title, 'edited title');
    const row = db.prepare('SELECT title FROM storyboards WHERE id = ?').get(g.nodes[shots[2]].legacy_id);
    assert.equal(row.title, g.nodes[shots[2]].params.title, 'materialize wrote the restored episode rows');
    store.redo(db, ep2);
    assert.equal(store.openProject(db, ep2).graph.nodes[shots[2]].params.title, 'edited title');
    store.redo(db, ep2);
    // 一步步撤销到底再重做到顶，图回到起点
    const end = store.openProject(db, ep2).graph;
    while (store.openProject(db, ep2).canUndo) store.undo(db, ep2);
    while (store.openProject(db, ep2).canRedo) store.redo(db, ep2);
    eq(store.openProject(db, ep2).graph, end);
  });

  it('copies graph_ops so the history is intact, and later commits append after it', async () => {
    const { db, episodeId, shots } = await buildSource();
    const { ep2, idMap } = makeTarget(db, episodeId);
    snap.importEpisode(db, ep2, snap.exportEpisode(db, episodeId), idMap);
    const ids = (ep) => db.prepare('SELECT tx_id FROM graph_ops WHERE episode_id = ? ORDER BY seq').all(ep).map((x) => x.tx_id);
    assert.deepEqual(ids(ep2), ids(episodeId));
    store.commit(db, ep2, (g) => kernel.intents.shot.setShotField(g, shots[0], { title: 'after restore' }, { tx_id: 'n1' }), { tx_id: 'n1' });
    assert.equal(ids(ep2).pop(), 'n1');
    assert.equal(store.openProject(db, ep2).graph.nodes[shots[0]].params.title, 'after restore');
    // 重新打开（只靠快照 + 日志）得到同一张图
    const row = db.prepare('SELECT snapshot_seq FROM project_graphs WHERE episode_id = ?').get(ep2);
    assert.ok(row.snapshot_seq > 0);
  });

  it('creates the timeline for the restored episode without touching the source timeline', async () => {
    const { db, episodeId } = await buildSource();
    const before = dumpEp(db, episodeId);
    const { ep2, idMap } = makeTarget(db, episodeId);
    snap.importEpisode(db, ep2, snap.exportEpisode(db, episodeId), idMap);
    const tl = timelineService.loadTimelineByEpisode(db, ep2);
    assert.ok(tl, 'timeline exists');
    const clips = tl.tracks.flatMap((t) => t.clips);
    assert.ok(clips.length >= 5);
    assert.ok(clips.every((c) => c.id.startsWith(`e${ep2}_`) || /^[0-9a-f-]{36}$/.test(c.id)));
    const after = dumpEp(db, episodeId);
    eq(after, before, 'source episode is unchanged field by field');
  });

  it('degrades to graph + adopted versions with empty history when the undo stack cannot be remapped', async () => {
    const { db, episodeId, shots } = await buildSource();
    const { ep2, idMap } = makeTarget(db, episodeId);
    const s = snap.exportEpisode(db, episodeId);
    s.history.past[1].inverse = [{ op: 'removeNode', id: 'no_such_node' }]; // 逆 op 对不上图
    const r = snap.importEpisode(db, ep2, s, idMap);
    assert.equal(r.mode, 'graph');
    const open = store.openProject(db, ep2);
    assert.equal(open.canUndo, false);
    assert.equal(open.canRedo, false);
    assert.deepEqual(kernel.staleSet(open.graph), kernel.staleSet(store.openProject(db, episodeId).graph));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM graph_ops WHERE episode_id = ?').get(ep2).n, 0);
    // 之后照常编辑
    store.commit(db, ep2, (g) => kernel.intents.shot.setShotField(g, shots[0], { title: 'x' }, { tx_id: 'n2' }), { tx_id: 'n2' });
    assert.equal(store.openProject(db, ep2).canUndo, true);
  });

  it('rejects an unknown snapshot format and an episode that already has a graph', async () => {
    const { db, episodeId } = await buildSource();
    const { ep2, idMap } = makeTarget(db, episodeId);
    assert.throws(() => snap.importEpisode(db, ep2, { format: 'nope' }, idMap), (e) => e.code === 'SNAPSHOT_INVALID');
    const s = snap.exportEpisode(db, episodeId);
    snap.importEpisode(db, ep2, s, idMap);
    assert.throws(() => snap.importEpisode(db, ep2, s, idMap), (e) => e.code === 'SNAPSHOT_INVALID');
    assert.throws(() => snap.importEpisode(db, episodeId, s, idMap), (e) => e.code === 'SNAPSHOT_INVALID');
  });

  it('accepts plain objects as id maps (JSON friendly)', async () => {
    const { db, episodeId, shots } = await buildSource();
    const { ep2, idMap } = makeTarget(db, episodeId);
    const plain = { storyboards: Object.fromEntries(idMap.storyboards), characters: Object.fromEntries(idMap.characters), refs: Object.fromEntries(idMap.refs) };
    const r = snap.importEpisode(db, ep2, JSON.parse(JSON.stringify(snap.exportEpisode(db, episodeId))), plain);
    assert.equal(r.mode, 'full');
    assert.equal(store.openProject(db, ep2).graph.nodes[shots[1]].params.characters.length, 2);
  });
});
