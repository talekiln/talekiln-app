// SRT 字幕导出（纯函数）。字幕来源是时间线视图的字幕轨（毫秒整数的 start_ms / duration_ms / text）。

const clampMs = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0)

/** 毫秒 -> HH:MM:SS,mmm。先取整再拆分，所以 999.6 会进位成 1.000 秒而不是 "999,1000"。 */
export function formatSrtTimestamp(ms) {
  const total = clampMs(Number(ms))
  const h = Math.floor(total / 3600000)
  const m = Math.floor((total % 3600000) / 60000)
  const s = Math.floor((total % 60000) / 1000)
  const msec = total % 1000
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(h)}:${p(m)}:${p(s)},${p(msec, 3)}`
}

const BREAK_AFTER = /[，。！？；：、,.!?;:）)」』”"]/
const isSpace = (c) => c === ' ' || c === '\t'

/**
 * 把一段文字按“每行最多 max 个字符”折成多行。优先在标点之后或空格处断开；
 * 单词比一行还长时硬切。max <= 0 不折行。
 */
export function wrapCueText(text, max) {
  const src = String(text ?? '')
  const chars = [...src]
  if (!(max > 0) || chars.length <= max) return [src]
  const lines = []
  let i = 0
  while (i < chars.length) {
    while (i < chars.length && isSpace(chars[i])) i++
    if (i >= chars.length) break
    if (chars.length - i <= max) {
      lines.push(chars.slice(i).join('').trimEnd())
      break
    }
    const end = i + max
    // 在 (i, end] 里从后往前找最近的断点：空格处，或标点之后
    let cut = -1
    for (let k = end; k > i; k--) {
      if (k < chars.length && isSpace(chars[k])) { cut = k; break }
      if (BREAK_AFTER.test(chars[k - 1])) { cut = k; break }
    }
    // 断点太靠前（不足 1/3 行）就不如硬切，避免出现很短的行
    if (cut < 0 || cut - i < Math.floor(max / 3)) cut = end
    lines.push(chars.slice(i, cut).join('').trimEnd())
    i = cut
  }
  return lines
}

function normalizeText(text) {
  if (text === null || text === undefined) return ''
  return String(text).replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean).join('\n')
}

/** 时间线视图 -> [{ start_ms, end_ms, text }]（字幕轨）。 */
export function cuesFromTimeline(view) {
  const track = ((view && view.tracks) || []).find((t) => t.kind === 'subtitle')
  return ((track && track.clips) || []).map((c) => ({
    start_ms: c.start_ms,
    end_ms: Number(c.start_ms) + Number(c.duration_ms),
    text: c.text,
  }))
}

function prepare(cues) {
  const list = []
  for (const c of cues || []) {
    if (!c) continue
    const start = Number(c.start_ms)
    const end = c.end_ms !== undefined && c.end_ms !== null ? Number(c.end_ms) : start + Number(c.duration_ms)
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    const s = clampMs(start)
    const e = clampMs(end)
    const text = normalizeText(c.text)
    if (!text || e <= s) continue
    list.push({ start: s, end: e, text })
  }
  list.sort((a, b) => a.start - b.start || a.end - b.end)
  // 重叠：同一起点合并文字；否则把前一条截到后一条开始，保证互不重叠
  const out = []
  for (const c of list) {
    const prev = out[out.length - 1]
    if (prev && c.start <= prev.start) {
      prev.text = `${prev.text}\n${c.text}`
      prev.end = Math.max(prev.end, c.end)
      continue
    }
    if (prev && prev.end > c.start) prev.end = c.start
    out.push({ ...c })
  }
  return out
}

/**
 * 生成 SRT 文本；没有可导出的字幕返回空字符串。
 * options: { maxLineChars = 0（不折行）, maxLines = 0（不限） }：maxLines > 0 时，折行后超过该行数的字幕按字数比例拆成多条。
 */
export function buildSrt(cues, options = {}) {
  const { maxLineChars = 0, maxLines = 0 } = options
  const blocks = []
  const push = (start, end, lines) => {
    blocks.push(`${blocks.length + 1}\n${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}\n${lines.join('\n')}`)
  }
  for (const c of prepare(cues)) {
    const lines = c.text.split('\n').flatMap((l) => wrapCueText(l, maxLineChars))
    if (!(maxLines > 0) || lines.length <= maxLines) {
      push(c.start, c.end, lines)
      continue
    }
    const groups = []
    for (let i = 0; i < lines.length; i += maxLines) groups.push(lines.slice(i, i + maxLines))
    const sizes = groups.map((g) => g.join('').length)
    const total = sizes.reduce((a, b) => a + b, 0) || 1
    let acc = 0
    let cursor = c.start
    groups.forEach((g, i) => {
      acc += sizes[i]
      const end = i === groups.length - 1 ? c.end : c.start + Math.round(((c.end - c.start) * acc) / total)
      push(cursor, end, g)
      cursor = end
    })
  }
  return blocks.length ? `${blocks.join('\n\n')}\n` : ''
}
