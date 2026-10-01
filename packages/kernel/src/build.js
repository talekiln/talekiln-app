'use strict';
// 造图工具：从剧本文字或“行 + 镜头”描述建一张合法的项目图（导入与测试用）。
const G = require('./graph');
const { applyTx } = require('./ops');
const U = require('./intents/util');
const { addShotOps } = require('./intents/shot');
const { addNodeAt } = require('./intents/canvas');

const speakerRe = /^([^：:（()#]{1,20})[：:]\s*(.+)$/;

/**
 * 解析剧本文字为场景组 + 行：
 * `# 标题` 开始新场景（标题同时记为一行 scene_heading）；`名字：台词` 为对白；
 * `△…` 或整行括号为动作；其余为旁白。空行忽略。
 */
function parseScript(text) {
  const scenes = [];
  let cur = null;
  const scene = (title) => { cur = { title, lines: [] }; scenes.push(cur); return cur; };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const title = line.replace(/^#+\s*/, '');
      scene(title).lines.push({ kind: 'scene_heading', speaker: '', text: title });
      continue;
    }
    if (!cur) scene('');
    let m;
    if (/^[△▲]/.test(line)) cur.lines.push({ kind: 'action', speaker: '', text: line.replace(/^[△▲]\s*/, '') });
    else if (/^[（(].*[）)]$/.test(line)) cur.lines.push({ kind: 'action', speaker: '', text: line.slice(1, -1) });
    else if ((m = speakerRe.exec(line))) cur.lines.push({ kind: 'dialogue', speaker: m[1].trim(), text: m[2].trim() });
    else cur.lines.push({ kind: 'narration', speaker: '', text: line });
  }
  return scenes;
}

/**
 * 从描述建图：scenes = [{ id?, title, lines:[{kind,speaker,text}], shots:[{ ...shot 参数, legacy_id?, lines:[行下标...] }] }]。
 * 默认带一个 compose 节点；ids 全部确定性分配（line_1.. shot_1.. img_1.. vid_1.. nar_1.. e_1.. seg_1..）。
 */
function buildGraph({ project_id = null, scenes = [], compose = true } = {}) {
  let n = 0;
  const step = (g, tx) => applyTx(g, { ...tx, tx_id: `build:${++n}` }).graph;
  let g = G.emptyGraph(project_id);

  // 先建组与行（单个事务）
  const ops = [];
  const lineIds = scenes.map(() => []);
  let lineNo = 0;
  const gids = scenes.map((s, si) => s.id || `grp_${si + 1}`);
  scenes.forEach((s, si) => {
    const gid = gids[si];
    const children = [];
    for (const l of s.lines || []) {
      const id = `line_${++lineNo}`;
      lineIds[si].push(id);
      children.push(id);
      ops.push({ op: 'addNode', node: { id, type: 'script_line', params: { kind: l.kind || 'narration', speaker: l.speaker || '', text: l.text || '' } } });
    }
    ops.push({ op: 'addGroup', group: { id: gid, title: s.title || '', children } });
  });
  g = step(g, { label: 'build lines', ops });

  if (compose) g = step(g, addNodeAt(g, 'compose', {}));
  scenes.forEach((s, si) => {
    for (const sh of s.shots || []) {
      const { lines, legacy_id, ...params } = sh;
      const alloc = U.makeAlloc(g);
      const { ops: shotOps } = addShotOps(g, alloc, { group: gids[si], params, lines: (lines || []).map((i) => lineIds[si][i]), legacy_id });
      g = step(g, { label: 'build shot', ops: shotOps });
    }
  });
  return g;
}

/** 从剧本文字建图（只有行，没有镜头；镜头由“生成分镜”之后再加）。 */
function buildGraphFromScript(projectId, text, opts = {}) {
  return buildGraph({ project_id: projectId, scenes: parseScript(text), compose: opts.compose !== false });
}

module.exports = { parseScript, buildGraph, buildGraphFromScript };
