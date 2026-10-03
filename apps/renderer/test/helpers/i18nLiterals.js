// 检查“已迁移到 t()”的文件里是否还残留中文字面量。纯函数，可单测。
const CJK = /[一-鿿]/
const IGNORE = 'i18n-ignore'

function lineOf(text, index) {
  let n = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++
  return n
}
function lineText(text, line) {
  return text.split('\n')[line - 1] || ''
}

/** 去掉 t(...) / $t(...) 调用（括号配平，兼容引号内的括号），保持长度不变以便行号对应。 */
export function blankTranslatorCalls(src) {
  const out = src.split('')
  const re = /(?<![\w$.])\$?t\(/g
  let m
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length
    let depth = 1
    let quote = null
    for (; i < src.length && depth > 0; i++) {
      const c = src[i]
      if (quote) {
        if (c === '\\') i++
        else if (c === quote) quote = null
      } else if (c === '"' || c === "'" || c === '`') quote = c
      else if (c === '(') depth++
      else if (c === ')') depth--
    }
    for (let k = m.index; k < i; k++) if (out[k] !== '\n') out[k] = ' '
    re.lastIndex = i
  }
  return out.join('')
}

/** 从 JS 源码里取出字符串字面量（跳过注释与正则字面量）。返回 [{ text, index }]。 */
export function stringLiterals(src) {
  const res = []
  let i = 0
  let prevSig = ''
  const n = src.length
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2)
      i = e < 0 ? n : e + 2
      continue
    }
    if (c === '/' && (prevSig === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prevSig))) {
      // 正则字面量
      let inClass = false
      i++
      while (i < n) {
        const ch = src[i]
        if (ch === '\\') { i += 2; continue }
        if (ch === '[') inClass = true
        else if (ch === ']') inClass = false
        else if (ch === '/' && !inClass) { i++; break }
        else if (ch === '\n') break
        i++
      }
      while (/[a-z]/i.test(src[i] || '')) i++
      prevSig = ')'
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const start = i
      i++
      let text = ''
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') { text += src[i] + (src[i + 1] || ''); i += 2; continue }
        if (c !== '`' && src[i] === '\n') break
        text += src[i]
        i++
      }
      i++
      res.push({ text, index: start })
      prevSig = c
      continue
    }
    if (!/\s/.test(c)) prevSig = c
    i++
  }
  return res
}

function scanScript(code, offsetLine, file, problems) {
  const cleaned = blankTranslatorCalls(code)
  for (const lit of stringLiterals(cleaned)) {
    if (!CJK.test(lit.text)) continue
    const line = lineOf(code, lit.index)
    if (lineText(code, line).includes(IGNORE)) continue
    problems.push({ file, line: line + offsetLine, snippet: lit.text.trim().slice(0, 40) })
  }
}

function splitSfc(src) {
  const tpl = src.indexOf('<template')
  const tplEnd = src.lastIndexOf('</template>')
  const sections = { template: null, scripts: [] }
  let tplRange = null
  if (tpl >= 0 && tplEnd > tpl) {
    const open = src.indexOf('>', tpl) + 1
    sections.template = { text: src.slice(open, tplEnd), offset: lineOf(src, open) - 1 }
    tplRange = [tpl, tplEnd + 11]
  }
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/g
  let m
  while ((m = re.exec(src))) {
    if (tplRange && m.index >= tplRange[0] && m.index < tplRange[1]) continue
    const open = m.index + m[0].indexOf('>') + 1
    sections.scripts.push({ text: m[1], offset: lineOf(src, open) - 1 })
  }
  return sections
}

/** 检查一个文件的内容，返回问题列表 [{ file, line, snippet }]。 */
export function findCjkLiterals(file, src) {
  const problems = []
  const text = src.replace(/\r\n/g, '\n')
  if (file.endsWith('.vue')) {
    const { template, scripts } = splitSfc(text)
    if (template) {
      const original = template.text.split('\n')
      const body = blankTranslatorCalls(template.text.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' ')))
      body.split('\n').forEach((ln, idx) => {
        if (!CJK.test(ln)) return
        if ((original[idx] || '').includes(IGNORE)) return
        const hit = ln.match(/[^<>{}"'`]*[一-鿿][^<>{}"'`]*/)
        problems.push({ file, line: idx + 1 + template.offset, snippet: (hit ? hit[0] : ln).trim().slice(0, 40) })
      })
    }
    for (const s of scripts) scanScript(s.text, s.offset, file, problems)
  } else {
    scanScript(text, 0, file, problems)
  }
  return problems
}
