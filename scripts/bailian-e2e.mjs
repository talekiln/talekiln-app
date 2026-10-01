#!/usr/bin/env node
/**
 * 百炼全流程端到端（手动、花钱）：故事 -> 脚本/分镜 -> 角色参考图 -> 首帧图 -> 旁白 TTS -> 视频（文生视频 + 首帧生视频）
 * -> 字幕 -> 时间线 -> 导出。全程通过本地服务的 REST 接口驱动（进程内启动 packages/local，临时目录，不碰用户数据）。
 *
 * 用法：
 *   BAILIAN_API_KEY=... node scripts/bailian-e2e.mjs            # 真实运行，会产生费用
 *   node scripts/bailian-e2e.mjs                                 # 没有 Key：打印跳过原因，退出码 0
 *   node scripts/bailian-e2e.mjs --require-key                   # 没有 Key：退出码 2（CI 用）
 *
 * 环境变量（Key 只从环境变量读取，绝不写入文件或日志）：
 *   BAILIAN_API_KEY        必填才会真实运行
 *   BAILIAN_BASE_URL       可选，工作空间 Key（sk-ws-…）必须填工作空间域名
 *   E2E_MAX_SPEND_RMB      花费硬上限（元），默认 5。用本地服务已有的花费守卫（月度上限）拦截，超出即中止
 *   E2E_OUT_DIR            结果目录，默认 ./bailian-e2e-out
 *   E2E_STORY              故事文本，默认内置一个很短的古风小故事
 *   E2E_TEXT_MODEL / E2E_PORTRAIT_MODEL / E2E_FRAME_MODEL / E2E_TTS_MODEL / E2E_T2V_MODEL / E2E_KF2V_MODEL  覆盖模型
 *   E2E_SKIP_EXPORT=1      跳过导出（不需要 lycore / ffmpeg）
 *   LYCORE_ENDPOINT        已有 lycore 的管道/UDS 路径；未设置时尝试用 packages/core/target 下已编译的 lycore
 *
 * 花费说明：守卫和“实测花费”都按价格表估算（configs/prices.json 目前是示例价；任务结果里的用量没有回写花费记录），
 * 真实花费以百炼账单为准。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const localRoot = path.join(repoRoot, 'packages', 'local');
const require = createRequire(import.meta.url);

const DEFAULT_STORY = '雨夜古庙里，书生遇见一位等了三年的女子。她请书生帮忙寻找一枚遗失的玉佩，书生答应了，两人冒雨走进山林。';
const T2V_SECONDS = 5; // 万相视频已验证的最短时长（wan2.6-t2v 720P 5 秒、wan2.2-kf2v-flash 480P 5 秒）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const spokenLen = (t) => (String(t || '').match(/[\p{Script=Han}\p{L}\p{N}]/gu) || []).length;

/** 旁白要塞进 5 秒镜头：按句取到约 22 个字，第一句太长就在第一个停顿处截断。 */
export function fitDialogue(text, maxChars = 22) {
  const clean = String(text || '').replace(/^[^：:]{1,12}[：:]/, '').trim(); // 去掉“角色名：”前缀
  const sentences = clean.match(/[^。！？!?…]+[。！？!?…]?/g) || [];
  let out = '';
  for (const s of sentences) {
    if (spokenLen(out + s) > maxChars) break;
    out += s;
  }
  if (out) return out.trim();
  const first = clean.split(/[，,、；;]/)[0] || clean;
  return Array.from(first).slice(0, maxChars).join('');
}

function findLycoreBinary() {
  const exe = process.platform === 'win32' ? 'lycore.exe' : 'lycore';
  const found = ['release', 'debug'].map((p) => path.join(repoRoot, 'packages', 'core', 'target', p, exe)).filter((p) => fs.existsSync(p));
  return found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
}

function hasCmd(cmd, args = ['-version']) {
  try { return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0; } catch (_) { return false; }
}

/**
 * 运行整条流程。返回 { ok, rows, spend }，不会抛出（阶段错误记入 rows）。
 * opts 主要给测试注入（模拟服务地址、快速轮询）；命令行入口从环境变量构造。
 */
export async function run(opts) {
  const cap = Number.isFinite(opts.maxSpend) && opts.maxSpend >= 0 ? opts.maxSpend : 5;
  const outDir = path.resolve(opts.outDir || 'bailian-e2e-out');
  const pollMs = opts.pollMs || 2000;
  const models = {
    text: 'qwen-plus', portrait: 'wan2.6-t2i', frame: 'wan2.6-image', tts: 'cosyvoice-v2', t2v: 'wan2.6-t2v', kf2v: 'wan2.2-kf2v-flash',
    ...(opts.models || {}),
  };
  const { redact } = require(path.join(localRoot, 'scripts', 'lib', 'redact.js'));
  const say = (s) => console.log(redact(s, [opts.apiKey]));
  const rows = [];
  const results = {};
  const t00 = Date.now();
  fs.mkdirSync(outDir, { recursive: true });

  let server = null;
  let core = null;
  let aiQueue = null;
  let tmp = null;
  const cwd0 = process.cwd();
  let aborted = null;

  async function stage(name, fn, { skip } = {}) {
    const t0 = Date.now();
    const row = { stage: name, status: 'PASS', ms: 0, detail: '' };
    rows.push(row);
    if (aborted) { row.status = 'SKIP'; row.detail = `已中止：${aborted}`; return undefined; }
    if (skip) { row.status = 'SKIP'; row.detail = skip; return undefined; }
    try {
      const d = await fn();
      row.detail = d == null ? '' : String(d);
      return d;
    } catch (e) {
      row.status = 'FAIL';
      row.detail = redact(e && e.message ? e.message : String(e), [opts.apiKey]);
      if (e && e.abort) aborted = row.detail;
      else aborted = `阶段 ${name} 失败`; // 失败即停，避免继续花钱
      return undefined;
    } finally {
      row.ms = Date.now() - t0;
      say(`[${row.status}] ${name} ${row.ms}ms ${row.detail}`);
    }
  }

  let base = '';
  async function api(method, p, body) {
    const res = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* not json */ }
    if (!res.ok || (json && json.success === false)) {
      const msg = json && json.error ? `${json.error.code}: ${json.error.message}` : text.slice(0, 200);
      const err = new Error(`${method} ${p} -> ${res.status} ${msg}`);
      if (json && json.error && json.error.code) err.apiCode = json.error.code;
      if (err.apiCode === 'SPEND_LIMIT') err.abort = true; // 花费守卫拒绝：立刻中止
      throw err;
    }
    return json && 'data' in json ? json.data : json;
  }

  const projectTag = `e2e-${Date.now()}`;
  let seq = 0;
  async function enqueue(kind, params) {
    const task = await api('POST', '/ai-tasks', { idempotency_key: `${projectTag}-${kind}-${++seq}`, provider: 'bailian', kind, params, project_id: projectTag });
    return task.id;
  }
  async function waitTask(id, label, timeoutMs) {
    const t0 = Date.now();
    for (;;) {
      const t = await api('GET', `/ai-tasks/${id}`);
      if (t.state === 'succeeded') return t;
      if (t.state === 'failed' || t.state === 'cancelled') {
        const e = new Error(`${label} 失败：${t.error_code || t.state} ${t.error_readable || t.error_message || ''}`.trim());
        if (t.error_code === 'SPEND_LIMIT') e.abort = true;
        throw e;
      }
      if (Date.now() - t0 > timeoutMs) throw new Error(`${label} 超时（${Math.round(timeoutMs / 1000)} 秒，状态 ${t.state}）`);
      await sleep(pollMs);
    }
  }
  const taskFile = (t) => (t.result && Array.isArray(t.result.files) && t.result.files[0]) || null;

  async function spendNow() {
    const s = await api('GET', '/spend/summary');
    return { spent: s.month.spent, inFlight: s.month.in_flight_max, sample: s.sample_prices, currency: s.currency, summary: s };
  }
  async function guardCap(label) {
    if (story && story.t2vTask) {
      const t = await api('GET', `/ai-tasks/${story.t2vTask}`);
      if (t.state === 'failed' && t.error_code === 'SPEND_LIMIT') { const e = new Error(`${label}：文生视频被花费上限拦下（${t.error_message || ''}）`); e.abort = true; throw e; }
    }
    const s = await spendNow();
    if (s.spent > cap) { const e = new Error(`${label}：已花 ${s.spent} 超过上限 ${cap}`); e.abort = true; throw e; }
  }
  const copyOut = (rel, name) => {
    const src = path.join(storageRoot, ...rel.split('/'));
    const dst = path.join(outDir, name);
    fs.copyFileSync(src, dst);
    return dst;
  };

  let storageRoot = '';
  let story = null; // { dramaId, episodeId, shots: [{id, no, row, plan}] , characters }

  try {
    // ---- 1 启动本地服务 ------------------------------------------------------------------
    await stage('setup 本地服务+配置+花费上限', async () => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bailian-e2e-'));
      storageRoot = path.join(tmp, 'data', 'storage');
      process.chdir(tmp); // 本地服务的数据库和存储目录相对工作目录
      if (!opts.skipExport) {
        let endpoint = process.env.LYCORE_ENDPOINT || '';
        if (!endpoint) {
          const bin = opts.lycoreBinary === undefined ? findLycoreBinary() : opts.lycoreBinary;
          if (bin) {
            endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\bailian-e2e-${process.pid}` : path.join(tmp, 'core.sock');
            core = spawn(bin, ['--pipe', endpoint, '--log-dir', path.join(tmp, 'core-log')], { stdio: 'ignore' });
            process.env.LYCORE_ENDPOINT = endpoint;
          }
        }
      }
      const { createApp } = require(path.join(localRoot, 'src', 'app.js'));
      const { FileSecretStore, createAesCipher } = require(path.join(localRoot, 'src', 'secrets'));
      const secretStore = new FileSecretStore({ cipher: createAesCipher(crypto.randomBytes(32)), filePath: path.join(tmp, 'secrets.enc.json') });
      const made = createApp({ secretStore, ...(opts.appOptions || {}) });
      aiQueue = made.aiQueue;
      server = await new Promise((resolve) => { const s = made.app.listen(0, '127.0.0.1', () => resolve(s)); });
      base = `http://127.0.0.1:${server.address().port}/api/v1`;
      aiQueue.worker.start();
      // 只存一份文本配置，和首次引导向导一致：图像/视频/配音靠同一个 Key 自动复用（队列适配器的共享 Key 回退）
      await api('POST', '/ai-configs', {
        service_type: 'text', name: 'e2e 百炼', provider: 'dashscope', base_url: opts.baseUrl || 'https://dashscope.aliyuncs.com',
        api_key: opts.apiKey, model: [models.text], default_model: models.text, is_default: true,
      });
      await api('PUT', '/spend/limits', { monthly_cap: cap, per_run_cap: cap });
      return `花费上限 ${cap} 元（月度守卫，按价格表估算）`;
    });

    // ---- 2 故事 -> 脚本/分镜 -------------------------------------------------------------
    await stage('script 故事->脚本分镜', async () => {
      const created = await api('POST', '/scriptgen/projects', {
        story: opts.story || DEFAULT_STORY, templateId: 'guofeng-drama', aspectRatio: '16:9', durationSec: 30, title: 'e2e 小故事', model: models.text,
      });
      const list = (await api('GET', `/episodes/${created.episode_id}/storyboards`)).storyboards;
      if (list.length < 3) throw new Error(`分镜只有 ${list.length} 个，至少需要 3 个`);
      for (const extra of list.slice(3)) await api('DELETE', `/storyboards/${extra.id}`); // 控制花费：只做前 3 镜
      const keep = list.slice(0, 3);
      for (const sb of keep) await api('PUT', `/storyboards/${sb.id}`, { duration: T2V_SECONDS }); // 视频实际 5 秒，时间线按它排
      const drama = await api('GET', `/dramas/${created.drama_id}`);
      let meta = drama.metadata;
      if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch (_) { meta = {}; } }
      const chars = (meta && meta.characters) || [];
      story = { dramaId: created.drama_id, episodeId: created.episode_id, shots: keep, characters: chars };
      return `项目 ${created.drama_id}，保留 ${keep.length}/${list.length} 镜，角色 ${chars.length} 个`;
    });

    // ---- 3 角色参考图（文生图） ----------------------------------------------------------
    await stage('character 角色参考图(T2I)', async () => {
      const c = story.characters[0];
      if (!c) throw new Error('脚本没有产生角色，无法做角色参考图');
      const id = await enqueue('image', { model: models.portrait, prompt: `${c.name}，${c.appearance || ''}，古风人物半身像，正面，纯色背景，细节清晰`.slice(0, 600), size: '1024*1024' });
      const t = await waitTask(id, '角色图', 5 * 60_000);
      const f = taskFile(t);
      if (!f) throw new Error('角色图没有下载到本地');
      story.portrait = { url: t.result.urls[0], file: f.path, name: c.name };
      copyOut(f.path, 'portrait.png');
      return `${c.name} -> ${f.path}`;
    });

    // 文生视频最慢，在角色图成功后再提交（图片阶段失败时不留下无人领取的计费任务），和后面的图像/配音并行；它也是最贵的一步，被花费上限拦下就整条中止
    await stage('video_t2v_submit 提交文生视频(第1镜)', async () => {
      const s1 = story.shots[0];
      story.t2vTask = await enqueue('video', { model: models.t2v, prompt: s1.video_prompt || s1.description, duration: T2V_SECONDS, size: '1280*720', resolution: '720P' });
      return `任务 ${story.t2vTask}`;
    });

    // ---- 4 首帧图（带角色参考图） --------------------------------------------------------
    await stage('frames 首帧图(带角色参考图)', async () => {
      await guardCap('首帧图前');
      const targets = story.shots.slice(1);
      const ids = await Promise.all(targets.map((sb) => enqueue('image', {
        model: models.frame, size: '1280*720', referenceImages: [opts.inlineFrames ? story.portrait.file : story.portrait.url],
        prompt: `${sb.image_prompt || sb.description}。人物形象与参考图保持一致。`.slice(0, 800),
      })));
      const done = await Promise.all(ids.map((id, i) => waitTask(id, `第 ${i + 2} 镜首帧`, 5 * 60_000)));
      done.forEach((t, i) => {
        const f = taskFile(t);
        if (!f) throw new Error(`第 ${i + 2} 镜首帧没有下载到本地`);
        targets[i].frame = { url: t.result.urls[0], file: f.path };
        copyOut(f.path, `frame_shot${i + 2}.png`);
      });
      return `${done.length} 张`;
    });

    // ---- 5 旁白（CosyVoice，带逐字时间戳） -----------------------------------------------
    await stage('tts 旁白(CosyVoice+时间戳)', async () => {
      await guardCap('配音前');
      const jobs = story.shots.map((sb) => {
        const text = fitDialogue(sb.dialogue);
        return text ? { sb, text } : null;
      }).filter(Boolean);
      if (!jobs.length) throw new Error('三个镜头都没有台词');
      const ids = await Promise.all(jobs.map((j) => enqueue('tts', { model: models.tts, text: j.text, wordTimestamps: true })));
      const done = await Promise.all(ids.map((id, i) => waitTask(id, `第 ${jobs[i].sb.storyboard_number || i + 1} 镜配音`, 5 * 60_000)));
      done.forEach((t, i) => {
        const r = t.result || {};
        if (!r.path) throw new Error('配音结果缺少音频文件');
        let words = [];
        if (r.words && r.words.path) words = JSON.parse(fs.readFileSync(path.join(storageRoot, ...r.words.path.split('/')), 'utf8'));
        jobs[i].sb.voice = { file: r.path, words, text: jobs[i].text };
        copyOut(r.path, `narration_${jobs[i].sb.id}.mp3`);
      });
      return `${done.length} 条，共 ${jobs.reduce((n, j) => n + spokenLen(j.text), 0)} 字，逐字时间戳 ${jobs.filter((j) => j.sb.voice.words.length).length}/${jobs.length} 条`;
    });

    // ---- 6 视频：文生视频（第 1 镜）+ 首帧生视频（第 2、3 镜） ----------------------------
    await stage('video_t2v 文生视频(第1镜)', async () => {
      const t = await waitTask(story.t2vTask, '文生视频', 15 * 60_000);
      const f = taskFile(t);
      if (!f) throw new Error('视频没有下载到本地（video_url 24 小时过期，需尽快下载）');
      story.shots[0].video = f.path;
      copyOut(f.path, 'shot1_t2v.mp4');
      return `${models.t2v} -> ${f.path} (${f.size} 字节)`;
    });
    await stage('video_kf2v 首帧生视频(第2、3镜)', async () => {
      await guardCap('首帧视频前');
      const targets = story.shots.slice(1);
      const ids = await Promise.all(targets.map((sb) => enqueue('video', {
        model: models.kf2v, prompt: sb.video_prompt || sb.description, firstFrameUrl: opts.inlineFrames ? sb.frame.file : sb.frame.url, resolution: '480P',
      })));
      const done = await Promise.all(ids.map((id, i) => waitTask(id, `第 ${i + 2} 镜首帧视频`, 15 * 60_000)));
      done.forEach((t, i) => {
        const f = taskFile(t);
        if (!f) throw new Error(`第 ${i + 2} 镜视频没有下载到本地`);
        targets[i].video = f.path;
        copyOut(f.path, `shot${i + 2}_kf2v.mp4`);
      });
      return `${models.kf2v} x ${done.length}`;
    });

    // ---- 7 回写分镜 + 组装时间线 + 字幕 --------------------------------------------------
    await stage('link 结果回写分镜', async () => {
      // 队列任务结果不会自动写回分镜（见 docs/bailian-flow-coverage.md），这里由脚本显式回写
      for (const sb of story.shots) {
        await api('PUT', `/storyboards/${sb.id}`, {
          video_url: sb.video, ...(sb.frame ? { image_url: sb.frame.file, local_path: sb.frame.file } : {}), ...(sb.voice ? { narration_audio_local_path: sb.voice.file } : {}),
        });
      }
      return `${story.shots.length} 镜`;
    });
    await stage('timeline 组装时间线+字幕', async () => {
      let tl = await api('POST', `/timelines/episode/${story.episodeId}/assemble`, { replace: true });
      const vtrack = tl.tracks.find((t) => t.kind === 'video');
      // 字幕由台词行推导：每个分镜只能有一条字幕，起止时间跟随视频（不能按逐字时间戳拆成多条）。
      // 组装结果里已有的字幕原样保留，没有的分镜补一条（整段旁白文字，铺满该镜头）。
      const sub = tl.tracks.find((t) => t.kind === 'subtitle');
      const clips = [...sub.clips];
      let added = 0;
      for (const vc of vtrack.clips) {
        const sb = story.shots.find((s) => s.id === vc.storyboard_id);
        if (!sb || !sb.voice || !sb.voice.text || clips.some((c) => c.storyboard_id === sb.id)) continue;
        clips.push({ id: crypto.randomUUID(), start_ms: vc.start_ms, duration_ms: vc.duration_ms, text: sb.voice.text, storyboard_id: sb.id, volume: 1 });
        added++;
      }
      if (!clips.length) throw new Error('没有生成任何字幕（分镜没有台词/旁白文字）');
      if (added) {
        tl = await api('PUT', `/timelines/${tl.id}`, {
          episode_id: story.episodeId,
          tracks: tl.tracks.map((t) => (t.kind === 'subtitle' ? { ...t, clips } : t)),
        });
      }
      story.timeline = tl;
      const narr = tl.tracks.find((t) => t.kind === 'narration').clips.length;
      return `视频 ${vtrack.clips.length} 段，旁白 ${narr} 段，字幕 ${clips.length} 条（补充 ${added} 条），总长 ${tl.duration_ms} 毫秒`;
    });

    // ---- 8 导出 -------------------------------------------------------------------------
    const exportSkip = opts.skipExport ? '按要求跳过（E2E_SKIP_EXPORT）'
      : !core && !process.env.LYCORE_ENDPOINT ? '没有可用的 lycore（未设 LYCORE_ENDPOINT，packages/core/target 下也没有已编译的二进制：cd packages/core && cargo build --release）'
        : !hasCmd('ffmpeg') ? '本机没有 ffmpeg' : undefined;
    await stage('export 导出 mp4(lycore)', async () => {
      const out = path.join(outDir, 'final.mp4');
      const started = await api('POST', '/export/start', { episode_id: story.episodeId, width: 1280, height: 720, fps: 24, encoder: 'auto', output_path: out });
      const t0 = Date.now();
      let s;
      for (;;) {
        s = await api('GET', `/export/${started.job_id}/status`);
        if (['done', 'failed', 'cancelled'].includes(s.status)) break;
        if (Date.now() - t0 > 10 * 60_000) throw new Error('导出超时');
        await sleep(1000);
      }
      if (s.status !== 'done') throw new Error(`导出${s.status}：${JSON.stringify(s.error || '').slice(0, 200)}`);
      if (!fs.existsSync(out) || fs.statSync(out).size === 0) throw new Error('导出文件不存在或为空');
      let probe = '';
      if (hasCmd('ffprobe')) {
        const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', out], { encoding: 'utf8' });
        probe = `，时长 ${String(r.stdout).trim()} 秒`;
      }
      return `${out} (${fs.statSync(out).size} 字节)${probe}`;
    }, { skip: exportSkip });
  } finally {
    // ---- 9 花费 + 收尾 --------------------------------------------------------------------
    let spend = null;
    if (base) {
      try { spend = await spendNow(); } catch (_) { /* service gone */ }
    }
    results.spend = spend;
    try { if (aiQueue) await aiQueue.worker.stop(); } catch (_) { /* ignore */ }
    try { if (server) await new Promise((r) => server.close(r)); } catch (_) { /* ignore */ }
    try { if (core) core.kill(); } catch (_) { /* ignore */ }
    try { require(path.join(localRoot, 'src', 'db')).closeDb(); } catch (_) { /* ignore */ }
    process.chdir(cwd0);

    const line = (r) => `${r.status.padEnd(4)} | ${r.stage.padEnd(34)} | ${String(r.ms).padStart(7)} ms | ${r.detail}`;
    say('\n==== 百炼全流程端到端结果 ====');
    say('结果 | 阶段                               |    耗时   | 说明');
    for (const r of rows) say(line(r));
    if (spend) {
      say(`\n实测花费（按价格表估算）：${spend.spent} ${spend.currency}，上限 ${cap}${spend.sample ? '；价格表是示例价，真实花费以百炼账单为准' : ''}`);
      if (spend.summary && spend.summary.by_model) for (const m of spend.summary.by_model) say(`  ${m.provider}/${m.model || '-'}  ${m.count} 次  ${m.cost}`);
    }
    say(`总耗时 ${Math.round((Date.now() - t00) / 1000)} 秒，结果目录 ${outDir}`);
    try {
      fs.writeFileSync(path.join(outDir, 'result.json'), redact(JSON.stringify({ rows, spend: spend && { spent: spend.spent, currency: spend.currency, sample: spend.sample }, cap }, null, 2), [opts.apiKey]));
    } catch (_) { /* ignore */ }
    results.rows = rows;
  }
  const ok = rows.length > 0 && rows.every((r) => r.status !== 'FAIL');
  return { ok, rows, spend: results.spend };
}

async function main() {
  const argv = process.argv.slice(2);
  const apiKey = process.env.BAILIAN_API_KEY;
  if (!apiKey) {
    console.log('SKIP 百炼端到端：未设置环境变量 BAILIAN_API_KEY，没有花任何钱，也没有联网。设置后重跑即可（会产生费用，默认上限 5 元）。');
    process.exit(argv.includes('--require-key') ? 2 : 0);
  }
  const env = process.env;
  const maxSpend = env.E2E_MAX_SPEND_RMB === undefined || env.E2E_MAX_SPEND_RMB === '' ? 5 : Number(env.E2E_MAX_SPEND_RMB);
  if (!Number.isFinite(maxSpend) || maxSpend < 0) { console.error('E2E_MAX_SPEND_RMB 必须是非负数字'); process.exit(2); }
  const r = await run({
    apiKey,
    baseUrl: env.BAILIAN_BASE_URL || undefined,
    maxSpend,
    outDir: env.E2E_OUT_DIR || 'bailian-e2e-out',
    story: env.E2E_STORY || undefined,
    skipExport: env.E2E_SKIP_EXPORT === '1',
    inlineFrames: env.E2E_INLINE_FRAMES === '1',
    models: Object.fromEntries(Object.entries({
      text: env.E2E_TEXT_MODEL, portrait: env.E2E_PORTRAIT_MODEL, frame: env.E2E_FRAME_MODEL, tts: env.E2E_TTS_MODEL, t2v: env.E2E_T2V_MODEL, kf2v: env.E2E_KF2V_MODEL,
    }).filter(([, v]) => v)),
  });
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('E2E 脚本异常：', e && e.message); process.exit(1); });
}
