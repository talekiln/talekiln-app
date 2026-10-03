import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setLocale } from '../src/i18n/index.js'
import { styleName } from '../src/utils/styleName.js'
import { shotLabelsByLegacy, clipDisplayLabel } from '../src/utils/clipLabel.js'
import { previewSummary } from '../src/components/generate/generateConfirm.js'

test('styleName: preset names, custom follows the language, unknown values pass through, empty is empty', () => {
  setLocale('zh-CN')
  assert.equal(styleName('realistic'), '写实')
  assert.equal(styleName('custom'), '自定义')
  assert.equal(styleName('my-own'), 'my-own')
  assert.equal(styleName(''), '')
  assert.equal(styleName(null), '')
  setLocale('en')
  assert.equal(styleName('custom'), 'Custom')
  assert.notEqual(styleName('realistic'), 'realistic')
})

test('StatusBar shows localized style and aspect, not the raw keys', () => {
  const src = readFileSync(new URL('../src/shell/StatusBar.vue', import.meta.url), 'utf8')
  assert.match(src, /styleName\(shell\.style\)/)
  assert.match(src, /aspectLabel\(shell\.aspectRatio\)/)
  assert.doesNotMatch(src, /v: shell\.style\b/)
  assert.doesNotMatch(src, /v: shell\.aspectRatio\b/)
})

const SHOTS = {
  groups: [
    { id: 'g1', shots: [{ id: 's1', legacy_id: 11, params: { title: '' } }, { id: 's2', legacy_id: 12, params: { title: '雨夜' } }] },
    { id: 'g2', shots: [{ id: 's3', legacy_id: 13, params: {} }, { id: 's4', legacy_id: null, params: {} }] },
  ],
}

test('clip labels: shot clips show the shot number (and title), never the asset hash', () => {
  setLocale('en')
  const labels = shotLabelsByLegacy(SHOTS)
  assert.deepEqual(labels, { 11: 'Shot 1', 12: 'Shot 2 · 雨夜', 13: 'Shot 3' })
  const hash = 'media/ab12cd34ef567890ab12cd34ef567890.mp4'
  assert.equal(clipDisplayLabel({ storyboard_id: 13, asset_ref: hash }, labels, 'Clip'), 'Shot 3')
  setLocale('zh-CN')
  assert.equal(clipDisplayLabel({ storyboard_id: 11, asset_ref: hash }, shotLabelsByLegacy(SHOTS), '片段'), '镜 1')
})

test('clip labels: subtitles show their text, music shows the file name, unknown clips use the fallback', () => {
  setLocale('en')
  const labels = shotLabelsByLegacy(SHOTS)
  assert.equal(clipDisplayLabel({ text: 'hello', storyboard_id: 11 }, labels, 'Clip'), 'hello')
  assert.equal(clipDisplayLabel({ asset_ref: ['D:', 'music', 'theme.mp3'].join(String.fromCharCode(92)) }, labels, 'Clip'), 'theme.mp3')
  assert.equal(clipDisplayLabel({ storyboard_id: 99 }, labels, 'Clip'), 'Clip')
  assert.deepEqual(shotLabelsByLegacy(null), {})
})

test('confirm dialog: nothing to generate or adopt is flagged so the "use existing results" button is hidden', () => {
  setLocale('en')
  const none = previewSummary({ items: [{ kind: 'image', action: 'fresh' }], billable: 0, allowed: true, provider_ready: true })
  assert.equal(none.nothingToDo, true)
  assert.equal(none.canConfirm, false)
  const hits = previewSummary({ items: [{ kind: 'image', action: 'cache_hit' }], billable: 0, allowed: true, provider_ready: true })
  assert.equal(hits.nothingToDo, false)
  assert.equal(hits.canConfirm, true)
  const paid = previewSummary({ items: [{ kind: 'image', action: 'create' }], billable: 1, allowed: true, provider_ready: true })
  assert.equal(paid.nothingToDo, false)
  assert.equal(previewSummary(null).nothingToDo, false)
  assert.equal(previewSummary({ items: [], billable: 0, allowed: false }).nothingToDo, false)
  const src = readFileSync(new URL('../src/components/generate/GenerateConfirmDialog.vue', import.meta.url), 'utf8')
  assert.match(src, /v-if="showConfirm"/)
})

test('TimelineEditor labels clips through clipDisplayLabel', () => {
  const src = readFileSync(new URL('../src/views/TimelineEditor.vue', import.meta.url), 'utf8')
  assert.match(src, /clipDisplayLabel\(clip, shotLabels\.value/)
})

test('TopBar keeps Generate and Export together in one wrapping group on narrow widths', () => {
  const src = readFileSync(new URL('../src/shell/TopBar.vue', import.meta.url), 'utf8')
  assert.match(src, /<div class="menus"/)
  assert.match(src, /\.menus \{ margin-left: auto/)
  assert.match(src, /max-width: min\(360px, calc\(100vw - 16px\)\)/)
})
