'use strict';
// 样例故事加载、转成内核输入、建图、“生成”（给生成类节点采用版本）。见 fixtures/stories/README.md。
const fs = require('node:fs');
const path = require('node:path');
const K = require('../../src');
const O = require('./oracle');

const DIR = path.join(__dirname, 'fixtures', 'stories');

/** 分镜表（scriptgen 输出）-> { scenes:[{title, lines, shots}] }，规则见 README。 */
function convertStoryboard(sb) {
  const nameOf = Object.fromEntries(sb.characters.map((c) => [c.id, c.name]));
  const sceneOf = Object.fromEntries(sb.scenes.map((s) => [s.id, s]));
  const scenes = sb.scenes.map((s) => ({ id: s.id, title: s.name, lines: [{ kind: 'scene_heading', speaker: '', text: s.name }], shots: [], desc: s.description }));
  const byId = Object.fromEntries(scenes.map((s) => [s.id, s]));
  sb.shots.forEach((sh, i) => {
    const sc = byId[sh.sceneId];
    const idxs = [];
    if (!sc.shots.length) idxs.push(0); // 场景标题行挂到该场景第一个镜头
    if (sh.dialogue && sh.dialogue.text) {
      const narr = sh.dialogue.speaker === 'narrator';
      sc.lines.push({ kind: narr ? 'narration' : 'dialogue', speaker: narr ? '' : (nameOf[sh.dialogue.speaker] || sh.dialogue.speaker), text: sh.dialogue.text });
      idxs.push(sc.lines.length - 1);
    }
    if (!sh.dialogue || !sh.dialogue.text || i % 3 === 2) {
      sc.lines.push({ kind: 'action', speaker: '', text: sh.visual });
      idxs.push(sc.lines.length - 1);
    }
    sc.shots.push({
      title: sh.visual.slice(0, 12), description: sh.visual, location: sceneOf[sh.sceneId].name, shot_type: sh.camera,
      image_prompt: sh.imagePrompt, video_prompt: sh.videoPrompt, characters: sh.characterIds.map((c) => nameOf[c] || c),
      duration_ms: Math.round(sh.durationSec * 1000), legacy_id: 1000 + i + 1, lines: idxs,
    });
  });
  return scenes.map(({ id, desc, ...rest }) => rest);
}

function loadStories() {
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    const scenes = raw.scenes || convertStoryboard(raw.storyboard);
    return { id: raw.id, origin: raw.origin, scenes, raw };
  });
}

/** 渲染成 parseScript 能读的剧本文字：每场景 `# 标题`，场景标题行由 `#` 产生，其余按 kind 渲染。 */
function scriptText(story) {
  const out = [];
  for (const sc of story.scenes) {
    out.push(`# ${sc.title}`);
    for (const l of sc.lines) {
      if (l.kind === 'scene_heading') continue;
      if (l.kind === 'dialogue') out.push(`${l.speaker}：${l.text}`);
      else if (l.kind === 'action') out.push(`△${l.text}`);
      else out.push(l.text);
    }
  }
  return out.join('\n');
}

let seq = 0;
/** 给若干生成类节点“生成”一个版本并采用（一个事务）。asset.hash = 预言机内容签名，ref 为确定性占位路径。 */
function generateTx(g, ids, opts = {}) {
  const sigs = O.signatures(g);
  const ops = [];
  for (const id of ids) {
    const n = (g.versions[id] || []).length + 1;
    const vid = `v_${n}`;
    const type = g.nodes[id].type;
    const kind = { image: 'image', video: 'video', narration: 'audio', compose: 'video' }[type];
    const t = K.intents.shot.recordGeneration(g, id, { version_id: vid, asset: { ref: `asset/${id}.${vid}.bin`, hash: sigs[id], kind } });
    ops.push(...t.ops);
  }
  return { tx_id: opts.tx_id || `gen:${++seq}`, label: 'generate', ops };
}

/** 把整张图的生成类节点全部生成一遍（全新鲜）。 */
function adoptEverything(g) {
  const ids = Object.keys(g.nodes).filter((id) => O.GENERATED.includes(g.nodes[id].type)).sort();
  return K.applyTx(g, generateTx(g, ids, { tx_id: 'setup:generate-all' })).graph;
}

/**
 * 故事 -> 初始图：剧本文字建行（buildGraph 的场景/行部分）、再用 addShot 意图“生成分镜”，最后全部采用。
 * 返回规范 JSON 字符串（每次执行 fromJSON 得到独立副本）。
 */
const cache = new Map();
function preparedJSON(story) {
  if (cache.has(story.id)) return cache.get(story.id);
  const g = adoptEverything(K.buildGraph({ project_id: `proj-${story.id}`, scenes: story.scenes }));
  const json = K.toJSON(g);
  cache.set(story.id, json);
  return json;
}
const prepared = (story) => K.fromJSON(preparedJSON(story));

/** 没有 compose 节点的版本（项目刚从剧本生成分镜、还没进时间线）：生成类节点全部采用。 */
function preparedNoCompose(story) {
  return adoptEverything(K.buildGraph({ project_id: `proj-${story.id}`, scenes: story.scenes, compose: false }));
}

module.exports = { preparedNoCompose, loadStories, convertStoryboard, scriptText, generateTx, adoptEverything, preparedJSON, prepared };
