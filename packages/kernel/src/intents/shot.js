'use strict';
// 分镜视图的意图：只产出事务。
const G = require('../graph');
const U = require('./util');

/** 新建镜头所需的全部 op：shot + image/video/narration 节点、连线、组内位置、compose 默认片段。 */
function addShotOps(g, alloc, { group, index, params = {}, lines = [], legacy_id, id }) {
  const grp = U.needGroup(g, group);
  const shotId = id || alloc('shot');
  const p = { ...G.defaultParams('shot'), ...structuredClone(params) };
  const ids = { shot: shotId, image: alloc('img'), video: alloc('vid'), narration: alloc('nar') };
  const shot = { id: shotId, type: 'shot', params: p };
  if (legacy_id !== undefined && legacy_id !== null) shot.legacy_id = legacy_id;
  const ops = [
    { op: 'addNode', node: shot },
    { op: 'addNode', node: { id: ids.image, type: 'image', params: G.defaultParams('image') } },
    { op: 'addNode', node: { id: ids.video, type: 'video', params: G.defaultParams('video') } },
    { op: 'addNode', node: { id: ids.narration, type: 'narration', params: G.defaultParams('narration') } },
    { op: 'setChildren', group, ids: U.insertAmong(g, grp.children, 'shot', index, shotId) },
  ];
  for (const l of lines) {
    U.need(g, l, 'script_line');
    ops.push(U.edgeOp(alloc, l, shotId, 'shot', 'lines'));
  }
  ops.push(U.edgeOp(alloc, shotId, ids.image, 'image', 'shot'));
  ops.push(U.edgeOp(alloc, ids.image, ids.video, 'video', 'image'));
  ops.push(U.edgeOp(alloc, shotId, ids.video, 'video', 'shot'));
  ops.push(U.edgeOp(alloc, shotId, ids.narration, 'narration', 'shot'));
  const c = U.composeOf(g);
  if (c) {
    ops.push(U.edgeOp(alloc, ids.video, c.id, 'compose', 'video'));
    ops.push(U.edgeOp(alloc, ids.narration, c.id, 'compose', 'narration'));
    c.segments.push({ id: alloc('seg'), shot_id: shotId, in_ms: 0, out_ms: p.duration_ms, gap_before_ms: 0, transition: null });
    ops.push(U.segOp(c.id, c.segments));
  }
  return { ops, ids };
}

function addShot(g, args, opts) {
  const { ops, ids } = addShotOps(g, U.makeAlloc(g), args);
  return U.mkTx('addShot', ops, opts, { shot_id: ids.shot, ...ids });
}

/** 移除镜头及其 image/video/narration 节点（边、布局、版本级联清理）。 */
function removeShotNodesOps(g, shotId) {
  // 同一类型可能有多个（画布手工连线），全部移除；经 image 连出的 video 也属于该镜头
  const targets = new Set();
  const take = (id) => { if (['image', 'video', 'narration'].includes(g.nodes[id].type)) targets.add(id); };
  for (const e of G.edgesFrom(g, shotId)) take(e.to.node);
  for (const id of [...targets]) {
    if (g.nodes[id].type === 'image') for (const e of G.edgesFrom(g, id)) if (g.nodes[e.to.node].type === 'video') targets.add(e.to.node);
  }
  const ops = [...targets].sort().map((id) => ({ op: 'removeNode', id }));
  ops.push({ op: 'removeNode', id: shotId });
  return ops;
}

function deleteShot(g, shotId, opts) {
  U.need(g, shotId, 'shot');
  const ops = removeShotNodesOps(g, shotId);
  const c = U.composeOf(g);
  if (c) ops.unshift(U.segOp(c.id, c.segments.filter((s) => s.shot_id !== shotId)));
  return U.mkTx('deleteShot', ops, opts);
}

/** 改镜头字段。改 duration_ms 时同事务内让片段跟随：未裁剪的整段延长，超出的裁到新时长。 */
function setShotField(g, shotId, patch, opts) {
  const n = U.need(g, shotId, 'shot');
  const ops = [];
  for (const [k, v] of Object.entries(patch)) {
    if (JSON.stringify(n.params[k]) !== JSON.stringify(v)) ops.push({ op: 'setParam', node: shotId, path: [k], value: v });
  }
  if (patch.duration_ms !== undefined && patch.duration_ms !== n.params.duration_ms) {
    if (!Number.isInteger(patch.duration_ms) || patch.duration_ms <= 0) throw U.intentError('duration_ms must be a positive integer');
    const c = U.composeOf(g);
    if (c) {
      const old = n.params.duration_ms;
      const next = patch.duration_ms;
      let changed = false;
      for (const s of c.segments) {
        if (s.shot_id !== shotId) continue;
        const before = JSON.stringify(s);
        if (s.in_ms === 0 && s.out_ms === old) s.out_ms = next;
        else { s.in_ms = Math.min(s.in_ms, next - 1); s.out_ms = Math.min(s.out_ms, next); }
        if (JSON.stringify(s) !== before) changed = true;
      }
      if (changed) ops.push(U.segOp(c.id, c.segments));
    }
  }
  return U.mkTx('setShotField', ops, opts);
}

/** 在组内重排镜头（ids 必须是该组全部镜头的排列）；时间线顺序随之改变。 */
function reorderShots(g, groupId, ids, opts) {
  const grp = U.needGroup(g, groupId);
  return U.mkTx('reorderShots', [{ op: 'setChildren', group: groupId, ids: U.permuteAmong(g, grp.children, 'shot', ids) }], opts);
}

/** 把镜头移到另一个（或同一个）场景组的第 index 个镜头位置。 */
function moveShotToGroup(g, shotId, toGroup, index, opts) {
  U.need(g, shotId, 'shot');
  U.needGroup(g, toGroup);
  return U.mkTx('moveShotToGroup', U.placeShotOps(g, shotId, toGroup, { index }), opts);
}

/**
 * 拆镜头：该镜头的行按剧本顺序，前 atLineIndex 行留下，其余挂到新镜头。
 * 新镜头克隆参数及 image/video/narration（无采用版本，需重新生成，要花钱），紧跟在原镜头之后；
 * 原镜头因行变化其下游也过期。新镜头得到一个整段片段，原镜头的片段不动。
 */
function splitShot(g, shotId, atLineIndex, opts) {
  const n = U.need(g, shotId, 'shot');
  const lines = G.linesOfShot(g, shotId);
  if (!Number.isInteger(atLineIndex) || atLineIndex < 0 || atLineIndex > lines.length) throw U.intentError('splitShot: atLineIndex out of range');
  const alloc = U.makeAlloc(g);
  const gid = G.groupOf(g, shotId);
  const { ops, ids } = addShotOps(g, alloc, {
    group: gid, params: n.params, lines: [], index: G.shotOrder(g).filter((s) => G.groupOf(g, s) === gid).indexOf(shotId) + 1,
  });
  for (const l of lines.slice(atLineIndex)) {
    const e = G.edgesTo(g, shotId).find((x) => x.from.node === l && x.to.port === 'lines');
    ops.push({ op: 'disconnect', id: e.id });
    ops.push(U.edgeOp(alloc, l, ids.shot, 'shot', 'lines'));
  }
  // 克隆原生成节点的参数（addShotOps 建的是默认节点，这里覆盖成原参数，含种子）
  const parts = G.partsOfShot(g, shotId);
  for (const k of ['image', 'video', 'narration']) {
    if (parts[k]) for (const [pk, pv] of Object.entries(g.nodes[parts[k]].params)) ops.push({ op: 'setParam', node: ids[k], path: [pk], value: pv });
  }
  return U.mkTx('splitShot', ops, opts, { shot_id: ids.shot, ...ids });
}

/** 把 b 并入 a：b 的行挂到 a，b 及其生成节点删除，a 的生成时长 = 两者之和（需重新生成）；b 的片段随之删除。 */
function mergeShots(g, aId, bId, opts) {
  const a = U.need(g, aId, 'shot');
  const b = U.need(g, bId, 'shot');
  if (aId === bId) throw U.intentError('mergeShots: need two different shots');
  const alloc = U.makeAlloc(g);
  const have = new Set(G.linesOfShot(g, aId));
  const ops = [];
  for (const l of G.linesOfShot(g, bId)) if (!have.has(l)) ops.push(U.edgeOp(alloc, l, aId, 'shot', 'lines'));
  const oldDur = a.params.duration_ms;
  const newDur = oldDur + b.params.duration_ms;
  ops.push({ op: 'setParam', node: aId, path: ['duration_ms'], value: newDur });
  const c = U.composeOf(g);
  if (c) {
    const segs = c.segments.filter((s) => s.shot_id !== bId);
    for (const s of segs) if (s.shot_id === aId && s.in_ms === 0 && s.out_ms === oldDur) s.out_ms = newDur;
    ops.push(U.segOp(c.id, segs));
  }
  ops.push(...removeShotNodesOps(g, bId));
  return U.mkTx('mergeShots', ops, opts);
}

/** 重新生成：给 image/video 节点换种子，下游变过期，旧版本保留。targets 默认 image+video。 */
function regenerateShot(g, shotId, { seed, targets = ['image', 'video'] } = {}, opts) {
  U.need(g, shotId, 'shot');
  const parts = G.partsOfShot(g, shotId);
  const ops = [];
  for (const t of targets) {
    if (t !== 'image' && t !== 'video') throw U.intentError(`bad regenerate target: ${t}`);
    if (!parts[t]) continue;
    const prev = g.nodes[parts[t]].params.seed;
    ops.push({ op: 'setParam', node: parts[t], path: ['seed'], value: seed !== undefined ? seed : (Number.isInteger(prev) ? prev : 0) + 1 });
  }
  return U.mkTx('regenerateShot', ops, opts);
}

/**
 * 选镜改片（P3-R）：把“时间段（入点/出点）+ 画面区域 + 一句话修改”记成该镜头 video 节点的参数 `edit`。
 * 它和 seed 一样进 cacheKey，所以视频与合成过期、旧版本保留；结果由服务作为新版本记录，采用与否由用户在 A/B 对比后决定。
 *   t0_ms / t1_ms：相对镜头视频起点的毫秒整数，0 <= t0 < t1 <= 视频时长（已采用版本的真实片长，未知时取 duration_ms）
 *   rect：{ x, y, w, h } 归一化到 0..1（四位小数）；mode 'segment'（整段重做）可省略 = 整幅画面
 *   prompt：修改说明；mode：'region'（只改区域）| 'segment'（整段）
 * 需要已采用的视频版本（没有视频无从“改片”），其 id 记进 edit.base：同一修改作用在不同基底上 key 不同。
 * 与当前 edit 完全相同 = 空事务。
 */
function editShotRegion(g, shotId, { t0_ms, t1_ms, rect, prompt, mode = 'region' } = {}, opts) {
  U.need(g, shotId, 'shot');
  const video = G.partsOfShot(g, shotId).video;
  if (!video) throw U.intentError('shot has no video node');
  const base = G.adoptedVersion(g, video);
  if (!base || !base.asset || !base.asset.ref) throw U.intentError('shot has no adopted video to edit');
  if (!G.EDIT_MODES.includes(mode)) throw U.intentError(`mode must be one of ${G.EDIT_MODES.join('/')}`);
  const total = require('../projections').realVideoMs(g, shotId) || g.nodes[shotId].params.duration_ms || G.DEFAULT_SHOT_MS;
  if (!Number.isInteger(t0_ms) || !Number.isInteger(t1_ms) || t0_ms < 0 || t1_ms <= t0_ms) throw U.intentError('t0_ms / t1_ms must be integers with 0 <= t0 < t1');
  if (t1_ms > total) throw U.intentError(`t1_ms exceeds the video length (${total} ms)`);
  if (typeof prompt !== 'string' || !prompt.trim()) throw U.intentError('prompt must be a non-empty string');
  const r = G.normalizeRect(rect === undefined && mode === 'segment' ? { x: 0, y: 0, w: 1, h: 1 } : rect);
  if (r.error) throw U.intentError(`rect: ${r.error}`);
  const edit = { base: base.id, mode, t0_ms, t1_ms, rect: r.rect, prompt: prompt.trim() };
  return U.mkTx('editShotRegion', U.paramOps(g, video, 'edit', edit), opts, { node: video, edit });
}

/**
 * 采用镜头的某个视频版本，并让节点参数跟随该版本的“配方”：版本 metadata.edit 有则写进 params.edit，没有则清除。
 * 这样采用改片结果后节点新鲜（key 含该 edit），采用回原版本也新鲜（key 回到整镜生成时的值），不会因为切换版本而误报过期。
 * 版本不存在 -> INTENT。只采用、参数已一致 = 只有 adoptVersion 一个 op；版本已采用且参数一致 = 空事务。
 */
function adoptShotVersion(g, shotId, { version_id } = {}, opts) {
  U.need(g, shotId, 'shot');
  const video = G.partsOfShot(g, shotId).video;
  if (!video) throw U.intentError('shot has no video node');
  const v = (g.versions[video] || []).find((x) => x.id === version_id);
  if (!v) throw U.intentError(`version not found: ${version_id}`);
  const recipe = v.metadata && G.isObj(v.metadata.edit) ? v.metadata.edit : null;
  const ops = U.paramOps(g, video, 'edit', recipe);
  if (g.adopted[video] !== version_id) ops.push({ op: 'adoptVersion', node: video, version_id });
  return U.mkTx('adoptShotVersion', ops, opts, { node: video, version_id });
}

/** 换音色/语速（只改该镜头的 narration 节点）。 */
function setVoice(g, shotId, { voice, speed }, opts) {
  U.need(g, shotId, 'shot');
  const nar = G.partsOfShot(g, shotId).narration;
  if (!nar) throw U.intentError('shot has no narration node');
  const ops = [];
  if (voice !== undefined) ops.push({ op: 'setParam', node: nar, path: ['voice'], value: voice });
  if (speed !== undefined) ops.push({ op: 'setParam', node: nar, path: ['speed'], value: speed });
  return U.mkTx('setVoice', ops, opts);
}

/**
 * 记录镜头的生成输入（让它们进入 image/video 的 cacheKey）：
 *   image_model / video_model（所选模型，空 = 'default'）、reference_hashes（出图用的锁定参考图哈希，有序；空数组 = 清除）、
 *   video_reference_hashes（出视频用的锁定参考图哈希，同上）、tail_frame_hash（尾帧哈希；空 = 清除）。
 *   没给的字段不动；写入的是节点参数，所以改了就让该镜头的 image/video/合成过期，
 *   改回去则 cacheKey 回到原值（旧版本可零成本重新采用）。由生成服务与参考图锁定流程调用。
 */
function setShotReferences(g, shotId, { image_model, video_model, reference_hashes, video_reference_hashes, tail_frame_hash } = {}, opts) {
  U.need(g, shotId, 'shot');
  const parts = G.partsOfShot(g, shotId);
  const node = (kind, given) => {
    if (given === undefined) return null;
    if (!parts[kind]) throw U.intentError(`shot has no ${kind} node`);
    return parts[kind];
  };
  const ops = [];
  const empty = (v) => v === undefined ? undefined : (v === null || v === '' || (Array.isArray(v) && !v.length) ? null : v);
  const set = (kind, key, value) => { const id = node(kind, value); if (id) ops.push(...U.paramOps(g, id, key, value)); };
  set('image', 'model', image_model === undefined ? undefined : image_model || 'default');
  set('video', 'model', video_model === undefined ? undefined : video_model || 'default');
  set('image', 'reference_hashes', empty(reference_hashes));
  set('video', 'reference_hashes', empty(video_reference_hashes));
  set('video', 'tail_frame_hash', empty(tail_frame_hash));
  return U.mkTx('setShotReferences', ops, opts);
}

/**
 * 记录一次生成结果：新增版本（带当前 cacheKey）并采用。asset 如 { ref, hash, kind }。
 * metadata（可选）随版本保存：video 版本的 duration_ms（真实片长）；narration 版本的 duration_ms、voice、words（逐字时间戳）、cues（字幕块，相对镜头起点）。
 * 事务应用到产生它的那张图上才有意义（cacheKey 在此刻取）。
 */
function recordGeneration(g, nodeId, { version_id, asset, metadata } = {}, opts) {
  const n = U.need(g, nodeId);
  if (!G.GENERATED_TYPES.includes(n.type)) throw U.intentError(`${n.type} nodes have no generated versions`);
  const { cacheKeys } = require('../invalidation');
  const vid = version_id || `v_${(g.versions[nodeId] || []).length + 1}`;
  return U.mkTx('recordGeneration', [
    { op: 'addVersion', node: nodeId, version: { id: vid, cache_key: cacheKeys(g)[nodeId], asset: asset ? structuredClone(asset) : null, ...(metadata ? { metadata: structuredClone(metadata) } : {}) } },
    { op: 'adoptVersion', node: nodeId, version_id: vid },
  ], opts, { version_id: vid });
}

module.exports = {
  addShotOps, removeShotNodesOps, setShotField, addShot, deleteShot, splitShot, mergeShots, reorderShots, moveShotToGroup,
  regenerateShot, editShotRegion, adoptShotVersion, setVoice, setShotReferences, recordGeneration,
};
