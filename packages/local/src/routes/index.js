const express = require('express');
const response = require('../response');
const dramaRoutes = require('./drama');
const taskRoutes = require('./task');
const settingsRoutes = require('./settings');
const aiConfigRoutes = require('./aiConfig');
const propRoutes = require('./prop');
const stubRoutes = require('./stub');
const characterLibraryRoutes = require('./characterLibrary');
const sceneLibraryRoutes = require('./sceneLibrary');
const propLibraryRoutes = require('./propLibrary');
const characterRoutes = require('./characters');
const uploadModule = require('./upload');
const sceneRoutes = require('./scenes');
const storyboardRoutes = require('./storyboards');
const tailFrameLinkRoutes = require('./storyboards_tail_link');
const imageRoutes = require('./images');
const videoRoutes = require('./videos');
const videoMergeRoutes = require('./videoMerges');
const assetRoutes = require('./assets');
const audioRoutes = require('./audio');
const promptOverridesRoutes = require('./promptOverrides');
const sceneModelMapRoutes = require('./sceneModelMap');
const timelineRoutes = require('./timelines');
const scriptgenRoutes = require('./scriptgen');
const workbenchRoutes = require('./workbench');
const onboardingRoutes = require('./onboarding');

function setupRouter(cfg, db, log, aiQueue, cloud, extras = {}) {
  const r = express.Router();
  const drama = dramaRoutes(db, cfg, log);
  const task = taskRoutes(db, log);
  const settings = settingsRoutes(db, cfg, log);
  const aiConfig = aiConfigRoutes(db, log, cfg);
  const prop = propRoutes(db, log, cfg);
  const stub = stubRoutes(db, cfg, log);
  const sceneModelMap = sceneModelMapRoutes(db, log);
  
  const uploadService = require('../services/uploadService');
  const charLibrary = characterLibraryRoutes(db, cfg, log);
  const sceneLibrary = sceneLibraryRoutes(db, cfg, log);
  const propLibrary = propLibraryRoutes(db, cfg, log);
  const characters = characterRoutes(db, cfg, log, uploadService);
  const uploadHandlers = uploadModule.routes(cfg, log, db);
  const scenes = sceneRoutes(db, log, cfg);
  const storyboards = storyboardRoutes(db, log);
  const tailFrameLink = tailFrameLinkRoutes(db, cfg, log);
  const images = imageRoutes(db, cfg, log, { spend: aiQueue && aiQueue.spend });
  const videos = videoRoutes(db, log, { spend: aiQueue && aiQueue.spend });
  const videoMerges = videoMergeRoutes(db, log);
  const assets = assetRoutes(db, log);
  const audio = audioRoutes(db, log, cfg);
  const promptOverrides = promptOverridesRoutes.routes(db, log);
  const scriptgen = scriptgenRoutes(db, log, extras.scriptgenDeps);
  const workbench = workbenchRoutes(db, log);
  const onboarding = onboardingRoutes(db, log, cfg);

  // ---------- dramas ----------
  r.get('/dramas', drama.listDramas);
  r.post('/dramas', drama.createDrama);
  r.get('/dramas/stats', drama.getDramaStats);
  // 导出/导入（放在 :id 路由前，避免被 :id 捕获）
  r.get('/dramas/:id/export', drama.exportDrama);
  const multer = require('multer');
  const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });
  r.post('/dramas/import', importUpload.single('file'), drama.importDrama);
  r.post('/dramas/import-novel', importUpload.single('file'), async (req, res) => {
    try {
      const novelImportService = require('../services/novelImportService');
      let text = '';
      if (req.file && req.file.buffer) {
        text = req.file.buffer.toString('utf8');
      } else if (req.body && req.body.text) {
        text = req.body.text;
      }
      if (!text.trim()) return response.badRequest(res, '请上传小说文本文件或提供 text 参数');
      const title = req.body?.title || '';
      const maxChapters = Number(req.body?.max_chapters) || 20;
      const aiSummarize = req.body?.ai_summarize === 'true' || req.body?.ai_summarize === true;
      const result = await novelImportService.importNovel(db, log, { text, title, maxChapters, aiSummarize });
      response.success(res, result);
    } catch (err) {
      log.error('dramas import-novel', { error: err.message });
      response.internalError(res, err.message);
    }
  });
  r.get('/dramas/examples', drama.listExamples);
  r.post('/dramas/import-example', drama.importExample);
  r.put('/dramas/:id/outline', drama.saveOutline);
  r.get('/dramas/:id/characters', drama.getCharacters);
  r.put('/dramas/:id/characters', drama.saveCharacters);
  r.put('/dramas/:id/episodes', drama.saveEpisodes);
  r.put('/dramas/:id/progress', drama.saveProgress);
  r.put('/dramas/:id/canvas-layout', drama.saveCanvasLayout);
  r.get('/dramas/:id/props', drama.listProps);
  r.get('/dramas/:id', drama.getDrama);
  r.put('/dramas/:id', drama.updateDrama);
  r.delete('/dramas/:id', drama.deleteDrama);

  // ---------- ai-configs ----------
  r.get('/ai-configs', aiConfig.list);
  r.post('/ai-configs', aiConfig.create);
  r.post('/ai-configs/test', aiConfig.testConnection);
  r.post('/ai-configs/jimeng2-list-assets', aiConfig.listJimeng2MaterialAssets);
  r.post('/ai-configs/model-ark-asset', aiConfig.modelArkAsset);
  r.get('/ai-configs/vendor-lock', aiConfig.vendorLock);  // 必须在 /:id 之前
  r.put('/ai-configs/bulk-update-key', aiConfig.bulkUpdateKey);  // 必须在 /:id 之前
  r.get('/ai-configs/:id', aiConfig.get);
  r.put('/ai-configs/:id', aiConfig.update);
  r.delete('/ai-configs/:id', aiConfig.delete);

  // ---------- generation (角色生成：AI + 入库 + 任务结果) ----------
  r.post('/generation/characters', (req, res) => {
    const characterGenerationService = require('../services/characterGenerationService');
    try {
      const body = req.body || {};
      if (!body.drama_id) {
        return response.badRequest(res, 'drama_id 必填');
      }
      const taskId = characterGenerationService.generateCharacters(db, cfg, log, body);
      response.success(res, { task_id: taskId, status: 'pending' });
    } catch (err) {
      log.error('generation/characters', { error: err.message });
      response.internalError(res, err.message || '创建任务失败');
    }
  });

  // 故事生成：带 drama_id 时异步生成并入库；否则同步返回 episodes（兼容旧调用）
  r.post('/generation/story', async (req, res) => {
    const storyGenerationService = require('../services/storyGenerationService');
    try {
      const body = req.body || {};
      if (body.drama_id) {
        const taskId = storyGenerationService.startStoryGeneration(db, log, body);
        return response.success(res, { task_id: taskId, status: 'pending' });
      }
      const result = await storyGenerationService.generateStory(db, log, body);
      response.success(res, result);
    } catch (err) {
      log.error('generation/story', { error: err.message });
      if (err.message && (err.message.includes('未配置') || err.message.includes('必填') || err.message.includes('不存在'))) {
        return response.badRequest(res, err.message);
      }
      response.internalError(res, err.message || '故事生成失败');
    }
  });

  // ---------- character-library ----------
  r.get('/character-library', charLibrary.list);
  r.post('/character-library', charLibrary.create);
  r.get('/character-library/:id', charLibrary.get);
  r.put('/character-library/:id', charLibrary.update);
  r.delete('/character-library/:id', charLibrary.delete);

  // ---------- scene-library ----------
  r.get('/scene-library', sceneLibrary.list);
  r.post('/scene-library', sceneLibrary.create);
  r.get('/scene-library/:id', sceneLibrary.get);
  r.put('/scene-library/:id', sceneLibrary.update);
  r.delete('/scene-library/:id', sceneLibrary.delete);

  // ---------- prop-library ----------
  r.get('/prop-library', propLibrary.list);
  r.post('/prop-library', propLibrary.create);
  r.get('/prop-library/:id', propLibrary.get);
  r.put('/prop-library/:id', propLibrary.update);
  r.delete('/prop-library/:id', propLibrary.delete);

  // ---------- characters ----------
  r.get('/characters/:id', characters.getOne);
  r.put('/characters/:id', characters.update);
  r.delete('/characters/:id', characters.delete);
  r.post('/characters/batch-generate-images', characters.batchGenerateImages);
  r.post('/characters/:id/generate-image', characters.generateImage);
  r.post('/characters/:id/generate-four-view-image', characters.generateFourViewImage);
  r.post('/characters/:id/generate-prompt', characters.generatePrompt);
  r.post('/characters/:id/upload-image', uploadModule.multerSingle, characters.uploadImage);
  r.put('/characters/:id/image', characters.putImage);
  r.put('/characters/:id/image-from-library', characters.imageFromLibrary);
  r.post('/characters/:id/add-to-library', characters.addToLibrary);
  r.post('/characters/:id/add-to-material-library', characters.addToMaterialLibrary);
  r.post('/characters/:id/sd2-certify', characters.sd2Certify);
  r.post('/characters/:id/sd2-certify/refresh', characters.sd2CertifyRefresh);
  r.post('/characters/:id/sd2-voice-upload', uploadModule.multerAudioSingle, characters.sd2VoiceUpload);
  r.post('/characters/:id/sd2-voice-refresh', characters.sd2VoiceRefresh);
  r.post('/characters/:id/extract-from-image', characters.extractFromImage);
  r.post('/characters/:id/extract-anchors', characters.extractAnchors);

  // ---------- props ----------
  r.get('/props/:id', prop.getPropById);
  r.post('/props', prop.createProp);
  r.put('/props/:id', prop.updateProp);
  r.delete('/props/:id', prop.deleteProp);
  r.post('/props/:id/generate', prop.generateImage);
  r.post('/props/:id/generate-prompt', prop.generatePropPrompt);
  r.post('/props/:id/add-to-library', prop.addToLibrary);
  r.post('/props/:id/add-to-material-library', prop.addToMaterialLibrary);
  r.post('/props/:id/extract-from-image', prop.extractPropFromImage);

  // ---------- vision: 从图片提取描述（不依赖已有实体 ID）----------
  r.post('/extract-description-from-image', async (req, res) => {
    const { image_url, entity_type, entity_name } = req.body || {};
    if (!image_url) return response.badRequest(res, '缺少 image_url');
    if (!['character', 'scene', 'prop'].includes(entity_type)) return response.badRequest(res, 'entity_type 需为 character/scene/prop');
    try {
      const { extractDescriptionFromImage } = require('../services/aiClient');
      const out = await extractDescriptionFromImage(db, log, entity_type, image_url, entity_name);
      if (!out.ok) return response.badRequest(res, out.error);
      response.success(res, { description: out.description });
    } catch (err) {
      log.error('extract-description-from-image', { error: err.message });
      response.internalError(res, err.message);
    }
  });

  // ---------- upload ----------
  r.post('/upload/image', uploadModule.multerSingle, uploadHandlers.uploadImage);

  // ---------- episodes ----------
  // 注意：drama.generateStoryboard 已处理所有逻辑（包括参数解析），这里统一使用 drama 模块的实现
  // 之前可能有部分路由指向了 storyboards.episodeStoryboardsGenerate，这可能导致参数解析不一致
  r.post('/episodes/:episode_id/storyboards', drama.generateStoryboard);
  r.post('/episodes/:episode_id/props/extract', prop.extractProps);
  r.post('/episodes/:episode_id/characters/extract', stub.episodeCharactersExtract);
  r.get('/episodes/:episode_id/storyboards', storyboards.episodeStoryboardsGet);
  r.post('/episodes/:episode_id/finalize', drama.finalizeEpisode);
  r.get('/episodes/:episode_id/download', drama.downloadEpisodeVideo);

  // ---------- tasks ----------
  r.get('/tasks/:task_id', task.getTaskStatus);
  r.post('/tasks/:task_id/cancel', task.cancelTaskStatus);
  r.get('/tasks', task.getResourceTasks);

  // ---------- scenes ----------
  r.get('/scenes/:scene_id', scenes.getOne);
  r.post('/scenes/:scene_id/generate-prompt', scenes.generatePrompt);
  r.put('/scenes/:scene_id', scenes.update);
  r.put('/scenes/:scene_id/prompt', scenes.updatePrompt);
  r.delete('/scenes/:scene_id', scenes.delete);
  r.post('/scenes/generate-image', scenes.generateImage);
  r.post('/scenes', scenes.create);
  r.post('/scenes/:scene_id/generate-four-view-image', scenes.generateFourViewImage);
  r.post('/scenes/:scene_id/add-to-library', scenes.addToLibrary);
  r.post('/scenes/:scene_id/add-to-material-library', scenes.addToMaterialLibrary);
  r.post('/scenes/:scene_id/extract-from-image', scenes.extractFromImage);

  // ---------- images ----------
  r.get('/images', images.list);
  r.post('/images', images.create);
  r.get('/images/episode/:episode_id/backgrounds', images.episodeBackgrounds);
  r.post('/images/episode/:episode_id/backgrounds/extract', images.episodeBackgroundsExtract);
  r.post('/images/episode/:episode_id/batch', images.episodeBatch);
  r.post('/images/scene/:scene_id', images.scene);
  r.post('/images/upload', images.upload);
  r.get('/images/:id', images.get);
  r.delete('/images/:id', images.delete);

  // ---------- onboarding wizard / bundled sample ----------
  r.get('/providers', onboarding.providers);
  r.get('/onboarding/status', onboarding.status);
  r.put('/onboarding/state', onboarding.saveState);
  r.post('/onboarding/test', onboarding.test);
  r.get('/samples', onboarding.listSamples);
  r.post('/samples/:id/seed', onboarding.seedSample);

  // ---------- reference locks / shot workbench ----------
  r.get('/reference-locks', workbench.listLocks);
  r.put('/reference-locks/:type/:id', workbench.setLock);
  r.delete('/reference-locks/:type/:id', workbench.clearLock);
  r.get('/storyboards/:id/video-candidates', workbench.candidates);
  r.post('/storyboards/:id/adopt-video', workbench.adopt);

  // ---------- videos ----------
  r.get('/videos', videos.list);
  r.post('/videos', videos.create);
  r.post('/videos/image/:image_gen_id', videos.fromImage);
  r.post('/videos/episode/:episode_id/batch', videos.episodeBatch);
  r.post('/videos/:id/resume-poll', videos.resumePoll);
  r.get('/videos/:id', videos.get);
  r.delete('/videos/:id', videos.delete);

  // ---------- video-merges ----------
  r.get('/video-merges', videoMerges.list);
  r.post('/video-merges', videoMerges.create);
  r.get('/video-merges/:merge_id', videoMerges.get);
  r.delete('/video-merges/:merge_id', videoMerges.delete);

  // ---------- assets ----------
  r.get('/assets', assets.list);
  r.post('/assets', assets.create);
  r.post('/assets/import/image/:image_gen_id', assets.importImage);
  r.post('/assets/import/video/:video_gen_id', assets.importVideo);
  r.get('/assets/:id', assets.get);
  r.put('/assets/:id', assets.update);
  r.delete('/assets/:id', assets.delete);

  // ---------- storyboards ----------
  r.get('/storyboards/episode/:episode_id/generate', storyboards.episodeStoryboardsGenerate);
  r.get('/scriptgen/templates', scriptgen.templates);
  r.post('/scriptgen/projects', scriptgen.createProject);
  r.put('/episodes/:episode_id/storyboards/order', scriptgen.reorder);
  r.post('/storyboards', storyboards.create);
  r.post('/storyboards/:id/insert-before', storyboards.insertBefore);
  r.get('/storyboards/:id', storyboards.getOne);
  r.put('/storyboards/:id', storyboards.update);
  r.delete('/storyboards/:id', storyboards.delete);
  r.post('/storyboards/:id/props', prop.associateProps);
  r.post('/storyboards/:id/frame-prompt', storyboards.framePrompt);
  r.get('/storyboards/:id/frame-prompts', storyboards.framePromptsGet);
  r.put('/storyboards/:id/frame-prompts/:frame_type', storyboards.framePromptSave);
  r.post('/storyboards/:id/link-tail-frame', tailFrameLink.linkTailFrame);
  r.post('/storyboards/:id/polish-prompt', storyboards.polishPrompt);
  r.post('/storyboards/:id/universal-segment-polish-stream', storyboards.polishUniversalSegmentStream);
  r.post('/storyboards/:id/classic-video-prompt-polish-stream', storyboards.polishClassicVideoPromptStream);
  r.post('/storyboards/:id/universal-segment-prompt-stream', storyboards.generateUniversalSegmentStream);
  r.post('/storyboards/:id/universal-segment-prompt', storyboards.generateUniversalSegmentPrompt);
  r.post('/storyboards/batch-infer-params', storyboards.batchInferParams);
  r.post('/storyboards/:id/upscale', storyboards.upscale);
  r.post('/storyboards/:id/regenerate-layout-description', storyboards.regenerateLayoutDescription);
  r.post('/storyboards/:id/rebuild-video-prompt', storyboards.rebuildVideoPrompt);
  r.post('/storyboards/:id/split-by-audio', storyboards.splitByAudio);

  // ---------- audio ----------
  r.post('/audio/extract', audio.extract);
  r.post('/audio/extract/batch', audio.extractBatch);

  // ---------- settings ----------
  r.get('/settings/language', settings.getLanguage);
  r.put('/settings/language', settings.updateLanguage);
  r.get('/settings/generation', settings.getGenerationSettings);
  r.put('/settings/generation', settings.updateGenerationSettings);

  // ---------- prompt overrides ----------
  r.get('/settings/prompts', promptOverrides.list);
  r.put('/settings/prompts/:key', promptOverrides.update);
  r.delete('/settings/prompts/:key', promptOverrides.reset);

  // ---------- scene model map ----------
  r.get('/scene-model-map', sceneModelMap.list);
  r.post('/scene-model-map', sceneModelMap.create);
  r.get('/scene-model-map/:key', sceneModelMap.get);
  r.put('/scene-model-map/:key', sceneModelMap.update);
  r.delete('/scene-model-map/:key', sceneModelMap.delete);

  // ---------- timelines ----------
  const timelines = timelineRoutes(db, log);
  r.get('/timelines/episode/:episode_id', timelines.getByEpisode);
  r.post('/timelines/episode/:episode_id/assemble', timelines.assemble);
  r.put('/timelines/:id', timelines.save);
  r.post('/timelines/:id/clips', timelines.addClip);
  r.patch('/timelines/:id/clips/:clip_id', timelines.patchClip);

  // ---------- data kernel: project graph / views / tx / intents ----------
  const kernelRoutes = require('./kernel')(db, log);
  r.get('/episodes/:id/graph', kernelRoutes.getGraph);
  r.get('/episodes/:id/views/:view', kernelRoutes.getView);
  r.get('/episodes/:id/history', kernelRoutes.getHistory);
  r.get('/episodes/:id/versions', kernelRoutes.getVersions);
  r.post('/episodes/:id/tx', kernelRoutes.postTx);
  r.post('/episodes/:id/intent', kernelRoutes.postIntent);
  r.post('/episodes/:id/undo', kernelRoutes.postUndo);
  r.post('/episodes/:id/redo', kernelRoutes.postRedo);
  r.post('/episodes/:id/import-legacy', kernelRoutes.importLegacy);

  // ---------- narration voiceover (estimate -> confirm -> tts task in the queue -> kernel write-back) ----------
  if (extras.voiceover) {
    const vo = require('./voiceover')(db, log, extras.voiceover);
    r.get('/voiceover/voices', vo.voices);
    r.post('/episodes/:id/voiceover', vo.voiceover);
    r.get('/episodes/:id/voiceover/status', vo.status);
  }

  // ---------- generation (I1): image / video through the durable queue, results land in the kernel ----------
  if (extras.generation) {
    const gen = require('./generation')(extras.generation, log, { legacyEnabled: !!(cfg && cfg.generation && cfg.generation.legacy_enabled === true) });
    r.post('/episodes/:id/generate', gen.generate);
    r.get('/episodes/:id/generation/status', gen.status);
  }

  // ---------- export / render (G06) and AIGC marking settings (G04) ----------
  {
    let exporter = null;
    if (extras.storageRoot && (extras.exporter || extras.getCore)) {
      const { createExportService } = require('../export/service');
      exporter = extras.exporter || createExportService(db, {
        getCore: extras.getCore, storageRoot: extras.storageRoot,
        ffmpegPath: require('../utils/ffmpegPath').getFfmpegPath(), ffmpegDir: extras.ffmpegDir || null,
        onFinished: extras.onExportFinished || null,
      });
    }
    const mediaExporter = extras.storageRoot
      ? (extras.mediaExporter || require('../export/mediaExport').createMediaExporter(db, { storageRoot: extras.storageRoot })) : null;
    const exp = require('./export')(db, exporter, log, mediaExporter);
    r.get('/settings/aigc', exp.getAigc);
    r.put('/settings/aigc', exp.putAigc);
    r.get('/export/options', exp.options);
    r.post('/export/start', exp.start);
    r.post('/export/jianying', exp.jianying);
    r.post('/export/fcpxml', exp.fcpxml);
    r.get('/export/:id/status', exp.status);
    r.post('/export/:id/cancel', exp.cancel);
    r.post('/export/:id/open-folder', exp.openFolder);
  }

  // ---------- music library (F05) ----------
  if (extras.storageRoot) {
    const library = require('../music').createMusicLibrary(db, { storageRoot: extras.storageRoot });
    const music = require('./music')(db, library, log);
    r.get('/music-library', music.list);
    r.post('/music-library', music.multerSingle, music.import);
    r.delete('/music-library/:id', music.remove);
    r.post('/timelines/:id/music', music.attach);
  }

  // 启动时将已有的覆盖加载到 promptI18n 内存缓存
  try {
    const promptI18n = require('../services/promptI18n');
    const promptOverridesService = require('../services/promptOverridesService');
    const saved = promptOverridesService.listOverrides(db);
    promptI18n.loadOverridesIntoCache(saved);
  } catch (e) {
    console.warn('Failed to load prompt overrides:', e.message);
  }

  // ---------- ai-tasks (task center) ----------
  if (aiQueue && aiQueue.store) {
    const aiTasks = require('./aiTasks')(aiQueue.store, log, aiQueue.worker, { spend: aiQueue.spend });
    r.post('/ai-tasks', aiTasks.create);
    r.get('/ai-tasks', aiTasks.list);
    r.get('/ai-tasks/:id', aiTasks.get);
    r.post('/ai-tasks/:id/retry', aiTasks.retry);
    r.post('/ai-tasks/:id/cancel', aiTasks.cancel);
  }

  // ---------- cloud: account / catalog / referral (B05, B06, C07) ----------
  if (cloud) {
    const c = require('./cloud')(cloud, log);
    r.post('/account/register', c.register);
    r.post('/account/login', c.login);
    r.post('/account/logout', c.logout);
    r.get('/account/status', c.status);
    r.post('/account/refresh', c.refresh);
    r.get('/catalog', c.catalog);
    r.post('/catalog/refresh', c.catalogRefresh);
    r.get('/referral/:provider', c.referral);
  }

  // ---------- spend control (D06) ----------
  if (aiQueue && aiQueue.spend) {
    const spendRoutes = require('./spend')(aiQueue.spend, log);
    r.get('/spend/summary', spendRoutes.summary);
    r.get('/spend/tasks', spendRoutes.tasks);
    r.get('/spend/export', spendRoutes.exportCsv);
    r.get('/spend/limits', spendRoutes.getLimits);
    r.put('/spend/limits', spendRoutes.putLimits);
    r.post('/spend/estimate', spendRoutes.estimate);
  }

  // ---------- diagnostics / feedback (H03) ----------
  {
    const diag = require('./diagnostics')({
      store: aiQueue && aiQueue.store, log, versions: { app: require('../../package.json').version },
    });
    r.get('/diagnostics/bundle', diag.exportBundle);
    r.post('/diagnostics/feedback', diag.sendFeedback);
  }

  // P3-B
  if (extras.batch) {
    const batches = require('./batches')(extras.batch, log);
    r.post('/batches', batches.create);
    r.get('/batches', batches.list);
    r.get('/batches/:id', batches.get);
    r.post('/batches/:id/retry-failed', batches.retryFailed);
    r.post('/batches/:id/cancel', batches.cancel);
    r.post('/batches/:id/pause', batches.pause);
    r.post('/batches/:id/resume', batches.resume);
  }
  // P3-T 模板市场
  if (extras && extras.templates) {
    const t = require('./templates')(extras.templates, log);
    r.get('/templates', t.list);
    r.get('/templates/cloud', t.cloud);
    r.post('/templates/install', t.install);
    r.get('/templates/:id', t.get);
    r.post('/templates/:id/estimate', t.estimate);
    r.post('/templates/:id/apply', t.apply);
    r.delete('/templates/:id', t.remove);
  }
  // P3-D
  // ---------- director mode: natural-language edit -> validated plan -> one undoable kernel transaction ----------
  {
    const { createDirectorService } = require('../director');
    const directorService = extras.director || createDirectorService({
      db, log, spend: aiQueue && aiQueue.spend, generation: extras.generation, config: cfg, listConfigs: extras.listConfigs,
      ...(extras.directorDeps || {}), // 假厂商模式注入 resolveProvider / createProviders（见 providers/fakeVendor.js）
    });
    const director = require('./director')(directorService, log);
    r.post('/episodes/:id/director/plan', director.plan);
    r.get('/episodes/:id/director/turns', director.turns);
    r.post('/episodes/:id/director/turns/:turnId/apply', director.apply);
    r.post('/episodes/:id/director/turns/:turnId/undo', director.undo);
  }
  // P3-C 角色一致性：评分报告 / 重评 / 参考图自动挑选
  if (extras.consistency) {
    const consistency = require('./consistency')(extras.consistency, log);
    r.get('/episodes/:id/consistency', consistency.episodeReport);
    r.post('/shots/:id/consistency/rescore', consistency.rescore);
    r.post('/characters/:id/references/auto-pick', consistency.autoPick);
  }
  // P3-P
  if (extras.pluginHost) {
    const plugins = require('./plugins')(extras.pluginHost, log);
    r.get('/plugins', plugins.list);
    r.post('/plugins/install', plugins.install);
    r.get('/plugins/:id', plugins.get);
    r.post('/plugins/:id/enable', plugins.enable);
    r.post('/plugins/:id/disable', plugins.disable);
    r.delete('/plugins/:id', plugins.remove);
    r.get('/settings/developer-mode', plugins.getDeveloperMode);
    r.put('/settings/developer-mode', plugins.putDeveloperMode);
  }
  // P3-R
  // ---------- region edit (选镜改片): estimate / confirm -> queue -> ffmpeg splice -> new kernel version; adopt via adoptShotVersion ----------
  if (extras.regionEdit) {
    const re = require('./regionEdit')(extras.regionEdit, log);
    r.post('/shots/:id/edit-region', re.editRegion);
    r.get('/shots/:id/edit-regions', re.listRegions);
    r.post('/shots/:id/adopt-version', re.adoptVersion);
  }
  // P3-K 可选云备份（S3 兼容，MinIO 为参考目标）
  if (extras.backup) {
    const bk = require('./backup')(extras.backup, log);
    r.get('/backup/settings', bk.getSettings);
    r.put('/backup/settings', bk.putSettings);
    r.post('/backup/test', bk.test);
    r.post('/backup/dramas/:id', bk.backupDrama);
    r.get('/backup/snapshots', bk.snapshots);
    r.post('/backup/restore', bk.restore);
    r.delete('/backup/snapshots', bk.deleteSnapshot);
    r.get('/backup/status', bk.status);
    r.get('/backup/runs', bk.runs);
  }
  // P2-C 登录：短信验证码 / 微信扫码（透传云端，见 routes/cloud.js）
  if (cloud) {
    const c = require('./cloud')(cloud, log);
    r.post('/account/sms/send', c.smsSend);
    r.post('/account/sms/login', c.smsLogin);
    r.post('/account/wechat/qr', c.wechatQr);
    r.get('/account/wechat/qr/:ticket', c.wechatQrStatus);
    r.post('/account/wechat/qr/:ticket/confirm', c.wechatConfirm);
    r.post('/account/wechat/login', c.wechatLogin);
  }
  // P3-S 工作室版基础：身份 / 成员管理转发云端，共享角色库与模板在对象存储 shared/<studio_id>/ 下
  if (extras.studio) {
    const st = require('./studio')(extras.studio, log);
    r.get('/studio/identity', st.identity);
    r.put('/studio/current', st.setCurrent);
    r.post('/studio/studios', st.createStudio);
    r.get('/studio/studios/:id', st.detail);
    r.post('/studio/studios/:id/invites', st.invite);
    r.delete('/studio/studios/:id/invites/:inviteId', st.revokeInvite);
    r.post('/studio/accept', st.accept);
    r.delete('/studio/studios/:id/members/:accountId', st.removeMember);
    r.put('/studio/studios/:id/members/:accountId/role', st.setRole);
    r.get('/studio/shared/:kind', st.listShared);
    r.post('/studio/shared/characters/publish', st.publishCharacter);
    r.post('/studio/shared/characters/pull', st.pullCharacter);
    r.post('/studio/shared/templates/publish', st.publishTemplate);
    r.post('/studio/shared/templates/pull', st.pullTemplate);
    r.get('/studio/records', st.records);
  }

  return r;
}

module.exports = { setupRouter };
