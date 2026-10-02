'use strict';
// 桌面主进程侧的 lycore 生命周期：找二进制、定 ffmpeg 目录、拉起 supervisor、把管道地址写进 LYCORE_ENDPOINT。
// 所有 Electron / 文件系统依赖由调用方注入，便于测试。启动失败不阻止应用启动（导出时本地服务会回“渲染核心未启动”）。

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const EXE = process.platform === 'win32' ? 'lycore.exe' : 'lycore';

/** 打包后在 <resources>/lycore/；开发时取 packages/core/target 下最新的 release/debug 构建。未找到返回 null。 */
function resolveLycoreBin({ isPackaged, resourcesPath, repoCoreDir, env = process.env, exists = fs.existsSync, mtime = (p) => fs.statSync(p).mtimeMs }) {
  if (env.LYCORE_BIN && exists(env.LYCORE_BIN)) return env.LYCORE_BIN;
  if (isPackaged) {
    const p = path.join(resourcesPath, 'lycore', EXE);
    return exists(p) ? p : null;
  }
  const found = ['release', 'debug'].map((d) => path.join(repoCoreDir, 'target', d, EXE)).filter((p) => exists(p));
  if (!found.length) return null;
  return found.sort((a, b) => mtime(b) - mtime(a))[0];
}

/** 每次启动独占的管道地址（Windows 命名管道，其他平台用 UDS）。 */
function makeEndpoint({ platform = process.platform, tmpDir = require('os').tmpdir(), pid = process.pid } = {}) {
  const id = `talekiln-lycore-${pid}-${crypto.randomBytes(4).toString('hex')}`;
  return platform === 'win32' ? `\\\\.\\pipe\\${id}` : path.join(tmpDir, `${id}.sock`);
}

/**
 * ffmpeg 目录来源（按优先级）：
 *  1. 环境变量 LYCORE_FFMPEG_DIR（用户自带，显式配置即权威）
 *  2. 随包内置 <resources>/lycore/ffmpeg —— 不返回目录，让 lycore 按 <exe 目录>/ffmpeg 自己找
 *  3. 首次使用时按清单下载（清单仍是占位则跳过，错误只记日志）
 * 返回 { dir?: string, source: 'env'|'bundled'|'provisioned'|'none', error?: string }
 */
async function resolveFfmpeg({ env = process.env, lycoreBin, appDataDir, provision, exists = fs.existsSync, log = () => {} }) {
  if (env.LYCORE_FFMPEG_DIR) return { dir: env.LYCORE_FFMPEG_DIR, source: 'env' };
  const tool = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const bundled = lycoreBin && path.join(path.dirname(lycoreBin), 'ffmpeg');
  if (bundled && (exists(path.join(bundled, tool)) || exists(path.join(bundled, 'bin', tool)))) return { source: 'bundled' };
  if (!provision) return { source: 'none' };
  try {
    const { dir } = await provision({ appDataDir });
    return { dir, source: 'provisioned' };
  } catch (e) {
    log(`ffmpeg provision skipped: ${e && e.code ? e.code + ': ' : ''}${e && e.message}`);
    return { source: 'none', error: e && e.code ? e.code : String(e && e.message) };
  }
}

/**
 * @param {object} o
 * @param {Function} o.createSupervisor  packages/core/client 的 createSupervisor
 * @param {object} o.env                 会被写入 LYCORE_ENDPOINT 的环境（process.env）
 * @returns {{ start(): Promise<{ok:boolean, endpoint?:string, reason?:string}>, stop(): Promise<void>, supervisor }}
 */
function createCoreRuntime({ createSupervisor, env = process.env, bin, endpoint, logDir, appDataDir, provision, log = () => {}, onFailed = () => {}, supervisorOptions = {} }) {
  let sup = null;
  // 本地服务创建时读该变量；首次握手前就要设好，之后由 supervisor 自动重启（地址不变）
  if (bin) env.LYCORE_ENDPOINT = endpoint;
  return {
    get supervisor() { return sup; },
    async start() {
      if (!bin) {
        log('lycore binary not found; export disabled (set LYCORE_BIN or build packages/core)');
        return { ok: false, reason: 'binary_missing' };
      }
      const ff = await resolveFfmpeg({ env, lycoreBin: bin, appDataDir, provision, log });
      log(`ffmpeg source: ${ff.source}${ff.dir ? ' ' + ff.dir : ''}`);
      sup = createSupervisor({ bin, endpoint, logDir, env: ff.dir ? { LYCORE_FFMPEG_DIR: ff.dir } : {}, ...supervisorOptions });
      sup.on('log', (l) => log(`lycore: ${l}`));
      sup.on('restart', (r) => log(`lycore restart #${r.attempt} in ${r.delayMs}ms (${r.reason})`));
      sup.on('failed', (f) => { log(`lycore failed permanently: ${f.reason}`); onFailed(f); });
      try {
        const hello = await sup.start();
        log(`lycore ready pid=${sup.pid} version=${hello && hello.version}`);
        return { ok: true, endpoint };
      } catch (e) {
        log(`lycore start failed: ${e && e.message}`);
        return { ok: false, endpoint, reason: e && e.message };
      }
    },
    async stop() {
      if (sup) { try { await sup.stop(); } catch (e) { log(`lycore stop: ${e && e.message}`); } }
    },
  };
}

module.exports = { resolveLycoreBin, makeEndpoint, resolveFfmpeg, createCoreRuntime };
