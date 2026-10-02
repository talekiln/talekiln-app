require('./utils/preferIpv4Dns');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { getDb } = require('./db/index.js');
const { loadConfig } = require('./config/index.js');
const logger = require('./logger.js');
const { setupRouter } = require('./routes/index.js');
const { createAiTaskStore, createAiTaskQueue, createWorker, createDownloader, withDownloads, queueOptionsFromConfig, buildQueueProviders, resolveOptions } = require('./queue');
const { createSpendService, createEstimator } = require('./spend');
const { createCloud } = require('./cloud');
const { createGenerationService } = require('./generation');
const { createBatchService, createBatchScheduler, attachToWorker } = require('./batch');
const { localTokenGuard } = require('./utils/localToken');

function createAiQueue({ config, db, log, storageRoot, providers, onTaskFinished, cloud }) {
  const store = createAiTaskStore(db);
  // 价格表：已验证的云端目录优先，否则内置 prices.json（刷新后下次启动生效）
  const spend = createSpendService(db, { estimator: createEstimator(cloud.catalog.effectivePrices()) });
  const downloader = createDownloader({ storageDir: storageRoot });
  const queue = createAiTaskQueue({
    store,
    providers: withDownloads(providers, downloader),
    ...queueOptionsFromConfig(config),
    spendGuard: (t) => spend.guardTask(t),
    hooks: { onRateLimit: (e) => log.warn && log.warn('ai queue rate limited', e) },
  });
  const worker = createWorker({
    queue, store, config,
    onTaskFinished: (t) => {
      try { spend.recordFinished(t); } catch (e) { log.error && log.error('spend record', { error: e && e.message }); }
      if (onTaskFinished) onTaskFinished(t);
    },
    onError: (e) => log.error && log.error('ai queue worker', { error: e && e.message }),
  });
  return { store, queue, worker, downloader, spend };
}

function createApp(opts = {}) {
  // 密钥存储由主进程注入；未注入则不可用（拒绝保存 key，绝不降级为明文）
  const secrets = require('./secrets');
  if (opts.secretStore) secrets.setSecretStore(opts.secretStore);
  const config = opts.config ? { ...loadConfig(), ...opts.config } : loadConfig(); // opts.config：顶层键覆盖（测试/脚本调快轮询）
  // 对外开放的服务商：config.yaml providers.enabled（默认仅百炼）；测试可用 opts.enabledProviders 覆盖
  require('./providers/enablement').configureEnabled(opts.enabledProviders || config);
  const db = getDb(config.database);
  const { runMigrationsAndEnsure } = require('./db/migrate.js');
  runMigrationsAndEnsure(db);

  // 旧版明文 api_key 加密迁移（在 vendor_lock 之前，使其能读到旧 key）
  require('./services/aiConfigService').migratePlaintextApiKeys(db, logger);

  // 厂商锁定模式：在迁移完成后同步 vendor_lock 配置
  const { applyVendorLock } = require('./services/aiConfigService');
  applyVendorLock(db, logger, config);
  const log = logger;

  const taskService = require('./services/taskService');
  taskService.failOrphanedAsyncTasksOnStartup(db, log);

  const { resumeProcessingVideoGenerations } = require('./services/videoService');
  resumeProcessingVideoGenerations(db, log);

  const app = express();
  // 本地服务令牌：由桌面主进程每次启动生成并注入；未设置时（纯开发模式）不校验
  app.use(localTokenGuard(process.env.TALEKILN_LOCAL_TOKEN));

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use(
    cors({
      origin: config.server.cors_origins && config.server.cors_origins.length
        ? config.server.cors_origins
        : false,
    })
  );

  app.use((req, res, next) => {
    log.info(req.method, req.path);
    next();
  });

  // 静态资源目录：统一转为绝对路径（打包 exe 下相对路径可能解析异常）
  const storageRoot = config.storage?.local_path
    ? (path.isAbsolute(config.storage.local_path)
        ? config.storage.local_path
        : path.join(process.cwd(), config.storage.local_path))
    : path.join(process.cwd(), 'data', 'storage');
  try {
    if (!fs.existsSync(storageRoot)) fs.mkdirSync(storageRoot, { recursive: true });
    app.use('/static', express.static(storageRoot));
  } catch (e) {
    console.warn('Static storage mount skipped:', e.message);
  }

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      app: config.app.name,
      version: config.app.version,
    });
  });

  // 持久化 AI 任务队列 + worker（由 server.js / 桌面主进程调用 aiQueue.worker.start()）
  const cloud = opts.cloud || createCloud({ config, db, log: logger });
  let generation = null; // I1：任务成功后写回数据内核（在 aiQueue 之后创建，所以这里用闭包取）
  let batch = null; // P3-B：批次调度（任务结束时唤醒）
  const aiQueue = createAiQueue({
    cloud, config, db, log, storageRoot,
    providers: opts.queueProviders || buildQueueProviders({ db, storageDir: storageRoot, listConfigs: opts.listConfigs }),
    onTaskFinished: (t) => {
      if (generation) { try { generation.onTaskFinished(t); } catch (e) { log.error && log.error('generation finish', { error: e && e.message }); } }
      if (batch) { try { batch.onTaskFinished(t); } catch (e) { log.error && log.error('batch finish', { error: e && e.message }); } }
      if (opts.onTaskFinished) opts.onTaskFinished(t);
    },
  });

  const coreProvider = opts.getCore ? null : require('./export/coreProvider').createCoreProvider({ endpoint: process.env.LYCORE_ENDPOINT });
  const getCore = opts.getCore || (coreProvider && coreProvider.getCore);
  generation = opts.generation || createGenerationService({
    db, store: aiQueue.store, worker: aiQueue.worker, spend: aiQueue.spend, storageRoot, getCore, listConfigs: opts.listConfigs, log,
    catalogModels: () => { try { return cloud.catalog.getCatalog().models || []; } catch (_) { return []; } },
  });
  generation.recoverFinished().catch((e) => log.error && log.error('generation recover', { error: e && e.message }));
  // P3-B：批量生成服务 + 调度器。调度器与队列 worker 同生命周期（worker.start/stop 由 server.js / 桌面主进程调用）
  batch = opts.batch || createBatchService({ db, store: aiQueue.store, generation, spend: aiQueue.spend, worker: aiQueue.worker, limits: resolveOptions(config).limits, log });
  const batchScheduler = createBatchScheduler({ service: batch, onError: (e) => log.error && log.error('batch scheduler', { error: e && e.message }) });
  attachToWorker(aiQueue.worker, batchScheduler);
  aiQueue.batch = batch;
  aiQueue.batchScheduler = batchScheduler;
  // P3-T 模板市场：内置模板在这里同步进表
  const templates = opts.templates || require('./templates').createTemplateService({
    db, spend: aiQueue.spend, log, cloud, listConfigs: opts.listConfigs,
    catalogModels: () => { try { return cloud.catalog.getCatalog().models || []; } catch (_) { return []; } },
  });
  app.use('/api/v1', setupRouter(config, db, log, aiQueue, cloud, { storageRoot, exporter: opts.exporter, getCore, generation, batch, templates }));

  // 前端静态资源（sxy：web/dist）；Electron 打包时可设 WEB_DIST_PATH
  const webDist = process.env.WEB_DIST_PATH || path.join(process.cwd(), '..', 'frontweb', 'dist');
  console.log('webDist', webDist);
  if (fs.existsSync(webDist)) {
    app.use('/assets', express.static(path.join(webDist, 'assets')));
    // 服务 dist 根目录的静态文件（如 wx.jpg、favicon.ico 等）
    app.use(express.static(webDist, { index: false }));
    app.get('/favicon.ico', (req, res) => {
      const fav = path.join(webDist, 'favicon.ico');
      if (fs.existsSync(fav)) res.sendFile(fav);
      else res.status(404).end();
    });
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      const indexHtml = path.join(webDist, 'index.html');
      if (fs.existsSync(indexHtml)) res.sendFile(indexHtml);
      else next();
    });
  } else {
    app.get('/', (req, res) => {
      res.send(
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Talekiln</title></head><body>' +
          '<h1>Talekiln API</h1><p>后端已启动。请先构建前端：</p>' +
          '<pre>cd web &amp;&amp; pnpm install &amp;&amp; pnpm build</pre>' +
          '<p>然后将 <code>web/dist</code> 放到与 backend-node 同级的 <code>web/dist</code>，或访问 <a href="/health">/health</a> 检查接口。</p></body></html>'
      );
    });
  }

  app.use((req, res) => {
    if (req.path.startsWith('/api')) {
      return res.status(404).json({ error: 'API endpoint not found' });
    }
    res.status(404).send('Not Found');
  });

  app.use((err, req, res, next) => {
    log.errorw('Unhandled error', { error: err.message, path: req.path });
    if (!res.headersSent) {
      const isFileTooLarge = err.code === 'LIMIT_FILE_SIZE' || (err.message && err.message.includes('File too large'));
      const status = isFileTooLarge ? 413 : 500;
      const message = isFileTooLarge ? '图片大小不能超过 16MB，请压缩后重试' : (err.message || '服务器错误');
      res.status(status).json({ success: false, error: { code: isFileTooLarge ? 'FILE_TOO_LARGE' : 'INTERNAL_ERROR', message }, timestamp: new Date().toISOString() });
    }
  });

  // 启动时尽力刷新一次目录（云端未配置/离线都静默跳过）
  if (cloud.isConfigured() && opts.cloudAutoSync !== false) cloud.catalog.refresh().catch(() => {});

  return { app, config, db, aiQueue, cloud };
}

module.exports = { createApp };
