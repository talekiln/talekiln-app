import test from 'node:test'
import assert from 'node:assert/strict'
import { GENERATE_MENU, EXPORT_MENU, menuState } from '../src/shell/menus.js'

const ready = { episodeId: 7, shotCount: 5, hasTimeline: true, renderCoreOk: true, draftCount: 2 }
const byId = (list, id) => list.find((i) => i.id === id)

test('menu ids and actions match the plan contract', () => {
  assert.deepEqual(GENERATE_MENU.map((i) => i.id), [
    'generate.pipeline', 'generate.missing', 'generate.allFirstFrames', 'generate.allVideos',
    'generate.allVoice', 'generate.director', 'generate.batchEpisodes', 'generate.rerunDraft',
  ])
  assert.deepEqual(EXPORT_MENU.map((i) => i.id), [
    'export.video', 'export.jianying', 'export.premiere', 'export.srt',
    'export.storyboardSheet', 'export.projectZip', 'export.assetPack', 'export.fullBackup',
  ])
  for (const item of [...GENERATE_MENU, ...EXPORT_MENU]) {
    assert.equal(item.action, item.id, 'action id equals menu id')
    assert.ok(item.group && item.labelKey.startsWith('shell.menu.') && item.descKey.startsWith('shell.menu.'), item.id)
  }
})

test('everything is enabled when the episode is ready', () => {
  for (const item of [...GENERATE_MENU, ...EXPORT_MENU]) {
    assert.deepEqual(menuState(item, ready), { enabled: true }, item.id)
  }
})

test('export.video is disabled without the render core; other exports stay enabled', () => {
  const ctx = { ...ready, renderCoreOk: false }
  assert.deepEqual(menuState(byId(EXPORT_MENU, 'export.video'), ctx), {
    enabled: false, reasonKey: 'shell.menu.reason.renderCore',
  })
  for (const item of EXPORT_MENU.filter((i) => i.id !== 'export.video')) {
    assert.equal(menuState(item, ctx).enabled, true, item.id)
  }
})

test('generate.* are disabled with a reason when there are no shots', () => {
  const ctx = { ...ready, shotCount: 0, draftCount: 0 }
  for (const id of ['generate.pipeline', 'generate.missing', 'generate.allFirstFrames', 'generate.allVideos', 'generate.allVoice']) {
    assert.deepEqual(menuState(byId(GENERATE_MENU, id), ctx), { enabled: false, reasonKey: 'shell.menu.reason.shots' }, id)
  }
})

test('generate.rerunDraft is disabled when there are no draft artifacts', () => {
  assert.deepEqual(menuState(byId(GENERATE_MENU, 'generate.rerunDraft'), { ...ready, draftCount: 0 }), {
    enabled: false, reasonKey: 'shell.menu.reason.draft',
  })
})

test('timeline-dependent exports need a timeline', () => {
  const ctx = { ...ready, hasTimeline: false }
  for (const id of ['export.jianying', 'export.premiere', 'export.srt']) {
    assert.deepEqual(menuState(byId(EXPORT_MENU, id), ctx), { enabled: false, reasonKey: 'shell.menu.reason.timeline' }, id)
  }
})

test('without an episode, episode-bound items say so; project-level items stay enabled', () => {
  const ctx = { episodeId: null, shotCount: 0, hasTimeline: false, renderCoreOk: true, draftCount: 0 }
  assert.deepEqual(menuState(byId(GENERATE_MENU, 'generate.pipeline'), ctx), { enabled: false, reasonKey: 'shell.menu.reason.episode' })
  assert.deepEqual(menuState(byId(EXPORT_MENU, 'export.video'), ctx), { enabled: false, reasonKey: 'shell.menu.reason.episode' })
  assert.equal(menuState(byId(EXPORT_MENU, 'export.fullBackup'), ctx).enabled, true)
  assert.equal(menuState(byId(EXPORT_MENU, 'export.projectZip'), ctx).enabled, true)
  assert.equal(menuState(byId(GENERATE_MENU, 'generate.batchEpisodes'), ctx).enabled, true)
})

test('menuState tolerates a missing ctx', () => {
  assert.equal(menuState(byId(EXPORT_MENU, 'export.fullBackup'), undefined).enabled, true)
  assert.equal(menuState(byId(EXPORT_MENU, 'export.video'), undefined).enabled, false)
})
