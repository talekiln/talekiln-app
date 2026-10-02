'use strict';
/**
 * 导演模式的提示词与上下文（纯函数，无 IO）。
 *   buildContext(graph)       紧凑的项目上下文：场景组、镜头（id / 序号 / 标题 / 时长 / 状态 / 行 / 片段 / 节点）、剧本行、时间线片段
 *   buildMessages(ctx, msg)   system + user 两条消息；system 里带动作清单与 JSON 输出契约
 *   repairMessages(text, errs) 计划不合法时的修正回合（把模型自己的输出和问题清单一起喂回去）
 */
const kernel = require('@talekiln/kernel');
const { allowedIntents, describeIntent } = require('./intentSchemas');

const TEXT_LIMIT = 200;
const PROMPT_LIMIT = 160;

const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

/** 紧凑上下文。只放模型做决定需要的字段；id 原样给出，模型必须照抄。 */
function buildContext(graph) {
  const g = graph;
  const shots = kernel.shotView(g);
  const script = kernel.scriptView(g);
  const timeline = kernel.timelineView(g);
  const segById = {};
  for (const c of timeline.tracks.find((t) => t.kind === 'video').clips) segById[c.id] = c;
  const nums = {};
  let n = 0;
  for (const grp of shots.groups) for (const s of grp.shots) nums[s.id] = ++n;
  const groups = g.group_order.map((gid) => ({ id: gid, title: g.groups[gid].title }));
  const shotList = shots.groups.flatMap((grp) => grp.shots.map((s) => {
    const p = s.params;
    const parts = kernel.partsOfShot(g, s.id);
    const segs = kernel.segmentsOfShot(g, s.id).map((seg) => ({ id: seg.id, in_ms: seg.in_ms, out_ms: seg.out_ms, gap_before_ms: seg.gap_before_ms, transition: seg.transition }));
    return {
      id: s.id, no: nums[s.id], group: grp.id, title: p.title || '', description: cut(p.description, TEXT_LIMIT),
      location: p.location || '', shot_type: p.shot_type || '', angle: p.angle || '', movement: p.movement || '',
      image_prompt: cut(p.image_prompt, PROMPT_LIMIT), video_prompt: cut(p.video_prompt, PROMPT_LIMIT), characters: p.characters || [],
      duration_ms: s.planned_ms, used_ms: s.used_ms, dialogue: cut(s.dialogue, TEXT_LIMIT), line_ids: s.line_ids,
      state: { image: s.image, video: s.video, narration: s.narration },
      nodes: { image: parts.image, video: parts.video, narration: parts.narration },
      segments: segs,
    };
  }));
  const lines = script.groups.flatMap((grp) => grp.lines.map((l) => ({ id: l.id, group: grp.id, kind: l.kind, speaker: l.speaker, text: cut(l.text, TEXT_LIMIT), shot_ids: l.shot_ids })));
  return { groups, shots: shotList, lines, total_ms: timeline.duration_ms, shot_count: shotList.length };
}

const SYSTEM = `你是一部 AI 短剧的导演助理。用户用自然语言提出修改要求，你把它翻译成一份"执行计划"，由本地程序校验后在项目图上执行。

规则：
1. 只能使用下面"可用动作"清单里的动作；每一步的 view 与 name 必须逐字取自清单（如 view "shot"、name "setShotField"）。清单外的动作、编造的参数一律会被拒绝。
2. 所有 id（镜头、行、场景组、片段、节点）必须逐字照抄上下文里给出的值，不要自己编 id，也不要用序号代替 id。
3. 时长单位是毫秒整数（3 秒 = 3000）。
4. 花费意识：镜头字段与台词行都是生成的输入——改镜头任何字段（描述 / 提示词 / 角色 / 时长…）、改台词文字、拆镜、合镜、新增镜头、换种子，都会让相关镜头已生成的图或视频过期（重新生成要花钱）；只改镜头顺序、裁剪、移动片段、转场不花钱。能不花钱达到目的就不要花钱，能只改一个镜头就不要碰别的镜头。
5. 步骤按执行顺序排列，尽量少而准；同一镜头的多个字段放进同一步 setShotField 的 patch 里。
6. 没有把握、信息不足、或要求超出可用动作时，steps 给空数组并在 summary 里说明原因。
7. summary、reason、untouched 用中文。untouched 列出你有意不改动的东西（例如"其余镜头的画面与台词不变"）。

输出契约：只输出一个 JSON 对象，不要任何解释文字、不要 Markdown 代码块：
{"summary": "一句话概括这次修改", "steps": [{"view": "shot", "name": "setShotField", "args": {...}, "reason": "为什么这样改"}], "untouched": ["不会改动的内容"]}

可用动作（* 为必填参数；类型后的 {…} 列出对象允许的键，<a|b> 为可选取值）：
`;

/** system + user。ctx 来自 buildContext。 */
function buildMessages(ctx, message, { intents = allowedIntents() } = {}) {
  const system = SYSTEM + intents.map(describeIntent).join('\n');
  const user = [
    '项目上下文（JSON）：',
    JSON.stringify(ctx),
    '',
    `用户要求：${String(message).trim()}`,
    '',
    '请输出执行计划 JSON。',
  ].join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** 修正回合：把模型上一次的输出与问题清单一起喂回去，要求重新输出完整 JSON。 */
function repairMessages(previousText, errors) {
  return [
    { role: 'assistant', content: String(previousText || '') },
    { role: 'user', content: `上面的执行计划有以下问题，请修正后重新输出完整的 JSON（只输出 JSON）：\n${errors.slice(0, 15).map((e) => `- ${e}`).join('\n')}` },
  ];
}

module.exports = { buildContext, buildMessages, repairMessages, SYSTEM, TEXT_LIMIT, PROMPT_LIMIT };
