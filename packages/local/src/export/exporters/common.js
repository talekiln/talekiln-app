'use strict';
// Premiere / FCPXML / 字幕共用的小工具（纯函数）。

const xmlEscape = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  // XML 1.0 不允许的控制字符直接去掉
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');

/** 毫秒 -> 帧（四舍五入）。起点和终点各自取整再相减，相邻片段不会因取整出现缝隙或重叠。 */
const msToFrames = (ms, fps) => Math.round((ms * fps) / 1000);

/** 把一个片段的 [start, start+dur) 换成整数帧区间；最短 1 帧。 */
function frameSpan(startMs, durMs, fps) {
  const start = msToFrames(startMs, fps);
  const end = Math.max(start + 1, msToFrames(startMs + durMs, fps));
  return { start, end, duration: end - start };
}

/** 素材的帧时长：优先真实时长，其次片段用到的最大 src_out，再不行用片段时长。 */
function mediaFrames(ref, durations, maxUse, fps, fallbackMs) {
  const ms = (durations && durations[ref]) || maxUse[ref] || fallbackMs;
  return Math.max(1, msToFrames(ms, fps));
}

const pad = (n, w) => String(n).padStart(w, '0');
function srtTime(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms % 1000, 3)}`;
}

/** 字幕轨 -> SRT 文本（UTF-8，Premiere 导入字幕/说明文字用）。 */
function buildSrt(view) {
  const clips = (view.tracks.find((t) => t.kind === 'subtitle') || { clips: [] }).clips.filter((c) => c.text);
  return clips.map((c, i) => `${i + 1}\n${srtTime(c.start_ms)} --> ${srtTime(c.start_ms + c.duration_ms)}\n${String(c.text).replace(/\r?\n/g, '\n')}\n`).join('\n');
}

/** 每个素材路径在时间线里被用到的最大 src_out_ms（真实素材时长未知时的近似）。 */
function maxUseOf(view) {
  const maxUse = {};
  for (const t of view.tracks) {
    if (!['video', 'narration', 'music'].includes(t.kind)) continue;
    for (const c of t.clips) if (c.asset_ref) maxUse[c.asset_ref] = Math.max(maxUse[c.asset_ref] || 0, c.src_out_ms ?? (c.src_in_ms || 0) + c.duration_ms);
  }
  return maxUse;
}

module.exports = { xmlEscape, msToFrames, frameSpan, mediaFrames, buildSrt, srtTime, maxUseOf };
