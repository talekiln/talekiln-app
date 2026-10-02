'use strict';
// 投影：graph -> 视图模型，纯函数，不存任何东西。
const G = require('./graph');
const { cacheKeys, nodeState, staleSet } = require('./invalidation');

// 视图里的 params/style 用键排序的副本：快照重载（规范 JSON）前后，视图逐字节相同
const plain = (v) => (v === undefined ? v : JSON.parse(G.canonicalJSON(v)));
const short = (k) => (k ? k.slice(0, 12) : null);
const TRACKS = ['video', 'subtitle', 'narration', 'music'];

function stateOf(g, id, keys) {
  if (!id) return 'none';
  return nodeState(g, id, keys);
}

/** 剧本视图：场景组 -> 有序行，每行带关联镜头 id 列表。 */
function scriptView(g) {
  return {
    groups: g.group_order.map((gid) => ({
      id: gid,
      title: g.groups[gid].title,
      lines: g.groups[gid].children.filter((c) => g.nodes[c].type === 'script_line').map((id) => {
        const p = g.nodes[id].params;
        return { id, kind: p.kind, speaker: p.speaker ?? '', text: p.text, shot_ids: G.shotsOfLine(g, id) };
      }),
    })),
  };
}

/** 采用版本的 metadata.duration_ms（正整数）或 null。 */
function metaDuration(g, nodeId) {
  const v = nodeId && G.adoptedVersion(g, nodeId);
  const d = v && v.metadata ? v.metadata.duration_ms : null;
  return Number.isInteger(d) && d > 0 ? d : null;
}

/** 镜头视频的真实片长（采用的 video 版本 metadata.duration_ms，由生成写回时记录）；未知为 null。 */
function realVideoMs(g, shotId) {
  return metaDuration(g, G.partsOfShot(g, shotId).video);
}

/**
 * 镜头的有效片段：存的 segments 是相对“目标时长”的；已知真实片长 R 时投影到 R 上：
 * 到末尾（out == 目标时长）的片段延伸/收缩到 R，其余裁到 R 以内。不改存储，只改投影。
 */
function effectiveSegments(g, shotId) {
  const segs = G.segmentsOfShot(g, shotId);
  const R = realVideoMs(g, shotId);
  if (!R) return segs;
  const T = g.nodes[shotId].params.duration_ms ?? G.DEFAULT_SHOT_MS;
  return segs.map((s) => {
    const inMs = Math.min(s.in_ms, R - 1);
    const outMs = s.out_ms === T ? R : Math.min(s.out_ms, R);
    return { ...s, in_ms: inMs, out_ms: Math.max(outMs, inMs + 1) };
  });
}

/** 一个镜头的使用时长：各有效片段（out-in）之和；没有片段时退回生成时长。 */
function usedMs(g, shotId) {
  const segs = effectiveSegments(g, shotId);
  return segs.length ? segs.reduce((a, s) => a + (s.out_ms - s.in_ms), 0) : g.nodes[shotId].params.duration_ms ?? G.DEFAULT_SHOT_MS;
}

/** 分镜视图：场景组 -> 有序镜头；对白是关联行文字拼接，状态与 cacheKey 摘要来自失效计算。 */
function shotView(g) {
  const keys = cacheKeys(g);
  const sceneKeyOf = sceneKeys(g);
  return {
    groups: g.group_order.map((gid) => ({
      id: gid,
      title: g.groups[gid].title,
      shots: g.groups[gid].children.filter((c) => g.nodes[c].type === 'shot').map((id) => {
        const n = g.nodes[id];
        const parts = G.partsOfShot(g, id);
        const segs = G.segmentsOfShot(g, id);
        return {
          id,
          legacy_id: n.legacy_id ?? null,
          params: plain(n.params),
          dialogue: G.shotDialogue(g, id),
          line_ids: G.linesOfShot(g, id),
          planned_ms: n.params.duration_ms ?? G.DEFAULT_SHOT_MS,
          real_ms: realVideoMs(g, id),
          used_ms: usedMs(g, id),
          segment_count: segs.length,
          image: stateOf(g, parts.image, keys),
          video: stateOf(g, parts.video, keys),
          narration: stateOf(g, parts.narration, keys),
          keys: { shot: short(keys[id]), image: short(keys[parts.image]), video: short(keys[parts.video]), narration: short(keys[parts.narration]) },
          scene_key: sceneKeyOf[id],
        };
      }),
    })),
  };
}

function adoptedAsset(g, nodeId) {
  const v = nodeId && G.adoptedVersion(g, nodeId);
  return v && v.asset ? v.asset : null;
}

function clip(id, start, dur, extra) {
  return {
    id, start_ms: start, duration_ms: dur, src_in_ms: null, src_out_ms: null, asset_ref: null, asset_kind: null,
    storyboard_id: null, volume: 1, text: null, style: null, ...extra,
  };
}

/**
 * 时间线视图：与 F02 同形的四轨 JSON（毫秒整数，storyboard_id = shot.legacy_id），可直接交给 G02。
 * 起点由顺序 + gap_before_ms + 片段时长累加；字幕/配音按镜头第一个片段的起点、到最后一个片段的终点。
 * 没有 compose 节点时返回四条空轨。
 */
function timelineView(g) {
  return buildTimeline(g).view;
}

/** timelineView 与场景缓存键共用：同时返回每个镜头的视频/字幕/旁白片段及其素材身份（hash）。 */
function buildTimeline(g) {
  const perShot = {};
  const identity = (asset, kind) => (asset ? { kind, id: asset.hash ?? asset.ref ?? null } : null);
  const tracks = Object.fromEntries(TRACKS.map((k) => [k, { id: `track_${k}`, kind: k, name: k, volume: 1, muted: false, clips: [] }]));
  const cid = G.composeId(g);
  if (cid) {
    const params = g.nodes[cid].params;
    const overrides = params.subtitle_overrides || {};
    const keys = cacheKeys(g);
    let cursor = 0;
    for (const shotId of G.shotOrder(g)) {
      const shot = g.nodes[shotId];
      const sb = shot.legacy_id ?? null;
      const parts = G.partsOfShot(g, shotId);
      const va = adoptedAsset(g, parts.video);
      const ia = adoptedAsset(g, parts.image);
      const asset = va && va.ref ? { ref: va.ref, kind: 'video' } : ia && ia.ref ? { ref: ia.ref, kind: 'image' } : null;
      const rec = { video: [], subtitle: [], narration: [], src: va && va.ref ? identity(va, 'video') : ia && ia.ref ? identity(ia, 'image') : null };
      perShot[shotId] = rec;
      let first = null;
      let last = null;
      for (const s of effectiveSegments(g, shotId)) {
        cursor += s.gap_before_ms;
        const dur = s.out_ms - s.in_ms;
        if (first === null) first = cursor;
        rec.video.push(s.id);
        tracks.video.clips.push(clip(s.id, cursor, dur, {
          src_in_ms: asset ? s.in_ms : null, src_out_ms: asset ? s.out_ms : null,
          asset_ref: asset ? asset.ref : null, asset_kind: asset ? asset.kind : null,
          storyboard_id: sb, style: s.transition ? { transition: s.transition } : null,
        }));
        cursor += dur;
        last = cursor;
      }
      if (first === null) continue;
      const span = last - first;
      const spoken = G.spokenLines(g, shotId);
      const text = G.shotDialogue(g, shotId).trim();
      const na = adoptedAsset(g, parts.narration);
      const nv = parts.narration && G.adoptedVersion(g, parts.narration);
      // 字幕：旁白新鲜（采用版本的 cacheKey 等于当前 key，即行文字没变）且版本带字幕块 -> 按词对齐的多条字幕；
      // 否则退回“整镜一条、文字取自行”的字幕。字幕文字的唯一事实源仍是 script_line；字幕块是该次配音的时间产物。
      const cues = nv && nv.metadata && Array.isArray(nv.metadata.cues) && nodeState(g, parts.narration, keys) === 'fresh' ? nv.metadata.cues : null;
      const subStyle = spoken.length && overrides[spoken[0]] ? plain(overrides[spoken[0]]) : null;
      if (text && cues && cues.length) {
        cues.forEach((c, i) => {
          const start = Math.max(0, Math.min(span, c.start_ms));
          const end = Math.max(start, Math.min(span, c.end_ms));
          if (end - start <= 0) return;
          rec.subtitle.push(`sub_${shotId}_${i + 1}`);
          tracks.subtitle.clips.push(clip(`sub_${shotId}_${i + 1}`, first + start, end - start, { storyboard_id: sb, text: c.text, style: subStyle }));
        });
      } else if (text) {
        rec.subtitle.push(`sub_${shotId}`);
        tracks.subtitle.clips.push(clip(`sub_${shotId}`, first, span, { storyboard_id: sb, text, style: subStyle }));
      }
      if (na && na.ref) {
        const audioMs = metaDuration(g, parts.narration);
        const nd = audioMs ? Math.min(span, audioMs) : span;
        rec.narration.push(`nar_${shotId}`);
        rec.narrationSrc = identity(na, 'audio');
        tracks.narration.clips.push(clip(`nar_${shotId}`, first, nd, {
          src_in_ms: 0, src_out_ms: nd, asset_ref: na.ref, asset_kind: 'audio', storyboard_id: sb,
        }));
      }
    }
    for (const m of params.music || []) {
      const inMs = m.src_in_ms ?? 0;
      tracks.music.clips.push(clip(m.id, m.start_ms, m.duration_ms, {
        src_in_ms: inMs, src_out_ms: inMs + m.duration_ms, asset_ref: m.asset_ref, asset_kind: 'audio', volume: m.volume ?? 1,
      }));
    }
  }
  const list = TRACKS.map((k) => tracks[k]);
  let duration = 0;
  for (const t of list) for (const c of t.clips) duration = Math.max(duration, c.start_ms + c.duration_ms);
  return { view: { duration_ms: duration, tracks: list }, perShot };
}

/**
 * 场景缓存键（对接 G02 render.plan，packages/core/src/plan.rs）：每个镜头一个键，等于“该镜头各视频片段在 G02 里的场景键所依据的字段”的摘要。
 * G02 把时间线按视频片段切成场景，场景键 = 渲染器版本 + 输出设置 + 视频（素材身份、srcIn/srcOut、音量）+
 * 与该场景时间重叠的字幕（相对起止、文字、样式——字幕是烧进画面的）+ 与之重叠的旁白（相对起点、时长、素材身份、srcIn、音量）。
 * 内核按同样的字段对每个片段取摘要：素材身份用采用版本的 asset.hash（没有 hash 退回 ref），时间用相对场景起点的毫秒。
 * 不含：音乐、gap（gap 是独立的空场景）、画布坐标、转场（G02 目前不渲染转场，也不进场景键）、输出设置（整片统一）。
 * 同一镜头的所有片段合成一个键，所以镜头里任何一个场景变了，这个键就变。
 */
function sceneKeys(g) {
  const { view, perShot } = buildTimeline(g);
  const byId = {};
  for (const t of view.tracks) for (const c of t.clips) byId[c.id] = c;
  const out = {};
  for (const shotId of G.nodesOfType(g, 'shot')) {
    const rec = perShot[shotId];
    const scenes = [];
    if (rec) {
      for (const vid of rec.video) {
        const v = byId[vid];
        const a = v.start_ms;
        const b = v.start_ms + v.duration_ms;
        const rel = (c) => {
          const s = Math.max(c.start_ms, a);
          const e = Math.min(c.start_ms + c.duration_ms, b);
          return e > s ? { s, e } : null;
        };
        scenes.push({
          src: rec.src, src_in_ms: v.src_in_ms, src_out_ms: v.src_out_ms, volume: v.volume,
          subtitles: rec.subtitle.map((id) => byId[id]).map((c) => { const o = rel(c); return o && { rel_start_ms: o.s - a, rel_end_ms: o.e - a, text: c.text, style: c.style }; }).filter(Boolean),
          narration: rec.narration.map((id) => byId[id]).map((c) => { const o = rel(c); return o && { rel_start_ms: o.s - a, dur_ms: o.e - o.s, src: rec.narrationSrc, src_in_ms: (c.src_in_ms ?? 0) + (o.s - c.start_ms), volume: c.volume }; }).filter(Boolean),
        });
      }
    }
    out[shotId] = G.sha256(G.canonicalJSON({ scenes }));
  }
  return out;
}
const sceneKey = (g, shotId) => sceneKeys(g)[shotId];

const COLUMN = { script_line: 0, shot: 1, image: 2, narration: 2, video: 3, compose: 4 };
/** 未存 layout 的节点用确定性的分栏自动布局（只用于显示，不写回图）。 */
function autoLayout(g) {
  const shots = G.shotOrder(g);
  const sIdx = G.indexMap(shots);
  const lIdx = G.indexMap(G.lineOrder(g));
  const owner = (id) => {
    for (const e of g.edges) if (e.to.node === id && g.nodes[e.from.node].type === 'shot') return e.from.node;
    return null;
  };
  const pos = {};
  for (const id of Object.keys(g.nodes)) {
    const n = g.nodes[id];
    let row = 0;
    if (n.type === 'script_line') row = lIdx[id];
    else if (n.type === 'shot') row = sIdx[id];
    else if (n.type !== 'compose') row = sIdx[owner(id)] ?? shots.length;
    pos[id] = { x: COLUMN[n.type] * 280, y: row * 140 + (n.type === 'narration' ? 60 : 0) };
  }
  return pos;
}

/** 画布视图：节点（含 layout、过期标记）、边、分组与折叠摘要。 */
function canvasView(g) {
  const keys = cacheKeys(g);
  const stale = new Set(staleSet(g, keys));
  const auto = autoLayout(g);
  const nodes = Object.keys(g.nodes).sort().map((id) => {
    const n = g.nodes[id];
    const stored = g.layout[id];
    return {
      id, type: n.type, legacy_id: n.legacy_id ?? null, params: plain(n.params),
      layout: stored ? { x: stored.x, y: stored.y } : auto[id], layout_auto: !stored,
      state: nodeState(g, id, keys), stale: stale.has(id), key: short(keys[id]), group: G.groupOf(g, id),
    };
  });
  const groups = g.group_order.map((gid) => {
    const ch = g.groups[gid].children;
    const shotIds = ch.filter((c) => g.nodes[c].type === 'shot');
    const members = [...ch];
    for (const s of shotIds) members.push(...Object.values(G.partsOfShot(g, s)).filter(Boolean));
    return {
      id: gid, title: g.groups[gid].title, children: [...ch],
      summary: {
        lines: ch.filter((c) => g.nodes[c].type === 'script_line').length,
        shots: shotIds.length,
        stale: members.filter((id) => stale.has(id)).length,
      },
    };
  });
  return { nodes, edges: plain(g.edges), groups, group_order: [...g.group_order] };
}

/** 供物化写回旧表：storyboards 行（按全项目顺序）+ timeline（F02 形状）。 */
function toLegacyRows(g) {
  const keys = cacheKeys(g);
  const storyboards = [];
  G.shotOrder(g).forEach((id, i) => {
    const n = g.nodes[id];
    const p = n.params;
    const parts = G.partsOfShot(g, id);
    const va = adoptedAsset(g, parts.video);
    const gid = G.groupOf(g, id);
    const action = G.linesOfShot(g, id).filter((l) => g.nodes[l].params.kind === 'action').map((l) => g.nodes[l].params.text).join('\n');
    storyboards.push({
      legacy_id: n.legacy_id ?? null, shot_id: id, scene_group_id: gid, scene_title: gid ? g.groups[gid].title : null,
      storyboard_number: i + 1, title: p.title ?? '', description: p.description ?? '', location: p.location ?? '', time: p.time ?? '',
      duration: (p.duration_ms ?? G.DEFAULT_SHOT_MS) / 1000, dialogue: G.shotDialogue(g, id), action,
      atmosphere: p.atmosphere ?? null, image_prompt: p.image_prompt ?? '', video_prompt: p.video_prompt ?? '',
      characters: JSON.stringify(p.characters ?? []), shot_type: p.shot_type ?? '', angle: p.angle ?? '', movement: p.movement ?? '',
      video_url: va && va.ref ? va.ref : null, status: stateOf(g, parts.video, keys) === 'fresh' ? 'completed' : 'draft',
    });
  });
  return { storyboards, timeline: timelineView(g) };
}

module.exports = { sceneKey, sceneKeys, buildTimeline, scriptView, shotView, timelineView, canvasView, toLegacyRows, autoLayout, usedMs, effectiveSegments, realVideoMs };
