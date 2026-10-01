'use strict';
// 旧表适配（docs/kernel-design.md §6）：
//   importLegacy  一次性、幂等：episodes / storyboards / timelines -> 项目图（写进 project_graphs 快照）
//   materialize   每次提交后在同一 SQLite 事务里把图的投影写回 storyboards / timelines / timeline_*（只写由图派生的列）
const kernel = require('@talekiln/kernel');
const timelineService = require('../timeline/service');

const { KernelError, canonicalJSON, sha256 } = kernel;

const nowIso = () => new Date().toISOString();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SPEAKER_RE = /^([^：:（()#]{1,20})[：:]\s*(.+)$/;
const DEFAULT_SEC = kernel.DEFAULT_SHOT_MS / 1000;

const store = () => require('./store');
const text = (v) => (v == null ? '' : String(v));
const splitLines = (v) => text(v).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

function parseJsonArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch (_) { return []; }
}

// ---------------------------------------------------------------- import

function shotLines(row) {
  const out = [];
  for (const t of splitLines(row.action)) out.push({ kind: 'action', speaker: '', text: t });
  for (const t of splitLines(row.narration)) out.push({ kind: 'narration', speaker: '', text: t });
  for (const t of splitLines(row.dialogue)) {
    const m = SPEAKER_RE.exec(t);
    out.push({ kind: 'dialogue', speaker: m ? m[1].trim() : '', text: t }); // 文字保留整行（含说话人），物化时逐字写回
  }
  return out;
}

function shotParams(row) {
  const p = {
    title: text(row.title), description: text(row.description), location: text(row.location), time: text(row.time),
    shot_type: text(row.shot_type), angle: text(row.angle), movement: text(row.movement),
    image_prompt: text(row.image_prompt), video_prompt: text(row.video_prompt),
    characters: parseJsonArray(row.characters),
    duration_ms: row.duration > 0 ? Math.round(row.duration * 1000) : kernel.DEFAULT_SHOT_MS,
  };
  if (text(row.atmosphere)) p.atmosphere = row.atmosphere;
  return p;
}

/** 把连续且 (segment_index, segment_title) 相同的镜头归为一个场景组。 */
function sceneRuns(rows) {
  const runs = [];
  for (const row of rows) {
    const key = `${row.segment_index ?? 0}|${text(row.segment_title)}`;
    const last = runs[runs.length - 1];
    if (last && last.key === key) last.rows.push(row);
    else runs.push({ key, title: text(row.segment_title), rows: [row] });
  }
  return runs;
}

/**
 * 纯函数：旧表行 -> 项目图。
 * - 剧本按行切成 script_line；与镜头对白/旁白/动作逐字相同的行并入镜头的行（不重复），其余放进“剧本”组；
 * - 每个镜头的 dialogue / narration / action 列切回行并连 derives 边；
 * - video_url / 图片 / 旁白音频作为采用版本；timelines 的视频轨 -> compose.segments，音乐轨 -> compose.music。
 */
function buildGraphFromRows({ episode, storyboards, timeline }) {
  const T = (s) => s.trim();
  const rows = storyboards;
  const runs = sceneRuns(rows);
  const perShot = new Map(rows.map((r) => [r.id, shotLines(r)]));

  // 剧本里和镜头行逐字相同的行并入镜头
  const pool = new Map();
  for (const ls of perShot.values()) for (const l of ls) pool.set(T(l.text), (pool.get(T(l.text)) || 0) + 1);
  const scriptLines = [];
  for (const sc of kernel.parseScript(text(episode.script_content))) {
    for (const l of sc.lines) {
      const n = pool.get(T(l.text)) || 0;
      if (n > 0) pool.set(T(l.text), n - 1);
      else scriptLines.push(l);
    }
  }

  const scenes = [];
  if (scriptLines.length) scenes.push({ id: 'grp_script', title: '剧本', lines: scriptLines, shots: [] });
  runs.forEach((run, i) => {
    const lines = [];
    const shots = run.rows.map((row) => {
      const idx = perShot.get(row.id).map((l) => lines.push(l) - 1);
      return { ...shotParams(row), legacy_id: row.id, lines: idx };
    });
    scenes.push({ id: `grp_${i + 1}`, title: run.title, lines, shots });
  });

  let g = kernel.buildGraph({ project_id: String(episode.id), scenes, compose: true });
  const cid = kernel.composeId(g);
  const shotOrder = kernel.shotOrder(g);
  const byLegacy = new Map(shotOrder.map((id) => [g.nodes[id].legacy_id, id]));

  // timelines -> compose.segments / music
  const defaults = g.nodes[cid].params.segments;
  const legacyClips = new Map();
  let music = [];
  if (timeline) {
    for (const t of timeline.tracks) {
      if (t.kind === 'video') {
        for (const c of [...t.clips].sort((a, b) => a.start_ms - b.start_ms)) {
          if (c.storyboard_id == null || !byLegacy.has(c.storyboard_id)) continue;
          const list = legacyClips.get(c.storyboard_id) || [];
          list.push(c);
          legacyClips.set(c.storyboard_id, list);
        }
      } else if (t.kind === 'music') {
        music = t.clips.filter((c) => c.asset_ref).map((c) => ({
          id: c.id, asset_ref: c.asset_ref, start_ms: c.start_ms, duration_ms: c.duration_ms, src_in_ms: c.src_in_ms ?? 0, volume: c.volume ?? 1,
        }));
      }
    }
  }
  const segments = [];
  let cursor = 0;
  for (const shotId of shotOrder) {
    const node = g.nodes[shotId];
    const clips = legacyClips.get(node.legacy_id);
    if (!clips) {
      for (const s of defaults.filter((d) => d.shot_id === shotId)) {
        segments.push({ ...s, gap_before_ms: 0 });
        cursor += s.out_ms - s.in_ms;
      }
      continue;
    }
    const dur = node.params.duration_ms;
    for (const c of clips) {
      const inMs = Math.min(c.src_in_ms ?? 0, dur - 1);
      const outMs = Math.max(inMs + 1, Math.min(c.src_out_ms ?? inMs + c.duration_ms, dur));
      const gap = timeline ? Math.max(0, c.start_ms - cursor) : 0;
      const transition = c.style && typeof c.style.transition === 'string' ? c.style.transition : null;
      segments.push({ id: c.id, shot_id: shotId, in_ms: inMs, out_ms: outMs, gap_before_ms: gap, transition });
      cursor += gap + (outMs - inMs);
    }
  }
  g = kernel.applyTx(g, {
    tx_id: 'import:compose', label: 'import timeline',
    ops: [{ op: 'setComposeSegments', node: cid, segments }, { op: 'setParam', node: cid, path: ['music'], value: music }],
  }).graph;

  // 已有产物 -> 采用版本（cacheKey 取当前值，所以导入后是 fresh；hash 是引用字符串的摘要，不读文件）
  const keys = kernel.cacheKeys(g);
  const ops = [];
  const adopt = (nodeId, ref, kind) => {
    if (!nodeId || !ref) return;
    ops.push({ op: 'addVersion', node: nodeId, version: { id: 'legacy_1', cache_key: keys[nodeId], asset: { ref, kind, hash: sha256(`ref:${ref}`) }, source: 'legacy-import' } });
    ops.push({ op: 'adoptVersion', node: nodeId, version_id: 'legacy_1' });
  };
  for (const row of rows) {
    const parts = kernel.partsOfShot(g, byLegacy.get(row.id));
    adopt(parts.video, row.video_url, 'video');
    adopt(parts.image, row.local_path || row.image_url, 'image');
    adopt(parts.narration, row.narration_audio_local_path || row.audio_local_path, 'audio');
  }
  if (ops.length) g = kernel.applyTx(g, { tx_id: 'import:versions', label: 'import assets', ops }).graph;
  return g;
}

/** 导入旧表数据为项目图。幂等：已有项目图则原样返回（不覆盖）。 */
function importLegacy(db, episodeId) {
  const ep = Number(episodeId);
  return db.transaction(() => {
    const s = store();
    if (s.hasProject(db, ep)) {
      const { graph } = s.openProject(db, ep);
      return { created: false, ...counts(graph) };
    }
    const episode = db.prepare('SELECT * FROM episodes WHERE id = ? AND deleted_at IS NULL').get(ep);
    if (!episode) throw new KernelError('NOT_FOUND', `episode not found: ${episodeId}`);
    const storyboards = db.prepare('SELECT * FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number, id').all(ep);
    const timeline = timelineService.loadTimelineByEpisode(db, ep);
    const graph = buildGraphFromRows({ episode, storyboards, timeline });
    s.initProject(db, ep, graph);
    return { created: true, ...counts(graph) };
  })();
}

function counts(g) {
  return { shots: kernel.nodesOfType(g, 'shot').length, lines: kernel.nodesOfType(g, 'script_line').length, groups: g.group_order.length };
}

// ---------------------------------------------------------------- materialize

const normText = (v) => text(v);
const normDur = (v) => (v > 0 ? v : DEFAULT_SEC);
const normChars = (v) => canonicalJSON(parseJsonArray(v));

const COLUMNS = [
  ['storyboard_number', (v) => Number(v) || 0],
  ['segment_index', (v) => Number(v) || 0],
  ['segment_title', normText],
  ['title', normText], ['description', normText], ['location', normText], ['time', normText],
  ['duration', normDur],
  ['dialogue', normText], ['narration', normText], ['action', normText], ['atmosphere', normText],
  ['image_prompt', normText], ['video_prompt', normText],
  ['characters', normChars],
  ['shot_type', normText], ['angle', normText], ['movement', normText],
];
const NULLABLE_EMPTY = new Set(['dialogue', 'narration', 'action', 'atmosphere']); // 空串写成 NULL，与旧代码一致

/**
 * 旧表 status 取值：schema 默认 'draft'，服务层新建为 'pending'，生成流程用 'processing' / 'completed' / 'failed'。
 * 图只表达“有没有采用的产物”：有 -> completed；没有且旧值是 completed -> 退回 pending；其余（draft/pending/processing/failed）保持，
 * 因为 processing/failed 属于队列/生成流程的运行态，不是图的事实。
 */
function deriveStatus(existing, hasAsset) {
  if (existing === 'processing' || existing === 'failed') return existing;
  if (hasAsset) return 'completed';
  return existing === 'completed' || !existing ? 'pending' : existing;
}

function shotRows(graph) {
  const { storyboards } = kernel.toLegacyRows(graph);
  const groupIndex = new Map();
  return storyboards.map((r) => {
    if (!groupIndex.has(r.scene_group_id)) groupIndex.set(r.scene_group_id, groupIndex.size);
    const lines = kernel.linesOfShot(graph, r.shot_id).map((id) => graph.nodes[id].params);
    const by = (kind) => lines.filter((p) => p.kind === kind).map((p) => p.text).join('\n');
    const parts = kernel.partsOfShot(graph, r.shot_id);
    const hasAsset = !!((parts.video && kernel.adoptedVersion(graph, parts.video)) || (parts.image && kernel.adoptedVersion(graph, parts.image)));
    const ia = parts.image && kernel.adoptedVersion(graph, parts.image);
    const imageRef = ia && ia.asset && ia.asset.ref ? String(ia.asset.ref) : null;
    return {
      ...r,
      image_ref: imageRef,
      segment_index: groupIndex.get(r.scene_group_id), segment_title: r.scene_title || '',
      dialogue: by('dialogue'), narration: by('narration'), action: by('action'),
      has_asset: hasAsset,
    };
  });
}

function writeStoryboards(db, ep, graph) {
  const ts = nowIso();
  const binds = {};
  const mapGet = db.prepare('SELECT storyboard_id FROM graph_legacy_map WHERE episode_id = ? AND node_id = ?');
  const mapSet = db.prepare('INSERT OR REPLACE INTO graph_legacy_map (episode_id, node_id, storyboard_id) VALUES (?, ?, ?)');
  const getRow = db.prepare('SELECT * FROM storyboards WHERE id = ? AND episode_id = ?');
  const live = new Set();

  for (const r of shotRows(graph)) {
    let id = r.legacy_id;
    let existing = id != null ? getRow.get(id, ep) : undefined;
    if (!existing) {
      const m = mapGet.get(ep, r.shot_id);
      if (m) { id = m.storyboard_id; existing = getRow.get(id, ep); }
    }
    const value = (col) => {
      const v = r[col];
      if (col === 'characters') return r.characters;
      if (NULLABLE_EMPTY.has(col) && (v === '' || v == null)) return null;
      return v;
    };
    if (!existing) {
      const cols = COLUMNS.map(([c]) => c);
      const info = db.prepare(
        `INSERT INTO storyboards (episode_id, ${cols.join(', ')}, video_url, status, created_at, updated_at) VALUES (?, ${cols.map(() => '?').join(', ')}, ?, ?, ?, ?)`
      ).run(ep, ...cols.map(value), r.video_url, deriveStatus(null, r.has_asset), ts, ts);
      id = Number(info.lastInsertRowid);
      mapSet.run(ep, r.shot_id, id);
      binds[r.shot_id] = id;
    } else {
      if (r.legacy_id !== id) binds[r.shot_id] = id; // 节点没有（或指向已不存在的行）：绑定到复用的行
      mapSet.run(ep, r.shot_id, id);
      const sets = [];
      const vals = [];
      for (const [col, norm] of COLUMNS) {
        if (norm(existing[col]) !== norm(r[col === 'characters' ? 'characters' : col])) { sets.push(`${col} = ?`); vals.push(value(col)); }
      }
      // video_url：图里没有采用视频时不清空（旧生成流程还会直接写这一列，见报告“绕过内核的旧写路径”）
      if (r.video_url && existing.video_url !== r.video_url) { sets.push('video_url = ?'); vals.push(r.video_url); }
      // 首帧图：采用的图片落到旧表的 local_path（存储目录内的相对路径）或 image_url（网络地址）；同样只增不清
      if (r.image_ref) {
        const rel = r.image_ref.startsWith('/static/') ? r.image_ref.slice('/static/'.length) : r.image_ref;
        const remote = /^(https?:|data:)/i.test(rel);
        if (remote ? existing.image_url !== rel : existing.local_path !== rel) {
          sets.push(remote ? 'image_url = ?' : 'local_path = ?'); vals.push(rel);
          if (remote && existing.local_path) sets.push('local_path = NULL'); // 页面优先读 local_path，旧值会盖住新图
        }
      }
      const status = deriveStatus(existing.status, r.has_asset);
      if (status !== existing.status) { sets.push('status = ?'); vals.push(status); }
      if (existing.deleted_at != null) sets.push('deleted_at = NULL');
      if (sets.length) db.prepare(`UPDATE storyboards SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, ts, id);
    }
    live.add(id);
  }

  // 图里已不存在的镜头 -> 软删除
  for (const row of db.prepare('SELECT id FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL').all(ep)) {
    if (!live.has(row.id)) db.prepare('UPDATE storyboards SET deleted_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, row.id);
  }
  return binds;
}

const clipId = (ep, id) => (UUID_RE.test(id) ? id : `e${ep}_${id}`); // timeline_clips.id 是全库主键，内核的确定性 id 需加前缀

function timelineSignature(tracks) {
  return canonicalJSON(tracks.map((t) => [t.kind, [...t.clips]
    .sort((a, b) => a.start_ms - b.start_ms || (a.id < b.id ? -1 : 1))
    .map((c) => [c.id, c.start_ms, c.duration_ms, c.src_in_ms ?? null, c.src_out_ms ?? null, c.asset_ref ?? null, c.asset_kind ?? null,
      c.storyboard_id ?? null, c.volume ?? 1, c.text ?? null, c.style ?? null])]));
}

function writeTimeline(db, ep, graph) {
  if (!kernel.composeId(graph) || !kernel.shotOrder(graph).length) return;
  const view = kernel.timelineView(graph);
  const existing = timelineService.loadTimelineByEpisode(db, ep);
  const old = existing ? Object.fromEntries(existing.tracks.map((t) => [t.kind, t])) : {};
  const tracks = view.tracks.map((t) => ({
    id: old[t.kind] ? old[t.kind].id : undefined, kind: t.kind, name: old[t.kind] ? old[t.kind].name : t.kind,
    volume: old[t.kind] ? old[t.kind].volume : 1, muted: old[t.kind] ? old[t.kind].muted : false,
    clips: t.clips.map((c) => ({ ...c, id: clipId(ep, c.id) })),
  }));
  if (existing && timelineSignature(existing.tracks) === timelineSignature(tracks)) return;
  timelineService.saveTimeline(db, { id: existing ? existing.id : undefined, episode_id: ep, tracks });
}

/**
 * 把图的投影写回旧表（调用方应在一个 SQLite 事务里，store.commit 就是）。
 * 返回 { binds }：图里没有 legacy_id 的镜头新插入（或复用）的 storyboards.id，由 store 写进日志并绑定到节点。
 * 不修改 graph。
 */
function materialize(db, episodeId, graph) {
  const ep = Number(episodeId);
  return db.transaction(() => {
    const binds = writeStoryboards(db, ep, graph);
    // 时间线视图用 shot.legacy_id 作 storyboard_id：新绑定的镜头要用绑定后的 id
    if (Object.keys(binds).length) {
      graph = structuredClone(graph);
      for (const [sid, lid] of Object.entries(binds)) graph.nodes[sid].legacy_id = lid;
    }
    writeTimeline(db, ep, graph);
    return { binds };
  })();
}

module.exports = { importLegacy, materialize, buildGraphFromRows, deriveStatus };
