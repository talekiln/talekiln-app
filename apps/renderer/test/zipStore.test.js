import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { createZipWriter, crc32, safeEntryName } from '../src/components/export/zipStore.js'

const bytes = (s) => new TextEncoder().encode(s)

/** 按规范手工解析 EOCD + 中央目录 + 本地头，验证写出的结构 */
function parseZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const eocd = buf.length - 22
  assert.equal(dv.getUint32(eocd, true), 0x06054b50)
  const count = dv.getUint16(eocd + 10, true)
  const cdSize = dv.getUint32(eocd + 12, true)
  const cdOff = dv.getUint32(eocd + 16, true)
  assert.equal(cdOff + cdSize, eocd)
  const out = []
  let p = cdOff
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50)
    const flags = dv.getUint16(p + 8, true)
    const method = dv.getUint16(p + 10, true)
    const crc = dv.getUint32(p + 16, true)
    const csize = dv.getUint32(p + 20, true)
    const usize = dv.getUint32(p + 24, true)
    const nlen = dv.getUint16(p + 28, true)
    const lho = dv.getUint32(p + 42, true)
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nlen))
    assert.equal(dv.getUint32(lho, true), 0x04034b50)
    const lnlen = dv.getUint16(lho + 26, true)
    const data = buf.subarray(lho + 30 + lnlen, lho + 30 + lnlen + csize)
    out.push({ name, flags, method, crc, csize, usize, data })
    p += 46 + nlen
  }
  return out
}

test('crc32 matches zlib.crc32', () => {
  for (const s of ['', 'a', 'hello world', '中文内容'.repeat(50)]) {
    assert.equal(crc32(bytes(s)), zlib.crc32(Buffer.from(s)))
  }
})

test('writes a valid store-only archive with correct CRCs, sizes and data', () => {
  const zip = createZipWriter()
  zip.add('a.txt', bytes('hello'))
  zip.add('dir/b.bin', new Uint8Array([0, 1, 2, 255]))
  zip.add('空.txt', new Uint8Array(0))
  const entries = parseZip(zip.finish())
  assert.deepEqual(entries.map((e) => e.name), ['a.txt', 'dir/b.bin', '空.txt'])
  for (const e of entries) {
    assert.equal(e.method, 0)
    assert.equal(e.flags & 0x0800, 0x0800)
    assert.equal(e.csize, e.usize)
    assert.equal(e.crc, zlib.crc32(Buffer.from(e.data)))
  }
  assert.equal(new TextDecoder().decode(entries[0].data), 'hello')
  assert.deepEqual([...entries[1].data], [0, 1, 2, 255])
  assert.equal(entries[2].usize, 0)
})

test('empty archive is just an end-of-central-directory record', () => {
  const buf = createZipWriter().finish()
  assert.equal(buf.length, 22)
  assert.equal(parseZip(buf).length, 0)
})

test('entry names are sanitised: backslashes, drive letters, leading slashes and .. segments', () => {
  assert.equal(safeEntryName('..\\..\\evil.txt'), 'evil.txt')
  assert.equal(safeEntryName('C:\\x\\y.png'), 'x/y.png')
  assert.equal(safeEntryName('/abs/./p.png'), 'abs/p.png')
  assert.equal(safeEntryName(''), '')
})

test('rejects empty and duplicate names, and adding after finish', () => {
  const zip = createZipWriter()
  zip.add('a', bytes('1'))
  assert.throws(() => zip.add('a', bytes('2')), /duplicate/)
  assert.throws(() => zip.add('..', bytes('2')), /empty/)
  assert.equal(zip.has('a'), true)
  assert.equal(zip.count, 1)
  zip.finish()
  assert.throws(() => zip.add('b', bytes('3')), /finished/)
  assert.throws(() => zip.finish(), /finished/)
})

test('an explicit date is encoded as MS-DOS date/time', () => {
  const zip = createZipWriter()
  zip.add('a', bytes('1'), { date: new Date(2024, 4, 6, 7, 8, 10) })
  const buf = zip.finish()
  const dv = new DataView(buf.buffer)
  assert.equal(dv.getUint16(10, true), (7 << 11) | (8 << 5) | 5)
  assert.equal(dv.getUint16(12, true), ((2024 - 1980) << 9) | (5 << 5) | 6)
})
