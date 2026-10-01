'use strict';
// 旁白配音 REST（令牌由 app 级 localTokenGuard 统一校验）。
//   GET  /voiceover/voices               音色清单
//   POST /episodes/:id/voiceover         { shots: [id...] | all: true, voice?, confirm? }
//        all 模式跳过已有最新旁白的镜头，force: true 则全部重做
//        confirm 缺省/false：只估价，不合成（返回 confirm_required: true）
//        confirm: true：先过花费上限，再逐镜合成并经内核 recordGeneration 写回
const kernel = require('@talekiln/kernel');
const response = require('../response');
const store = require('../kernel/store');
const svc = require('../voiceover/service');
const { createEstimator } = require('../spend');
const enablement = require('../providers/enablement');

const { KernelError } = kernel;
const STATUS = { NOT_FOUND: 404, GRAPH_NOT_FOUND: 404 };

/** 默认的配音服务解析：按已启用的服务商，取其 tts 配置（或同一 Key 的其他配置）。 */
function defaultResolver(db) {
  return (preferred) => {
    const { pickConfig, pickSharedKeyConfig } = require('../queue/providerAdapter');
    const { createProviders } = require('../providers');
    const list = (type) => require('../services/aiConfigService').listConfigsInternal(db, type);
    for (const p of enablement.getEnabled()) {
      if (preferred && preferred !== p) continue;
      const own = pickConfig(list, p, 'tts');
      const cfg = own && own.api_key ? own : pickSharedKeyConfig(list, p, 'tts');
      if (!cfg || !cfg.api_key) continue;
      let facadeCfg = { apiKey: cfg.api_key, baseUrl: cfg.base_url || undefined };
      if (p === 'ark') {
        let s = cfg.settings;
        if (typeof s === 'string') { try { s = JSON.parse(s); } catch (_) { s = {}; } }
        s = s || {};
        facadeCfg = { ...facadeCfg, speech: { appId: s.app_id || s.appId, accessToken: cfg.api_key, cluster: s.cluster } };
      }
      const model = own === cfg ? (cfg.default_model || (Array.isArray(cfg.model) ? cfg.model[0] : cfg.model)) : undefined;
      return { provider: p, model: model || undefined, facade: createProviders({ [p]: facadeCfg }) };
    }
    return null;
  };
}

/** deps: { spend?, storageRoot, resolve?(preferred) -> {provider, model, facade}, concurrency? } */
function routes(db, log, deps = {}) {
  const resolve = deps.resolve || defaultResolver(db);
  const fallback = deps.spend ? null : createEstimator();
  const estimate = (spec) => (deps.spend ? deps.spend.estimate(spec) : fallback.estimate(spec));
  const logSpend = svc.createSpendLogger(db, { estimate });

  const ep = (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new KernelError('INVALID_OP', 'episode id must be a positive integer');
    return id;
  };

  return {
    voices: (req, res) => response.success(res, { voices: svc.VOICES, default: svc.DEFAULT_VOICE }),

    voiceover: async (req, res) => {
      try {
        const episodeId = ep(req);
        const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        if (b.voice !== undefined && (typeof b.voice !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(b.voice))) return response.badRequest(res, 'voice 格式不正确');
        const all = b.all === true || b.shots === 'all';
        if (!all && !(Array.isArray(b.shots) && b.shots.length)) return response.badRequest(res, '需要 shots（镜头 id 数组）或 all: true');
        const { graph } = store.openProject(db, episodeId);
        const items = svc.plan(graph, { shots: b.shots, all, voice: b.voice, force: b.force === true });
        const target = resolve(b.provider);
        if (!target) return response.error(res, 400, 'NO_TTS_PROVIDER', `未找到可用的配音服务配置（${enablement.enabledLabels()}）`);
        const { provider, model } = target;
        const sum = svc.summarize(items, { estimate }, provider, model);
        const todo = items.filter((i) => !i.skip);
        const base = { provider, model: model || null, voice: b.voice || null, shots: todo.length, chars: todo.reduce((a, i) => a + i.chars, 0), ...sum };

        // 单次/月度上限：按总字数一次检查（按字计价是线性的，等于各镜之和）
        let verdict = { ok: true };
        if (deps.spend && todo.length) {
          verdict = deps.spend.check({ provider, kind: 'tts', params: { model, text: todo.map((i) => i.text).join('') } });
        }
        if (b.confirm !== true) {
          return response.success(res, {
            confirm_required: todo.length > 0, ...base,
            allowed: verdict.ok, ...(verdict.ok ? {} : { error_code: 'SPEND_LIMIT', limit_reason: verdict.reason, message: verdict.message }),
          });
        }
        if (!verdict.ok) return response.error(res, 402, 'SPEND_LIMIT', verdict.message, { reason: verdict.reason, estimate: base.estimate, max: base.max, currency: base.currency });
        if (!todo.length) return response.success(res, { ...base, done: [], failed: [], skipped: items.map((i) => ({ shot_id: i.shot_id, reason: i.skip })) });

        const root = deps.storageRoot;
        if (!root) return response.internalError(res, '存储目录未配置');
        const aspect = aspectOf(db, episodeId);
        const out = await svc.run(db, episodeId, items, {
          facade: target.facade, provider, model, storageRoot: root, aspectRatio: aspect, concurrency: deps.concurrency, logSpend,
        });
        const body = { ...base, ...out };
        if (!out.done.length && out.failed.length) {
          return response.error(res, 502, 'VOICEOVER_FAILED', out.failed[0].message, { failed: out.failed });
        }
        response.success(res, body);
      } catch (err) {
        if (err instanceof KernelError) return response.error(res, STATUS[err.code] || 400, err.code, err.message);
        log.error('voiceover', { error: err.message });
        response.internalError(res, err.message);
      }
    },
  };
}

function aspectOf(db, episodeId) {
  try {
    const row = db.prepare('SELECT d.metadata FROM episodes e JOIN dramas d ON d.id = e.drama_id WHERE e.id = ?').get(episodeId);
    const m = row && row.metadata ? JSON.parse(row.metadata) : {};
    return ['9:16', '16:9', '1:1'].includes(m.aspect_ratio) ? m.aspect_ratio : '9:16';
  } catch (_) { return '9:16'; }
}

module.exports = routes;
