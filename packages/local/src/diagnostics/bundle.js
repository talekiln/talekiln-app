'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createZip } = require('./zip');
const { redactDiagnosticText } = require('./redact');

const DEFAULT_MAX_LOG_BYTES = 512 * 1024;
const TASK_FIELDS = ['id', 'provider', 'kind', 'state', 'vendor_task_id', 'attempts', 'poll_attempts', 'error_code', 'created_at', 'updated_at', 'completed_at'];

/** 读文件尾部 maxBytes 字节，并丢弃被截断的首行。 */
function tailFile(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.toString('utf8');
    if (size > maxBytes) text = text.slice(text.indexOf('\n') + 1);
    return { text, truncated: size > maxBytes };
  } finally {
    fs.closeSync(fd);
  }
}

function systemInfo() {
  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpuCount: os.cpus().length,
    totalMemMB: Math.round(os.totalmem() / 1048576),
    freeMemMB: Math.round(os.freemem() / 1048576),
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    // 刻意不包含：主机名、用户名、网卡/MAC、环境变量、完整路径
  };
}

/**
 * 生成诊断包 zip（Buffer）。内容：manifest.json、versions.json、system.json、tasks.json、logs/*.log。
 * 所有文本都经 redactDiagnosticText；任务只取白名单字段（不含 params/result，其中有提示词与结果地址）。
 * opts: { logFiles: string[], versions: object, tasks: object[], maxLogBytes, extraSecrets, homeDir, now, taskIdHint }
 */
function buildDiagnosticBundle(opts = {}) {
  const now = opts.now || new Date();
  const red = (t) => redactDiagnosticText(t, { extraSecrets: opts.extraSecrets, homeDir: opts.homeDir });
  const redJson = (o) => red(JSON.stringify(o, null, 2));
  const entries = [];
  const manifest = { createdAt: now.toISOString(), schema: 1, files: [], notes: [] };

  const used = new Set();
  for (const file of opts.logFiles || []) {
    let base = path.basename(file).replace(/[^A-Za-z0-9._-]/g, '_');
    for (let i = 2; used.has(base); i++) base = `${i}-${path.basename(file).replace(/[^A-Za-z0-9._-]/g, '_')}`;
    used.add(base);
    try {
      const { text, truncated } = tailFile(file, opts.maxLogBytes || DEFAULT_MAX_LOG_BYTES);
      entries.push({ name: `logs/${base}`, data: red(text) });
      if (truncated) manifest.notes.push(`${base}: 仅保留末尾 ${opts.maxLogBytes || DEFAULT_MAX_LOG_BYTES} 字节`);
    } catch (e) {
      manifest.notes.push(`${base}: 无法读取（${e.code || 'error'}）`);
    }
  }

  entries.push({ name: 'versions.json', data: redJson({ ...(opts.versions || {}), node: process.versions.node, electron: process.versions.electron || null, chrome: process.versions.chrome || null }) });
  entries.push({ name: 'system.json', data: redJson(systemInfo()) });

  const tasks = (opts.tasks || []).slice(0, 200).map((row) => {
    const o = {};
    for (const k of TASK_FIELDS) if (row && row[k] !== undefined) o[k] = row[k];
    if (row && row.error_message) o.error_message = String(row.error_message).slice(0, 200);
    return o;
  });
  entries.push({ name: 'tasks.json', data: redJson(tasks) });

  manifest.files = entries.map((e) => e.name);
  entries.unshift({ name: 'manifest.json', data: redJson(manifest) });
  return { buffer: createZip(entries, now), manifest };
}

module.exports = { buildDiagnosticBundle, TASK_FIELDS };
