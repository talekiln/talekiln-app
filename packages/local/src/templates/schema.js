'use strict';
/**
 * 模板包清单（manifest.json）的校验与派生（docs/phase3-templates.md §1）。
 * 纯函数：不碰数据库、不联网。云端 TemplateService 用同一套规则（zod 版本），签名摘要算法两边必须一致。
 */
const crypto = require('crypto');
const { canonicalJson } = require('../cloud/jws');

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const SLOT_RE = /^[a-z][a-z0-9_]{0,31}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const TIERS = ['free', 'pro'];
const LINE_KINDS = ['narration', 'dialogue', 'action'];
const BUILTIN_PLACEHOLDERS = ['scene', 'style'];
const MAX_SHOTS = 60;
const MAX_SLOTS = 12;
const MAX_TEXT = 4000;

const isStr = (v, max = MAX_TEXT) => typeof v === 'string' && v.length <= max;
const nonEmpty = (v, max) => isStr(v, max) && v.trim().length > 0;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** 提示词模板里出现的占位符名字（去重，按出现顺序）。 */
function placeholdersOf(text) {
  const out = [];
  for (const m of String(text || '').matchAll(PLACEHOLDER_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/**
 * 校验清单。返回 { ok, errors: [{ path, message }] }。错误信息面向用户（中文）。
 */
function validateManifest(m) {
  const errors = [];
  const err = (path, message) => errors.push({ path, message });
  if (!isObj(m)) return { ok: false, errors: [{ path: '', message: '清单必须是 JSON 对象' }] };

  if (!isStr(m.id, 64) || !ID_RE.test(m.id)) err('id', 'id 须为 2–64 位小写字母、数字、点、下划线或连字符');
  if (!nonEmpty(m.name, 100)) err('name', 'name 必填（≤100 字）');
  if (!isStr(m.version, 32) || !VERSION_RE.test(m.version)) err('version', 'version 须为 x.y.z 形式');
  if (!nonEmpty(m.genre, 40)) err('genre', 'genre 必填');
  if (!TIERS.includes(m.tier)) err('tier', "tier 须为 'free' 或 'pro'");
  if (m.description !== undefined && !isStr(m.description, 2000)) err('description', 'description 须为字符串（≤2000 字）');
  if (m.cover !== undefined && m.cover !== null && !isStr(m.cover, 1000)) err('cover', 'cover 须为字符串');
  if (m.music_hint !== undefined && m.music_hint !== null && !isStr(m.music_hint, 500)) err('music_hint', 'music_hint 须为字符串');
  if (m.signature !== undefined && m.signature !== null && !isStr(m.signature, 8192)) err('signature', 'signature 须为字符串');

  // 角色槽位
  const slotIds = new Set();
  if (!Array.isArray(m.character_slots)) err('character_slots', 'character_slots 须为数组（可为空）');
  else {
    if (m.character_slots.length > MAX_SLOTS) err('character_slots', `角色槽位最多 ${MAX_SLOTS} 个`);
    m.character_slots.forEach((s, i) => {
      const p = `character_slots[${i}]`;
      if (!isObj(s)) return err(p, '槽位须为对象');
      if (!isStr(s.id, 32) || !SLOT_RE.test(s.id)) err(`${p}.id`, '槽位 id 须为小写字母开头的字母数字下划线');
      else if (BUILTIN_PLACEHOLDERS.includes(s.id)) err(`${p}.id`, `槽位 id 不能用保留字 ${s.id}`);
      else if (slotIds.has(s.id)) err(`${p}.id`, `槽位 id 重复：${s.id}`);
      else slotIds.add(s.id);
      if (!nonEmpty(s.name, 50)) err(`${p}.name`, '槽位 name 必填');
      if (s.description !== undefined && !isStr(s.description, 1000)) err(`${p}.description`, 'description 须为字符串');
      if (s.appearance !== undefined && !isStr(s.appearance, 1000)) err(`${p}.appearance`, 'appearance 须为字符串');
      if (s.role !== undefined && !isStr(s.role, 50)) err(`${p}.role`, 'role 须为字符串');
    });
  }

  // 风格
  if (!isObj(m.style)) err('style', 'style 必填：{ name, prompt, preset?, aspect_ratio? }');
  else {
    if (!nonEmpty(m.style.name, 50)) err('style.name', 'style.name 必填');
    if (!nonEmpty(m.style.prompt, 2000)) err('style.prompt', 'style.prompt 必填');
    if (m.style.preset !== undefined && !isStr(m.style.preset, 50)) err('style.preset', 'style.preset 须为字符串');
    if (m.style.aspect_ratio !== undefined && !/^\d+:\d+$/.test(String(m.style.aspect_ratio))) err('style.aspect_ratio', 'aspect_ratio 须形如 9:16');
  }

  // 分镜
  if (!Array.isArray(m.shots) || !m.shots.length) err('shots', 'shots 至少一个');
  else {
    if (m.shots.length > MAX_SHOTS) err('shots', `分镜最多 ${MAX_SHOTS} 个`);
    m.shots.forEach((s, i) => {
      const p = `shots[${i}]`;
      if (!isObj(s)) return err(p, '分镜须为对象');
      if (!nonEmpty(s.title, 100)) err(`${p}.title`, 'title 必填');
      if (!Number.isInteger(s.duration_ms) || s.duration_ms <= 0 || s.duration_ms > 600_000) err(`${p}.duration_ms`, 'duration_ms 须为正整数毫秒（≤600000）');
      if (!nonEmpty(s.prompt_template, MAX_TEXT)) err(`${p}.prompt_template`, 'prompt_template 必填');
      if (s.scene_slot !== undefined && s.scene_slot !== null && !isStr(s.scene_slot, 500)) err(`${p}.scene_slot`, 'scene_slot 须为字符串');
      if (s.camera !== undefined && s.camera !== null && !isStr(s.camera, 200)) err(`${p}.camera`, 'camera 须为字符串');
      if (s.group !== undefined && s.group !== null && !isStr(s.group, 100)) err(`${p}.group`, 'group 须为字符串');
      const declared = Array.isArray(s.character_slots) ? s.character_slots : null;
      if (!declared) err(`${p}.character_slots`, 'character_slots 须为数组（可为空）');
      else {
        for (const id of declared) if (!slotIds.has(id)) err(`${p}.character_slots`, `引用了未声明的槽位：${id}`);
      }
      for (const ph of placeholdersOf(s.prompt_template)) {
        if (BUILTIN_PLACEHOLDERS.includes(ph)) continue;
        if (!slotIds.has(ph)) err(`${p}.prompt_template`, `占位符 {{${ph}}} 不是已声明的槽位`);
        else if (declared && !declared.includes(ph)) err(`${p}.character_slots`, `提示词用到 {{${ph}}}，但 character_slots 没有列出`);
      }
      if (s.lines !== undefined) {
        if (!Array.isArray(s.lines)) err(`${p}.lines`, 'lines 须为数组');
        else {
          s.lines.forEach((l, j) => {
            const lp = `${p}.lines[${j}]`;
            if (!isObj(l)) return err(lp, '台词行须为对象');
            if (!LINE_KINDS.includes(l.kind)) err(`${lp}.kind`, `kind 须为 ${LINE_KINDS.join('/')}`);
            if (!nonEmpty(l.text, 2000)) err(`${lp}.text`, 'text 必填');
            if (l.speaker !== undefined && l.speaker !== '' && !slotIds.has(l.speaker)) err(`${lp}.speaker`, `speaker 须为已声明的槽位：${l.speaker}`);
          });
        }
      }
    });
  }
  return { ok: errors.length === 0, errors };
}

/** 清单里参与签名的部分：去掉 signature 本身。 */
function signedPortion(m) {
  const { signature, ...rest } = m || {};
  return rest;
}

/** 签名摘要：'tpl-' + sha256(canonicalJson(清单去 signature))。云端对这个字符串做 ES256 紧凑 JWS。 */
function templateDigest(m) {
  return 'tpl-' + crypto.createHash('sha256').update(canonicalJson(signedPortion(m))).digest('hex');
}

/** 「套用后会得到」：从清单推出的摘要，不需要数据库。 */
function summaryOf(m) {
  const shots = Array.isArray(m.shots) ? m.shots : [];
  const slots = Array.isArray(m.character_slots) ? m.character_slots : [];
  const groups = [];
  for (const s of shots) {
    const g = s.group || '';
    if (!groups.includes(g)) groups.push(g);
  }
  const lines = shots.reduce((n, s) => n + (Array.isArray(s.lines) ? s.lines.length : 0), 0);
  return {
    shot_count: shots.length,
    total_duration_ms: shots.reduce((n, s) => n + (Number(s.duration_ms) || 0), 0),
    group_count: groups.filter(Boolean).length || (shots.length ? 1 : 0),
    groups: groups.filter(Boolean),
    line_count: lines,
    slots: slots.map((s) => ({ id: s.id, name: s.name, description: s.description || '', required_by: shots.filter((x) => (x.character_slots || []).includes(s.id)).length })),
    style: m.style ? { name: m.style.name, preset: m.style.preset || null, aspect_ratio: m.style.aspect_ratio || null } : null,
    music_hint: m.music_hint || null,
    cameras: [...new Set(shots.map((s) => s.camera).filter(Boolean))],
  };
}

/**
 * 渲染提示词：{{slot}} -> 槽位对应的文本（ctx.slots[slot]），{{scene}} -> ctx.scene，{{style}} -> ctx.style。
 * 没有给出的槽位用槽位名兜底（ctx.fallback[slot]），都没有则留空。
 */
function renderPrompt(template, ctx = {}) {
  const slots = ctx.slots || {};
  const fallback = ctx.fallback || {};
  return String(template || '').replace(PLACEHOLDER_RE, (_, key) => {
    if (key === 'scene') return ctx.scene || '';
    if (key === 'style') return ctx.style || '';
    if (slots[key] !== undefined && slots[key] !== null) return String(slots[key]);
    if (fallback[key] !== undefined) return String(fallback[key]);
    return '';
  }).replace(/[ \t]{2,}/g, ' ').trim();
}

module.exports = {
  validateManifest, summaryOf, templateDigest, signedPortion, renderPrompt, placeholdersOf,
  TIERS, LINE_KINDS, ID_RE, SLOT_RE, MAX_SHOTS,
};
