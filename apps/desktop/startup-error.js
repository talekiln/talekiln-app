'use strict';
// 启动失败时给用户/开发者看的文案。开发态最常见的失败是 better-sqlite3 的 ABI 与 Electron 不符
// （仓库里只有一份提升式 node_modules，pnpm install 装的是 Node 的预编译二进制，Electron 要另一套），
// 这类错误直接给出修复命令，而不是只甩一段堆栈。

const ABI_MISMATCH = /NODE_MODULE_VERSION|compiled against a different Node\.js version/;

function isNativeAbiMismatch(err) {
  const text = err && err.stack ? err.stack : String(err);
  return ABI_MISMATCH.test(text);
}

function describeStartupError(err, { logFile, packaged }) {
  const stack = err && err.stack ? err.stack : String(err);
  const lines = [`本地服务未能启动，日志：${logFile}`];
  if (!packaged && isNativeAbiMismatch(err)) {
    lines.push('原因：better-sqlite3 的原生模块是按 Node 编译的，与 Electron 不符（开发态常见）。');
    lines.push('修复：在仓库根目录运行 pnpm native:electron（或直接 pnpm dev，它会先做这一步）；跑 pnpm test / dev:web 前再 pnpm native:node 切回。');
  }
  return `${lines.join('\n')}\n\n${stack}`;
}

module.exports = { describeStartupError, isNativeAbiMismatch };
