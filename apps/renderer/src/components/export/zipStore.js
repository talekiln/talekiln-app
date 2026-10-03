// 极简 ZIP 写入器（仅 store，不压缩；不支持 zip64，单文件与总量需小于 4GB）。
// 用于“素材打包”：图片/视频/音频本身已是压缩格式，store 即可，也避免引入依赖。
// 文件名按 UTF-8 写入并置通用标志位 bit 11，Windows 资源管理器与 7-Zip 均可正确显示中文名。

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes, seed = 0) {
  let c = (seed ^ 0xffffffff) >>> 0
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const LIMIT = 0xffffffff
const encoder = new TextEncoder()

function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date()
  const year = Math.min(2107, Math.max(1980, d.getFullYear()))
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const day = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, day }
}

/** 规整条目名：反斜杠转斜杠、去掉盘符/开头斜杠与 .. 段，避免解压时越出目标目录 */
export function safeEntryName(name) {
  const parts = String(name ?? '')
    .replace(/\\/g, '/')
    .replace(/^[a-zA-Z]:/, '')
    .split('/')
    .filter((p) => p && p !== '.' && p !== '..')
  return parts.join('/')
}

/**
 * const zip = createZipWriter()
 * zip.add('assets/a.png', uint8array)
 * const bytes = zip.finish()   // Uint8Array
 */
export function createZipWriter() {
  const chunks = []
  const entries = []
  let offset = 0
  let finished = false
  const names = new Set()

  function push(buf) {
    chunks.push(buf)
    offset += buf.length
  }

  return {
    get count() {
      return entries.length
    },
    has(name) {
      return names.has(safeEntryName(name))
    },
    add(name, data, options = {}) {
      if (finished) throw new Error('zip already finished')
      const clean = safeEntryName(name)
      if (!clean) throw new Error('empty entry name')
      if (names.has(clean)) throw new Error(`duplicate entry: ${clean}`)
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
      if (bytes.length > LIMIT || offset + bytes.length > LIMIT) throw new Error('zip too large (zip64 unsupported)')
      names.add(clean)
      const nameBytes = encoder.encode(clean)
      const { time, day } = dosDateTime(options.date)
      const crc = crc32(bytes)
      const local = new DataView(new ArrayBuffer(30))
      local.setUint32(0, 0x04034b50, true)
      local.setUint16(4, 20, true)
      local.setUint16(6, 0x0800, true)
      local.setUint16(8, 0, true)
      local.setUint16(10, time, true)
      local.setUint16(12, day, true)
      local.setUint32(14, crc, true)
      local.setUint32(18, bytes.length, true)
      local.setUint32(22, bytes.length, true)
      local.setUint16(26, nameBytes.length, true)
      local.setUint16(28, 0, true)
      entries.push({ nameBytes, crc, size: bytes.length, time, day, offset })
      push(new Uint8Array(local.buffer))
      push(nameBytes)
      push(bytes)
    },
    finish() {
      if (finished) throw new Error('zip already finished')
      finished = true
      const centralStart = offset
      for (const e of entries) {
        const h = new DataView(new ArrayBuffer(46))
        h.setUint32(0, 0x02014b50, true)
        h.setUint16(4, 20, true)
        h.setUint16(6, 20, true)
        h.setUint16(8, 0x0800, true)
        h.setUint16(10, 0, true)
        h.setUint16(12, e.time, true)
        h.setUint16(14, e.day, true)
        h.setUint32(16, e.crc, true)
        h.setUint32(20, e.size, true)
        h.setUint32(24, e.size, true)
        h.setUint16(28, e.nameBytes.length, true)
        h.setUint32(42, e.offset, true)
        push(new Uint8Array(h.buffer))
        push(e.nameBytes)
      }
      const centralSize = offset - centralStart
      if (entries.length > 0xffff || offset > LIMIT) throw new Error('zip too large (zip64 unsupported)')
      const end = new DataView(new ArrayBuffer(22))
      end.setUint32(0, 0x06054b50, true)
      end.setUint16(8, entries.length, true)
      end.setUint16(10, entries.length, true)
      end.setUint32(12, centralSize, true)
      end.setUint32(16, centralStart, true)
      push(new Uint8Array(end.buffer))
      const out = new Uint8Array(offset)
      let pos = 0
      for (const c of chunks) {
        out.set(c, pos)
        pos += c.length
      }
      return out
    },
  }
}
