import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { assetPackEntries, buildAssetPack, assetPackFilename } from '../src/components/export/assetPack.js'
import { setLocale } from '../src/i18n/index.js'

const SB = [
  { id: 11, storyboard_number: 1, local_path: 'images/a.png', video_local_path: 'videos/a.mp4', narration_audio_local_path: 'audio/a.mp3' },
  { id: 12, storyboard_number: 2, image_url: 'https://cdn.example.com/x/b.jpg?sig=1', video_url: 'https://cdn.example.com/b' },
  { id: 13, storyboard_number: 3 },
]

test('assetPackEntries: per-shot folders, extension from the path, query stripped, empty shots omitted', () => {
  const e = assetPackEntries(SB)
  assert.deepEqual(e.map((x) => x.name), [
    'shot-001/first-frame.png', 'shot-001/video.mp4', 'shot-001/voice.mp3',
    'shot-002/first-frame.jpg', 'shot-002/video.mp4',
  ])
  assert.equal(e[0].url, '/static/images/a.png')
  assert.equal(e[3].url, 'https://cdn.example.com/x/b.jpg?sig=1')
  assert.equal(e[0].kind, 'image')
})

test('assetPackEntries: falls back to the list index when there is no storyboard number; pads wider numbers', () => {
  const e = assetPackEntries([{ id: 1, local_path: 'a.png' }, { id: 2, storyboard_number: 1234, local_path: 'b.webp' }])
  assert.deepEqual(e.map((x) => x.name), ['shot-001/first-frame.png', 'shot-1234/first-frame.webp'])
})

test('buildAssetPack: the same file referenced by two shots is downloaded once but stored under both names', async () => {
  const entries = assetPackEntries([
    { id: 1, storyboard_number: 1, local_path: 'a.png' },
    { id: 2, storyboard_number: 2, local_path: 'a.png' },
  ])
  assert.equal(entries.length, 2)
  let calls = 0
  const r = await buildAssetPack(entries, { fetchBytes: async () => { calls++; return new Uint8Array([9]) } })
  assert.equal(calls, 1)
  assert.equal(r.added, 2)
})

test('buildAssetPack: fetches every entry, reports progress, and writes a readable archive', async () => {
  const progress = []
  const fetchBytes = async (url) => new TextEncoder().encode(`data:${url}`)
  const r = await buildAssetPack(assetPackEntries(SB), { fetchBytes, onProgress: (done, total) => progress.push([done, total]) })
  assert.equal(r.added, 5)
  assert.deepEqual(r.skipped, [])
  assert.deepEqual(progress.at(-1), [5, 5])
  const buf = r.bytes
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  assert.equal(dv.getUint32(buf.length - 22, true), 0x06054b50)
  assert.equal(dv.getUint16(buf.length - 22 + 10, true), 5)
  assert.ok(zlib.crc32(Buffer.from('data:/static/images/a.png')) >= 0)
})

test('buildAssetPack: a failed download is skipped and reported, the rest still pack', async () => {
  const fetchBytes = async (url) => {
    if (url.includes('b.jpg')) throw new Error('403')
    return new Uint8Array([1, 2, 3])
  }
  const r = await buildAssetPack(assetPackEntries(SB), { fetchBytes })
  assert.equal(r.added, 4)
  assert.deepEqual(r.skipped.map((s) => s.name), ['shot-002/first-frame.jpg'])
  assert.equal(r.skipped[0].reason, '403')
})

test('buildAssetPack: nothing downloadable yields an empty result without bytes', async () => {
  const r = await buildAssetPack([], { fetchBytes: async () => new Uint8Array(1) })
  assert.equal(r.added, 0)
  assert.equal(r.bytes, null)
})

test('buildAssetPack: cancelling stops before the next download', async () => {
  let calls = 0
  let stop = false
  const fetchBytes = async () => { calls++; stop = true; return new Uint8Array(1) }
  const r = await buildAssetPack(assetPackEntries(SB), { fetchBytes, isCancelled: () => stop })
  assert.equal(calls, 1)
  assert.equal(r.cancelled, true)
})

test('assetPackFilename: localized suffix, path characters removed', () => {
  setLocale('en')
  assert.equal(assetPackFilename({ title: 'A/B', episodeNumber: 2 }), 'A_B-Ep 2-assets.zip')
  setLocale('zh-CN')
  assert.equal(assetPackFilename({ title: '我的剧', episodeNumber: 1 }), '我的剧-第1集-素材包.zip')
})
