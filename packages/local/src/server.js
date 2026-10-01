const { loadConfig } = require('./config/index.js');

const preConfig = loadConfig();
const tlsFlag = preConfig.server?.insecure_tls ?? preConfig.server?.INSECURE_TLS;
const insecureTlsOn =
  tlsFlag === true ||
  tlsFlag === 1 ||
  tlsFlag === '1' ||
  String(tlsFlag).toLowerCase() === 'true';
if (insecureTlsOn) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('[config] server.insecure_tls 已启用：全局跳过 TLS 证书校验，仅用于测试');
}

const { createApp } = require('./app.js');
const { closeDb } = require('./db/index.js');
const logger = require('./logger.js');

// 独立运行（开发）：仅当提供 TALEKILN_DEV_SECRET_KEY（64 位 hex）时启用文件密文存储；否则无法保存 key
let secretStore;
if (process.env.TALEKILN_DEV_SECRET_KEY) {
  const { FileSecretStore, createAesCipher } = require('./secrets');
  secretStore = new FileSecretStore({
    cipher: createAesCipher(process.env.TALEKILN_DEV_SECRET_KEY),
    filePath: require('path').join(process.cwd(), 'data', 'secrets.enc.json'),
  });
}
const { app, config, aiQueue } = createApp({ secretStore });
const port = Number(process.env.PORT) || config.server?.port || 5679;
const host = '127.0.0.1';

const server = app.listen(port, host, () => {
  logger.info('Server starting', { port, host });
  logger.info('Frontend:  http://localhost:' + port);
  logger.info('API:       http://localhost:' + port + '/api/v1');
  logger.info('Health:    http://localhost:' + port + '/health');
  logger.info('Server is ready!');
  aiQueue.worker.start();
});

function shutdown() {
  logger.info('Shutting down server...');
  aiQueue.worker.stop();
  server.close(() => {
    closeDb();
    logger.info('Server exited');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
