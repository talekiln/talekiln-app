'use strict';
/**
 * Storyboard table produced by D02 and consumed by D03 (分镜列表), D04 (角色与场景库), F01/F02.
 *
 * {
 *   title, logline,
 *   characters: [{ id: 'c1', name, appearance }],
 *   scenes:     [{ id: 's1', name, description }],
 *   shots: [{
 *     no, sceneId, characterIds: [],
 *     visual,            // 画面描述（中文，给人看）
 *     camera,            // 景别与运镜
 *     dialogue: { speaker: 'narrator' | characterId, text } | null,
 *     durationSec,
 *     imagePrompt,       // 首帧提示词（给图像模型）
 *     videoPrompt,       // 动态提示词（给视频模型）
 *   }]
 * }
 */

const LIMITS = Object.freeze({
  minShots: 3,
  maxShots: 20,
  minShotSec: 2,
  maxShotSec: 10,
  durationTolerance: 0.2, // total may differ from the target by ±20%
  charsPerSec: 5,         // spoken Chinese, about 4-5 characters per second
});

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;

/** Count characters that take speaking time (CJK, letters, digits); punctuation and spaces are free. */
function spokenLength(text) {
  const m = String(text || '').match(/[\p{Script=Han}\p{L}\p{N}]/gu);
  return m ? m.length : 0;
}

/**
 * Validate and normalise. Never throws; returns { ok, errors: string[], value }.
 * Errors are short Chinese sentences, fed back to the model on repair retries.
 * @param {object} raw
 * @param {{targetDurationSec?: number}} opts
 */
function validateStoryboard(raw, opts = {}) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['顶层必须是 JSON 对象'], value: null };

  const value = {
    title: isStr(raw.title) ? raw.title.trim() : '',
    logline: isStr(raw.logline) ? raw.logline.trim() : '',
    characters: [],
    scenes: [],
    shots: [],
  };
  if (!value.title) err('缺少 title');

  const charIds = new Set();
  for (const [i, c] of (Array.isArray(raw.characters) ? raw.characters : []).entries()) {
    if (!c || !isStr(c.id) || !isStr(c.name)) { err(`characters[${i}] 需要 id 和 name`); continue; }
    if (charIds.has(c.id)) err(`角色 id 重复：${c.id}`);
    charIds.add(c.id);
    value.characters.push({ id: c.id.trim(), name: c.name.trim(), appearance: isStr(c.appearance) ? c.appearance.trim() : '' });
  }
  if (!Array.isArray(raw.characters)) err('缺少 characters 数组（没有角色时给空数组）');

  const sceneIds = new Set();
  for (const [i, s] of (Array.isArray(raw.scenes) ? raw.scenes : []).entries()) {
    if (!s || !isStr(s.id) || !isStr(s.name)) { err(`scenes[${i}] 需要 id 和 name`); continue; }
    if (sceneIds.has(s.id)) err(`场景 id 重复：${s.id}`);
    sceneIds.add(s.id);
    value.scenes.push({ id: s.id.trim(), name: s.name.trim(), description: isStr(s.description) ? s.description.trim() : '' });
  }
  if (!value.scenes.length) err('scenes 至少需要 1 个场景');

  const shots = Array.isArray(raw.shots) ? raw.shots : [];
  if (shots.length < LIMITS.minShots || shots.length > LIMITS.maxShots) {
    err(`镜头数应在 ${LIMITS.minShots}-${LIMITS.maxShots} 之间，当前 ${shots.length}`);
  }
  let total = 0;
  shots.forEach((s, i) => {
    const no = i + 1;
    const tag = `第 ${no} 镜`;
    if (!s || typeof s !== 'object') { err(`${tag} 不是对象`); return; }
    const durationSec = Number(s.durationSec);
    if (!Number.isFinite(durationSec) || durationSec < LIMITS.minShotSec || durationSec > LIMITS.maxShotSec) {
      err(`${tag} durationSec 应在 ${LIMITS.minShotSec}-${LIMITS.maxShotSec} 秒之间`);
    }
    total += Number.isFinite(durationSec) ? durationSec : 0;
    if (!isStr(s.sceneId) || !sceneIds.has(s.sceneId)) err(`${tag} 的 sceneId 不在 scenes 中`);
    const characterIds = Array.isArray(s.characterIds) ? s.characterIds.filter(isStr) : [];
    for (const id of characterIds) if (!charIds.has(id)) err(`${tag} 引用了不存在的角色 ${id}`);
    if (!isStr(s.visual)) err(`${tag} 缺少 visual`);
    if (!isStr(s.imagePrompt)) err(`${tag} 缺少 imagePrompt`);
    if (!isStr(s.videoPrompt)) err(`${tag} 缺少 videoPrompt`);
    let dialogue = null;
    if (s.dialogue && isStr(s.dialogue.text)) {
      const speaker = isStr(s.dialogue.speaker) ? s.dialogue.speaker.trim() : 'narrator';
      if (speaker !== 'narrator' && !charIds.has(speaker)) err(`${tag} 台词说话人 ${speaker} 不存在`);
      const len = spokenLength(s.dialogue.text);
      if (Number.isFinite(durationSec) && len > Math.ceil(durationSec * LIMITS.charsPerSec)) {
        err(`${tag} 台词 ${len} 字，${durationSec} 秒念不完（每秒最多 ${LIMITS.charsPerSec} 字），请缩短台词或加长时长`);
      }
      dialogue = { speaker, text: s.dialogue.text.trim() };
    }
    value.shots.push({
      no,
      sceneId: isStr(s.sceneId) ? s.sceneId : '',
      characterIds,
      visual: isStr(s.visual) ? s.visual.trim() : '',
      camera: isStr(s.camera) ? s.camera.trim() : '',
      dialogue,
      durationSec: Number.isFinite(durationSec) ? durationSec : 0,
      imagePrompt: isStr(s.imagePrompt) ? s.imagePrompt.trim() : '',
      videoPrompt: isStr(s.videoPrompt) ? s.videoPrompt.trim() : '',
    });
  });

  const target = Number(opts.targetDurationSec);
  if (Number.isFinite(target) && target > 0 && shots.length) {
    const lo = Math.floor(target * (1 - LIMITS.durationTolerance));
    const hi = Math.ceil(target * (1 + LIMITS.durationTolerance));
    if (total < lo || total > hi) err(`总时长 ${total} 秒，应在 ${lo}-${hi} 秒之间（目标 ${target} 秒）`);
  }
  value.totalDurationSec = total;
  return { ok: errors.length === 0, errors, value };
}

module.exports = { validateStoryboard, spokenLength, LIMITS };
