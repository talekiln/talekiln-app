'use strict';
// 时间线视图的意图：只产出事务。片段（segment）存在 compose.params.segments，顺序属于镜头（children）。
const G = require('../graph');
const U = require('./util');
const { deleteShot } = require('./shot');

/** 裁剪：改片段在镜头源视频里的 in/out（毫秒整数，0 <= in < out <= 镜头时长，由校验兜底）。 */
function trimSegment(g, segId, { in_ms, out_ms }, opts) {
  const { compose, index, seg } = U.findSegment(g, segId);
  compose.segments[index] = { ...seg, in_ms: in_ms ?? seg.in_ms, out_ms: out_ms ?? seg.out_ms };
  for (const k of ['in_ms', 'out_ms']) if (!Number.isInteger(compose.segments[index][k])) throw U.intentError(`trimSegment: ${k} must be an integer`);
  return U.mkTx('trimSegment', [U.segOp(compose.id, compose.segments)], opts);
}

/**
 * 移动：
 * - { gap_before_ms }：只改该片段前的空隙；
 * - { before_segment_id | after_segment_id }：目标在同一镜头内 = 在该镜头的片段序列里换位；
 *   目标在另一镜头 = 改镜头顺序（整个镜头连同它的全部片段移到目标镜头之前/之后，可跨场景组）。
 */
function moveSegment(g, segId, { gap_before_ms, before_segment_id, after_segment_id } = {}, opts) {
  const { compose, index, seg } = U.findSegment(g, segId);
  const ops = [];
  if (gap_before_ms !== undefined) {
    if (!Number.isInteger(gap_before_ms) || gap_before_ms < 0) throw U.intentError('moveSegment: gap_before_ms must be an integer >= 0');
    compose.segments[index] = { ...seg, gap_before_ms };
  }
  const targetId = before_segment_id || after_segment_id;
  if (targetId) {
    if (targetId === segId) throw U.intentError('moveSegment: target is the segment itself');
    const t = U.findSegment(g, targetId).seg;
    if (t.shot_id === seg.shot_id) {
      const [moved] = compose.segments.splice(compose.segments.findIndex((s) => s.id === segId), 1);
      const at = compose.segments.findIndex((s) => s.id === targetId);
      compose.segments.splice(before_segment_id ? at : at + 1, 0, moved);
    } else {
      ops.push(...U.placeShotOps(g, seg.shot_id, G.groupOf(g, t.shot_id), before_segment_id ? { beforeShot: t.shot_id } : { afterShot: t.shot_id }));
    }
  }
  ops.push(U.segOp(compose.id, compose.segments));
  return U.mkTx('moveSegment', ops, opts);
}

/** 在源视频位置 at_ms（in < at < out）切开：后半段 gap 为 0、不带转场。 */
function splitSegment(g, segId, atMs, opts) {
  const { compose, index, seg } = U.findSegment(g, segId);
  if (!Number.isInteger(atMs) || atMs <= seg.in_ms || atMs >= seg.out_ms) throw U.intentError('splitSegment: at must fall strictly inside the segment');
  const second = { id: U.makeAlloc(g)('seg'), shot_id: seg.shot_id, in_ms: atMs, out_ms: seg.out_ms, gap_before_ms: 0, transition: null };
  compose.segments[index] = { ...seg, out_ms: atMs };
  compose.segments.splice(index + 1, 0, second);
  return U.mkTx('splitSegment', [U.segOp(compose.id, compose.segments)], opts, { segment_id: second.id });
}

/** 删片段。镜头的最后一个片段被删 = 删除整个镜头（四个视图一起消失），否则只去掉该片段。 */
function deleteSegment(g, segId, opts) {
  const { compose, seg } = U.findSegment(g, segId);
  const rest = compose.segments.filter((s) => s.id !== segId);
  if (!rest.some((s) => s.shot_id === seg.shot_id)) return deleteShot(g, seg.shot_id, opts);
  return U.mkTx('deleteSegment', [U.segOp(compose.id, rest)], opts);
}

/** 设置进入该片段的转场（null/空 = 无转场）。 */
function setTransition(g, segId, transition, opts) {
  const { compose, index, seg } = U.findSegment(g, segId);
  compose.segments[index] = { ...seg, transition: transition || null };
  return U.mkTx('setTransition', [U.segOp(compose.id, compose.segments)], opts);
}

/** 加一段音乐（时间线绝对起点，可与其他音乐重叠）。音乐不影响场景缓存键。 */
function addMusic(g, { id, asset_ref, start_ms, duration_ms, src_in_ms = 0, volume = 1 }, opts) {
  const c = U.composeOf(g);
  if (!c) throw U.intentError('no compose node');
  if (!asset_ref) throw U.intentError('addMusic: asset_ref required');
  for (const [k, v] of [['start_ms', start_ms], ['duration_ms', duration_ms], ['src_in_ms', src_in_ms]]) {
    if (!Number.isInteger(v) || v < 0 || (k === 'duration_ms' && v === 0)) throw U.intentError(`addMusic: bad ${k}`);
  }
  const mid = id || U.makeAlloc(g)('mus');
  const music = [...(c.node.params.music || []), { id: mid, asset_ref, start_ms, duration_ms, src_in_ms, volume }];
  return U.mkTx('addMusic', [{ op: 'setParam', node: c.id, path: ['music'], value: music }], opts, { music_id: mid });
}

module.exports = { trimSegment, moveSegment, splitSegment, deleteSegment, setTransition, addMusic };
