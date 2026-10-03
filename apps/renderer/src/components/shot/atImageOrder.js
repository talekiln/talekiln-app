// "@image-N" references <-> reference image order (pure).
// Stored / submitted text always uses the canonical token (AT + index, 1-based). The editor shows asset names instead.

/** Canonical token prefix. Written with escapes so the source stays free of CJK literals. */
export const AT = '@图片' // i18n-ignore
export const MAX_REFS = 10
const KIND_ORDER = ['scene', 'character', 'prop']
const TOKEN_RE = new RegExp(`${AT}(\\d+)`, 'g')

/**
 * Reference slots in submission order: scene, then characters, then props (stable inside each kind),
 * keeping only assets that have an image. Index is 1-based and equals the N in the canonical token.
 * @param {{kind: 'scene'|'character'|'prop', id: any, name?: string, thumbUrl?: string}[]} refs
 */
export function buildRefSlots(refs, max = MAX_REFS) {
  const usable = (Array.isArray(refs) ? refs : []).filter((r) => r && r.thumbUrl)
  const ordered = KIND_ORDER.flatMap((k) => usable.filter((r) => r.kind === k))
  return ordered.slice(0, max).map((r, i) => ({
    index: i + 1, kind: r.kind, id: r.id, name: String(r.name == null ? '' : r.name).trim(), thumbUrl: r.thumbUrl,
  }))
}

/** Name shown for a slot: the plain name, or "<kind prefix>·<name>" when two slots share a name. */
export function displayName(slot, slots, prefixes = {}) {
  const dup = slots.filter((s) => s.name === slot.name).length > 1
  if (!slot.name) return `${AT}${slot.index}`
  return dup ? `${prefixes[slot.kind] ?? ''}·${slot.name}` : slot.name
}

/** Canonical -> display. Tokens whose index has no slot stay canonical. */
export function toDisplay(text, slots, prefixes = {}) {
  const raw = text == null ? '' : String(text)
  return raw.replace(TOKEN_RE, (m, n) => {
    const slot = slots.find((s) => s.index === Number(n))
    if (!slot || !slot.name) return m
    return `@${displayName(slot, slots, prefixes)}`
  })
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Display -> canonical. Longest names win, so "@Lin" is not read as "@Li" + "n". */
export function toCanonical(text, slots, prefixes = {}) {
  const raw = text == null ? '' : String(text)
  const byName = new Map()
  for (const s of slots) {
    if (!s.name) continue
    const n = displayName(s, slots, prefixes)
    if (!byName.has(n)) byName.set(n, s.index)
  }
  if (!byName.size) return raw
  const names = [...byName.keys()].sort((a, b) => b.length - a.length)
  const re = new RegExp(`@(${names.map(escapeRe).join('|')})`, 'g')
  return raw.replace(re, (m, n) => `${AT}${byName.get(n)}`)
}

/** Distinct indexes referenced in a canonical text, in order of first appearance. */
export function referencedIndexes(text) {
  const out = []
  for (const m of String(text == null ? '' : text).matchAll(TOKEN_RE)) {
    const n = Number(m[1])
    if (!out.includes(n)) out.push(n)
  }
  return out
}

/** Delete slot n: its own tokens vanish, later ones shift down by one. */
export function removeSlot(text, n) {
  return String(text == null ? '' : text).replace(TOKEN_RE, (m, d) => {
    const i = Number(d)
    if (i === n) return ''
    return i > n ? `${AT}${i - 1}` : m
  })
}

/** Move the asset at slot `from` to slot `to`; text keeps pointing at the same assets. */
export function moveSlot(text, from, to) {
  if (from === to) return text
  return String(text == null ? '' : text).replace(TOKEN_RE, (m, d) => {
    const i = Number(d)
    let j = i
    if (i === from) j = to
    else if (from < to && i > from && i <= to) j = i - 1
    else if (from > to && i >= to && i < from) j = i + 1
    return `${AT}${j}`
  })
}

/** Re-point tokens after the slot list changed, following asset identity (kind + id). Tokens of removed assets are dropped. */
export function remapCanonical(text, before, after) {
  const key = (s) => `${s.kind}:${s.id}`
  const next = new Map(after.map((s) => [key(s), s.index]))
  return String(text == null ? '' : text).replace(TOKEN_RE, (m, d) => {
    const old = before.find((s) => s.index === Number(d))
    if (!old) return m
    const idx = next.get(key(old))
    return idx ? `${AT}${idx}` : ''
  })
}
