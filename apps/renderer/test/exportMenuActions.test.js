import test from 'node:test'
import assert from 'node:assert/strict'
import { setLocale } from '../src/i18n/index.js'
import { createExportActions, loadSheetData } from '../src/components/export/exportActions.js'

const TIMELINE = {
  tracks: [{ kind: 'subtitle', clips: [{ start_ms: 0, duration_ms: 1500, text: 'Hello' }, { start_ms: 2000, duration_ms: 1000, text: 'World' }] }],
}

function harness(deps = {}) {
  const calls = { dialogs: [], notes: [], texts: [], bytes: [], zips: [], backups: [], sheets: [] }
  const actions = createExportActions({
    notify: (type, key, params) => calls.notes.push({ type, key, params }),
    loadTimeline: async () => TIMELINE,
    loadSheetData: async () => ({ storyboards: [{ id: 1 }, { id: 2 }], characters: [], scenes: [], props: [], framePrompts: {} }),
    exportSheet: (ctx, name) => { calls.sheets.push({ ctx, name }); return { ok: true, count: 2 } },
    loadAssetPackData: async () => [{ id: 1, storyboard_number: 1, local_path: 'a.png' }],
    fetchBytes: async () => new Uint8Array([1, 2, 3]),
    saveText: (f) => calls.texts.push(f),
    saveBytes: (f) => calls.bytes.push(f),
    downloadProjectZip: (d) => calls.zips.push(d),
    downloadFullBackup: async (d) => { calls.backups.push(d) },
    ...deps,
  })
  const ctx = (extra = {}) => ({
    dramaId: 3,
    episodeId: 9,
    openDialog: (id, props) => { calls.dialogs.push({ id, props }); return Promise.resolve(undefined) },
    store: { drama: { id: 3, title: 'My/Show' }, episodes: [{ id: 9, episode_number: 2 }] },
    ...extra,
  })
  return { actions, calls, ctx }
}

test('exposes exactly the eight export.* menu ids', () => {
  const { actions } = harness()
  assert.deepEqual(Object.keys(actions).sort(), [
    'export.assetPack', 'export.fullBackup', 'export.jianying', 'export.premiere',
    'export.projectZip', 'export.srt', 'export.storyboardSheet', 'export.video',
  ])
})

test('video / jianying / premiere open the right dialogs', async () => {
  const { actions, calls, ctx } = harness()
  await actions['export.video'](ctx())
  await actions['export.jianying'](ctx())
  await actions['export.premiere'](ctx())
  assert.deepEqual(calls.dialogs.map((d) => [d.id, d.props.target]), [
    ['export.video', undefined], ['export.media', 'jianying'], ['export.media', 'xmeml'],
  ])
  assert.deepEqual(calls.dialogs[0].props, { dramaId: 3, episodeId: 9 })
})

test('episode-scoped export actions without an episode just warn', async () => {
  const { actions, calls, ctx } = harness()
  for (const id of ['export.video', 'export.jianying', 'export.premiere', 'export.srt', 'export.storyboardSheet', 'export.assetPack']) {
    await actions[id](ctx({ episodeId: null }))
  }
  assert.equal(calls.dialogs.length, 0)
  assert.equal(calls.notes.length, 6)
  assert.ok(calls.notes.every((n) => n.type === 'warning' && n.key === 'export.noEpisode'))
})

test('srt: builds the file from the subtitle track and saves it with a localized name', async () => {
  setLocale('en')
  const { actions, calls, ctx } = harness()
  await actions['export.srt'](ctx())
  assert.equal(calls.texts.length, 1)
  const f = calls.texts[0]
  assert.equal(f.filename, 'My_Show-Ep 2.srt')
  assert.match(f.mime, /^application\/x-subrip/)
  const text = f.text.replace(/^﻿/, '')
  assert.ok(text.startsWith('1\n00:00:00,000 --> 00:00:01,500\nHello'))
  assert.ok(text.includes('2\n00:00:02,000 --> 00:00:03,000\nWorld'))
  assert.deepEqual(calls.notes.at(-1), { type: 'success', key: 'export.srt.done', params: { n: 2 } })
})

test('srt: a timeline without subtitles warns and saves nothing', async () => {
  const { actions, calls, ctx } = harness({ loadTimeline: async () => ({ tracks: [{ kind: 'video', clips: [] }] }) })
  await actions['export.srt'](ctx())
  assert.equal(calls.texts.length, 0)
  assert.equal(calls.notes.at(-1).key, 'export.srt.empty')
})

test('storyboardSheet: loads data, exports once, reports the shot count; empty storyboards warn', async () => {
  setLocale('en')
  const { actions, calls, ctx } = harness()
  await actions['export.storyboardSheet'](ctx())
  assert.equal(calls.sheets.length, 1)
  assert.equal(calls.sheets[0].name, 'My_Show-Ep 2-storyboard-sheet')
  assert.deepEqual(calls.notes.at(-1), { type: 'success', key: 'export.sheet.done', params: { n: 2 } })

  const empty = harness({ loadSheetData: async () => ({ storyboards: [] }) })
  await empty.actions['export.storyboardSheet'](empty.ctx())
  assert.equal(empty.calls.sheets.length, 0)
  assert.equal(empty.calls.notes.at(-1).key, 'export.sheet.empty')
})

test('storyboardSheet: csv fallback is reported separately', async () => {
  const { actions, calls, ctx } = harness({ exportSheet: () => ({ ok: true, count: 2, fallback: 'csv' }) })
  await actions['export.storyboardSheet'](ctx())
  assert.equal(calls.notes.at(-1).key, 'export.sheet.doneCsv')
})

test('projectZip: starts the native download with id and title, no episode needed', async () => {
  const { actions, calls, ctx } = harness()
  await actions['export.projectZip'](ctx({ episodeId: null }))
  assert.deepEqual(calls.zips, [{ id: 3, title: 'My/Show' }])
  assert.equal(calls.notes.at(-1).key, 'export.zip.started')
})

test('fullBackup: success, unavailable (404) and failure are three different messages', async () => {
  const ok = harness()
  await ok.actions['export.fullBackup'](ok.ctx())
  assert.deepEqual(ok.calls.backups, [{ id: 3, title: 'My/Show' }])
  assert.equal(ok.calls.notes.at(-1).key, 'export.backup.done')

  const na = harness({ downloadFullBackup: async () => { const e = new Error('x'); e.reason = 'unavailable'; throw e } })
  await na.actions['export.fullBackup'](na.ctx())
  assert.equal(na.calls.notes.at(-1).key, 'export.backup.unavailable')

  const bad = harness({ downloadFullBackup: async () => { const e = new Error('disk full'); e.reason = 'failed'; throw e } })
  await bad.actions['export.fullBackup'](bad.ctx())
  assert.deepEqual(bad.calls.notes.at(-1), { type: 'error', key: 'export.backup.failed', params: { message: 'disk full' } })
})

test('assetPack: downloads, saves one zip, reports skipped files', async () => {
  setLocale('en')
  const { actions, calls, ctx } = harness({
    loadAssetPackData: async () => [
      { id: 1, storyboard_number: 1, local_path: 'a.png', video_local_path: 'b.mp4' },
    ],
    fetchBytes: async (url) => { if (url.endsWith('b.mp4')) throw new Error('404'); return new Uint8Array([1]) },
  })
  await actions['export.assetPack'](ctx())
  assert.equal(calls.bytes.length, 1)
  assert.equal(calls.bytes[0].filename, 'My_Show-Ep 2-assets.zip')
  assert.equal(calls.bytes[0].mime, 'application/zip')
  const keys = calls.notes.map((n) => n.key)
  assert.ok(keys.includes('export.assetPack.start'))
  assert.ok(keys.includes('export.assetPack.skipped'))
  assert.equal(calls.notes.at(-1).key, 'export.assetPack.done')
})

test('assetPack: no media warns; everything failing errors without saving', async () => {
  const none = harness({ loadAssetPackData: async () => [{ id: 1 }] })
  await none.actions['export.assetPack'](none.ctx())
  assert.equal(none.calls.notes.at(-1).key, 'export.assetPack.empty')
  assert.equal(none.calls.bytes.length, 0)

  const allBad = harness({ fetchBytes: async () => { throw new Error('x') } })
  await allBad.actions['export.assetPack'](allBad.ctx())
  assert.equal(allBad.calls.bytes.length, 0)
  assert.equal(allBad.calls.notes.at(-1).key, 'export.assetPack.failed')
})

test('loadSheetData: gathers storyboards, project assets and per-shot frame prompts; one bad prompt does not fail the sheet', async () => {
  const api = {
    storyboards: async () => ({ storyboards: [{ id: 1 }, { id: 2 }, { id: 3 }], total: 3 }),
    drama: async () => ({ characters: [{ id: 5 }], scenes: [{ id: 6 }], props: [{ id: 7 }] }),
    framePrompts: async (id) => {
      if (id === 2) throw new Error('boom')
      return { frame_prompts: [{ frame_type: 'first', prompt: ' F ' + id }, { frame_type: 'last', prompt: 'L' + id }] }
    },
  }
  const d = await loadSheetData(api, { dramaId: 3, episodeId: 9, concurrency: 2 })
  assert.equal(d.storyboards.length, 3)
  assert.deepEqual(d.characters, [{ id: 5 }])
  assert.deepEqual(d.props, [{ id: 7 }])
  assert.deepEqual(d.framePrompts[1], { first: 'F 1', last: 'L1' })
  assert.deepEqual(d.framePrompts[2], { first: '', last: '' })
  assert.deepEqual(d.framePrompts[3], { first: 'F 3', last: 'L3' })
})

test('loadSheetData: tolerates a missing project (assets just empty) and an array response', async () => {
  const d = await loadSheetData({
    storyboards: async () => [{ id: 1 }],
    drama: async () => { throw new Error('x') },
    framePrompts: async () => ({}),
  }, { dramaId: 1, episodeId: 1 })
  assert.equal(d.storyboards.length, 1)
  assert.deepEqual(d.characters, [])
})
