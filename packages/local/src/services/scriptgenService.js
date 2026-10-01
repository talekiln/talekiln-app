'use strict';
/** P1-05: create a project from a story, run scriptgen, persist the storyboard as drama + episode + storyboards rows. */
const { createProviders } = require('../providers');
const scriptgen = require('../scriptgen');
const dramaService = require('./dramaService');
const storyboardService = require('./storyboardService');
const aiConfigService = require('./aiConfigService');
const enablement = require('../providers/enablement');

const ASPECT_RATIOS = ['9:16', '16:9', '1:1'];

/** Map a validated storyboard shot onto legacy storyboard columns (pure). */
function shotToRow(shot, storyboard) {
  const scene = (storyboard.scenes || []).find((s) => s.id === shot.sceneId);
  const chars = (storyboard.characters || []).filter((c) => (shot.characterIds || []).includes(c.id)).map((c) => c.name);
  const speaker = shot.dialogue && shot.dialogue.speaker !== 'narrator'
    ? ((storyboard.characters || []).find((c) => c.id === shot.dialogue.speaker) || {}).name : '';
  return {
    storyboard_number: shot.no,
    title: scene ? scene.name : null,
    description: shot.visual,
    location: scene ? scene.name : null,
    shot_type: shot.camera || null,
    duration: shot.durationSec,
    dialogue: shot.dialogue ? (speaker ? `${speaker}：${shot.dialogue.text}` : shot.dialogue.text) : null,
    image_prompt: shot.imagePrompt,
    video_prompt: shot.videoPrompt,
    characters: JSON.stringify(chars),
  };
}

/** Validate the create request (pure). Returns { ok, errors, value }. */
function validateRequest(body) {
  const b = body || {};
  const errors = [];
  const story = String(b.story || '').trim();
  if (!story) errors.push('请输入故事内容');
  if (story.length > 8000) errors.push('故事内容过长（最多 8000 字）');
  try { scriptgen.getTemplate(b.templateId); } catch (_) { errors.push('请选择有效的模板'); }
  const aspectRatio = b.aspectRatio || '9:16';
  if (!ASPECT_RATIOS.includes(aspectRatio)) errors.push('画幅只支持 9:16 / 16:9 / 1:1');
  const durationSec = Number(b.durationSec || 45);
  if (!Number.isFinite(durationSec) || durationSec < 30 || durationSec > 60) errors.push('目标时长应在 30-60 秒之间');
  return {
    ok: errors.length === 0,
    errors,
    value: { story, templateId: b.templateId, aspectRatio, durationSec, style: b.style || undefined, title: String(b.title || '').trim(), provider: b.provider, model: b.model },
  };
}

/** Pick provider id + key from the user's saved text configs (keys never leave the server). */
function resolveProvider(db, preferred) {
  const rows = aiConfigService.listConfigsInternal(db, 'text').filter((c) => c.is_active && c.api_key);
  const kindOf = (c) => {
    const h = `${c.provider} ${c.base_url}`.toLowerCase();
    for (const m of enablement.listEnabledMeta()) if (m.textHint.test(h)) return m.id;
    return null;
  };
  const row = rows.find((c) => kindOf(c) && (!preferred || kindOf(c) === preferred));
  if (!row) return null;
  const kind = kindOf(row);
  const model = Array.isArray(row.model) ? row.model[0] : row.model;
  return { kind, cfg: { [kind]: { apiKey: row.api_key, ...(row.base_url ? { baseUrl: row.base_url } : {}) } }, model: row.default_model || model };
}

function persist(db, log, req, storyboard) {
  const now = new Date().toISOString();
  const run = db.transaction(() => {
    const drama = dramaService.createDrama(db, log, {
      title: req.title || storyboard.title,
      description: storyboard.logline,
      genre: req.templateId,
      style: req.style || 'realistic',
      metadata: { aspect_ratio: req.aspectRatio, template_id: req.templateId, target_duration_sec: req.durationSec, story: req.story, characters: storyboard.characters, scenes: storyboard.scenes },
    });
    const ep = db.prepare(
      `INSERT INTO episodes (drama_id, episode_number, title, script_content, description, duration, status, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, 'draft', ?, ?)`
    ).run(drama.id, storyboard.title, req.story, storyboard.logline, storyboard.totalDurationSec, now, now);
    const episodeId = Number(ep.lastInsertRowid);
    for (const shot of storyboard.shots) {
      storyboardService.createStoryboard(db, log, { episode_id: episodeId, ...shotToRow(shot, storyboard) });
    }
    return { drama_id: drama.id, episode_id: episodeId };
  });
  return run();
}

async function createProjectFromStory(db, log, body) {
  const v = validateRequest(body);
  if (!v.ok) { const e = new Error(v.errors.join('；')); e.status = 400; throw e; }
  const prov = resolveProvider(db, v.value.provider);
  if (!prov) {
    const e = new Error(`未找到可用的文本模型配置（${enablement.enabledLabels()}），请先在 AI 配置中添加`);
    e.status = 400; e.code = 'NO_TEXT_PROVIDER'; throw e;
  }
  const providers = createProviders(prov.cfg);
  const r = await scriptgen.generateStoryboard(providers, { ...v.value, provider: prov.kind, model: v.value.model || prov.model });
  const ids = persist(db, log, v.value, r.storyboard);
  return { ...ids, attempts: r.attempts, usage: r.usage };
}

/**
 * Reorder: ids in desired order (must cover the whole episode).
 * 顺序属于项目图（场景组内 children），经内核提交，storyboard_number 由物化重排为 1..n；跨段落移动的镜头并入新位置的段落。
 */
function reorderStoryboards(db, episodeId, ids) {
  require('../kernel/compat').reorderStoryboards(db, episodeId, ids);
}

module.exports = { shotToRow, validateRequest, resolveProvider, createProjectFromStory, reorderStoryboards, ASPECT_RATIOS };
