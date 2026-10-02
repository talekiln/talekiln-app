'use strict';
/**
 * 生成输入（锁定的参考图、尾帧、所选模型）-> 镜头 image/video 节点的参数。
 *
 * 这些输入以前只进队列的幂等键，不进节点的 cacheKey，所以改了锁定参考图/尾帧/模型，已新鲜的节点仍显示“新鲜”。
 * 现在它们是节点自己的参数（image.model / image.reference_hashes / video.model / video.reference_hashes / video.tail_frame_hash），
 * 经内核意图 `setShotReferences` 写入事务，自然进入 cacheKey：改了 -> 该镜头 image + video + 合成过期；改回去 -> key 回到原值，
 * 旧版本可零成本重新采用（和提示词改回去一样）。
 *
 * 谁来写：生成服务在估算/建任务前同步（含模型）；参考图锁定/解除、尾帧变化的流程在改完旧表后调用 syncReferences（只写参考图与尾帧，
 * 不碰模型），所以界面上的“过期”标记立刻出现，不必等到下次点生成。
 *
 * 模型的基线：本改动之前生成的版本（导入的旧素材）不知道当时用了哪个模型，首次把“所选模型”记进节点参数时，
 * 把原本新鲜的采用版本“改记”到新 key（addVersion + adoptVersion，source: 'rebase'，metadata.inputs.model 记下现值），不让已有素材平白变过期、白白重做花钱；
 * 版本带 metadata.inputs.model（本改动之后生成的，或已改记过的）则按真实变化处理，换模型就过期。参考图、尾帧的变化永远是真实变化。
 */
const kernel = require('@talekiln/kernel');
const referenceLocks = require('../services/referenceLockService');
const store = require('./store');

const MAX_REFS = 4;
const staticRef = (rel) => (rel ? `/static/${String(rel).replace(/^\/+/, '')}` : '');
const hashRef = (u) => kernel.sha256(`ref:${u}`);

const adoptedRef = (g, nodeId) => {
  const v = nodeId && kernel.adoptedVersion(g, nodeId);
  return v && v.asset && v.asset.ref ? v.asset.ref : null;
};

/** 视频是否会带首帧（决定尾帧是否生效、视频选哪种模型）：有图片节点，且已有采用的首帧或能生成首帧。 */
function hasFirstFrame(g, shotId) {
  const { image } = kernel.partsOfShot(g, shotId);
  if (!image) return false;
  const p = g.nodes[shotId].params;
  return !!(p.image_prompt || p.description || adoptedRef(g, image));
}

/** 一个镜头当前的生成输入：锁定的参考图（场景在前、角色按镜头顺序，最多 4 张）与尾帧。 */
function shotInputs(db, g, shotId) {
  const node = g.nodes[shotId];
  const legacyId = node.legacy_id ?? null;
  const refs = legacyId != null ? referenceLocks.collectLockedRefsForStoryboard(db, legacyId).slice(0, MAX_REFS) : [];
  let tail = null;
  if (legacyId != null) {
    const row = db.prepare('SELECT last_frame_local_path, last_frame_image_url FROM storyboards WHERE id = ?').get(legacyId);
    if (row) tail = row.last_frame_local_path ? staticRef(row.last_frame_local_path) : (row.last_frame_image_url || null);
  }
  const frame = hasFirstFrame(g, shotId);
  return { refs, tail: frame ? tail : null, hasRefs: refs.length > 0, hasFrame: frame };
}

/**
 * 为一组镜头算“让节点参数与当前输入一致”的 ops（已一致则为空）。
 * models（可选）：{ image({hasRefs}) -> 模型名|undefined, video({hasFrame}) -> 模型名|undefined }；不给就不动模型参数。
 * tail:false = 不写尾帧（生成服务自己按计划里的首帧形态写尾帧与视频模型）。
 */
function inputOps(db, g, shotIds, { models = null, tail = true } = {}) {
  const ops = [];
  for (const id of shotIds) {
    const inp = shotInputs(db, g, id);
    const parts = kernel.partsOfShot(g, id);
    const args = {};
    if (parts.image) args.reference_hashes = inp.refs.map(hashRef);
    if (parts.video) args.video_reference_hashes = inp.refs.map(hashRef); // 视频请求也直接带锁定参考图（P3-C）
    if (tail && parts.video) args.tail_frame_hash = inp.tail ? hashRef(inp.tail) : null;
    if (models && models.image && parts.image) args.image_model = models.image(inp) || 'default';
    if (models && models.video && parts.video) args.video_model = models.video(inp) || 'default';
    ops.push(...kernel.intents.shot.setShotReferences(g, id, args).ops);
  }
  return ops;
}

/**
 * ops 之后哪些“原本新鲜”的节点会变过期，其中哪些只是首次记录所选模型（旧版本没有 metadata.inputs.model，当时用的模型未知）-> 改记到新 key。
 * 参考图、尾帧的变化永远按真实变化处理（旧素材没带过这些输入）；采用版本已记录模型的节点、其下游一律不改记。
 * 返回追加的 ops。
 */
function rebaseOps(g, ops) {
  const after = kernel.applyTx(g, { tx_id: 'sim', ops }).graph;
  const k0 = kernel.cacheKeys(g);
  const k1 = kernel.cacheKeys(after);
  const flipped = (id) => k0[id] !== k1[id] && kernel.nodeState(g, id, k0) === 'fresh';
  const changed = (id) => ['model', 'reference_hashes', 'tail_frame_hash'].filter((k) => JSON.stringify(g.nodes[id].params[k]) !== JSON.stringify(after.nodes[id].params[k]));
  const modelRecorded = (id) => { const v = kernel.adoptedVersion(g, id); return !!(v && v.metadata && v.metadata.inputs && 'model' in v.metadata.inputs); };
  const ids = Object.keys(g.nodes).filter((id) => ['image', 'video'].includes(g.nodes[id].type) && flipped(id));
  const real = new Set(ids.filter((id) => changed(id).some((k) => k !== 'model') || (changed(id).includes('model') && modelRecorded(id))));
  for (const e of g.edges) if (real.has(e.from.node) && ids.includes(e.to.node)) real.add(e.to.node); // 上游真实变化 -> 下游也是
  const out = [];
  const rebase = (id) => out.push(...aliasOps(g, id, kernel.adoptedVersion(g, id), k1[id], { model: after.nodes[id].params.model }));
  for (const id of ids) if (!real.has(id)) rebase(id);
  const compose = kernel.composeId(g);
  if (compose && flipped(compose) && !real.size) rebase(compose);
  return out;
}

/**
 * “忽略所选模型”的 cacheKey：把 image/video 的 model 还原成导入时的 'default' 再算（参考图、尾帧照旧）。
 * 没有 metadata.inputs.model 的旧版本（当时用的模型未知）按这个 key 判断“和现在的提示词/上游/参考图/尾帧一致”，命中就改记到现在的 key（零成本）。
 */
function legacyKeys(g) {
  const c = structuredClone(g);
  for (const n of Object.values(c.nodes)) {
    if (n.type !== 'image' && n.type !== 'video') continue;
    n.params.model = 'default';
  }
  return kernel.cacheKeys(c);
}

/** 把一个版本改记到节点当前 key 的 ops（别名版本，资产与元数据照搬）；已有别名则只采用。 */
function aliasOps(g, nodeId, version, key, recorded = {}) {
  const nid = `rb_${key.slice(0, 12)}`;
  if ((g.versions[nodeId] || []).some((x) => x.id === nid)) return [{ op: 'adoptVersion', node: nodeId, version_id: nid }];
  return [
    { op: 'addVersion', node: nodeId, version: { id: nid, cache_key: key, asset: version.asset ? structuredClone(version.asset) : null, metadata: { ...structuredClone(version.metadata || {}), inputs: { ...((version.metadata && version.metadata.inputs) || {}), ...recorded } }, source: 'rebase', rebased_from: version.id } },
    { op: 'adoptVersion', node: nodeId, version_id: nid },
  ];
}

/** 完整事务（含首次基线改记）；没有任何变化返回 null。 */
function inputsTx(db, g, shotIds, { models = null, tx_id, label = 'generation inputs' } = {}) {
  const ops = inputOps(db, g, shotIds, { models });
  if (!ops.length) return null;
  return { tx_id: tx_id || `gen-inputs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, label, ops: [...ops, ...rebaseOps(g, ops)] };
}

/** 在一个 SQLite 事务里把一个剧集的输入同步进图（没有变化 = 不写）。图不存在时什么也不做。 */
function syncEpisode(db, ep, shotIds, { models = null, label } = {}) {
  if (!store.hasProject(db, ep)) return { applied: false };
  const { graph } = store.openProject(db, ep);
  const ids = shotIds || kernel.shotOrder(graph);
  if (!inputsTx(db, graph, ids, { models })) return { applied: false };
  const r = store.commit(db, ep, (g) => inputsTx(db, g, ids, { models, label }) || { tx_id: `gen-inputs-noop-${Date.now().toString(36)}`, label: 'noop', ops: [] });
  return { applied: r.applied, invalidated: r.invalidated };
}

/**
 * 参考图锁定 / 解除、尾帧变化之后调用：把受影响剧集里所有镜头的参考图与尾帧同步进图（只写这两项）。
 * episodeIds 不给 = 所有已建图的剧集。尽力而为：失败只返回错误，不影响调用方已完成的旧表写入（下次生成估算前还会再同步一次）。
 */
function syncReferences(db, episodeIds = null) {
  const eps = episodeIds || db.prepare('SELECT episode_id FROM project_graphs').all().map((r) => r.episode_id);
  const out = [];
  for (const ep of eps) {
    try { out.push({ episode_id: Number(ep), ...syncEpisode(db, ep, null, { label: 'reference inputs' }) }); } catch (e) { out.push({ episode_id: Number(ep), applied: false, error: e.message }); }
  }
  return out;
}

module.exports = { legacyKeys, aliasOps, inputOps, rebaseOps, inputsTx, syncEpisode, syncReferences, shotInputs, hasFirstFrame, hashRef, MAX_REFS };
