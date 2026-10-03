import test from 'node:test'
import assert from 'node:assert/strict'
import { setLocale } from '../src/i18n/index.js'
import {
  sheetColumns, buildStoryboardSheetRows, buildExcelHtml, buildCsvText, movementLabel, sheetContextFrom, sheetFilename,
} from '../src/utils/exportStoryboardSheet.js'

const SB = [
  {
    id: 11, storyboard_number: 1, title: 'Opening', duration: 5, shot_type: 'wide', movement: 'push', location: 'Cafe', time: 'dawn',
    description: 'A quiet cafe', dialogue: 'Hi', narration: 'Morning', action: 'walks in', result: 'sits', atmosphere: 'calm',
    image_prompt: 'img', video_prompt: 'vid', segment_index: 0, segment_title: 'Act one', scene_id: 7, characters: [1, '2', { id: 3 }],
  },
  { id: 12, storyboard_number: 2, duration: 3, segment_index: 0 },
]
const CHARS = [{ id: 1, name: 'Ann', appearance: 'tall' }, { id: 2, name: 'Bob' }, { id: 3 }]
const SCENES = [{ id: 7, location: 'Cafe', time: 'dawn', prompt: 'warm light' }]

test('columns: 24 localized columns in a fixed order', () => {
  setLocale('en')
  const en = sheetColumns()
  assert.equal(en.length, 24)
  assert.equal(en[0], 'No.')
  setLocale('zh-CN')
  const zh = sheetColumns()
  assert.equal(zh.length, 24)
  assert.equal(zh[0], '镜头序号')
  assert.equal(new Set(zh).size, 24)
})

test('movementLabel: known code is localized, unknown code passes through, empty is empty', () => {
  setLocale('zh-CN')
  assert.equal(movementLabel('push'), '推镜')
  setLocale('en')
  assert.equal(movementLabel('push'), 'Push in')
  assert.equal(movementLabel('weird_move'), 'weird_move')
  assert.equal(movementLabel(''), '')
  assert.equal(movementLabel(null), '')
})

test('rows: exactly one row per storyboard, with 24 cells each', () => {
  setLocale('en')
  const ctx = sheetContextFrom({ storyboards: SB, characters: CHARS, scenes: SCENES, props: [] })
  const rows = buildStoryboardSheetRows(ctx)
  assert.equal(rows.length, 2)
  for (const r of rows) assert.equal(r.length, 24)
})

test('rows: fields, segment label, scene block and character blocks (en)', () => {
  setLocale('en')
  const rows = buildStoryboardSheetRows(sheetContextFrom({ storyboards: SB, characters: CHARS, scenes: SCENES, props: [] }))
  const r = rows[0]
  assert.equal(r[0], 1)
  assert.equal(r[1], 1)
  assert.equal(r[2], 'Opening')
  assert.equal(r[3], 'Act 1 - Act one')
  assert.equal(r[4], '5')
  assert.equal(r[5], 'wide')
  assert.equal(r[6], 'Push in')
  assert.match(r[7], /^Cafe\nTime: dawn\nPrompt: warm light$/)
  assert.match(r[8], /^Ann\nAppearance: tall\n\nBob\n\nUnnamed$/)
  assert.equal(r[10], 'Cafe')
  assert.equal(r[12], 'A quiet cafe')
  assert.equal(r[13], 'Hi')
  assert.equal(r[14], 'Morning')
  assert.equal(r[21], 'img')
  assert.equal(r[22], 'vid')
})

test('rows: a storyboard without a title falls back to a numbered name; segment index alone still labelled', () => {
  setLocale('en')
  const rows = buildStoryboardSheetRows(sheetContextFrom({ storyboards: SB, characters: [], scenes: [], props: [] }))
  assert.equal(rows[1][2], 'Shot 2')
  assert.equal(rows[1][3], 'Act 1')
  setLocale('zh-CN')
  const zh = buildStoryboardSheetRows(sheetContextFrom({ storyboards: SB, characters: [], scenes: [], props: [] }))
  assert.equal(zh[1][2], '镜头2')
  assert.equal(zh[1][3], '第1幕')
})

test('rows: getField overrides win over the stored value; frame prompts come from the callbacks', () => {
  setLocale('en')
  const rows = buildStoryboardSheetRows({
    storyboards: SB,
    getField: (sb, key) => (key === 'title' && sb.id === 11 ? 'Edited' : undefined),
    getFirstFramePrompt: (id) => (id === 11 ? 'first!' : ''),
    getLastFramePrompt: () => 'last!',
  })
  assert.equal(rows[0][2], 'Edited')
  assert.equal(rows[0][19], 'first!')
  assert.equal(rows[0][20], 'last!')
})

test('scene falls back to the embedded background when the scene list has no match', () => {
  setLocale('en')
  const ctx = sheetContextFrom({ storyboards: [{ id: 1, scene_id: 99, background: { id: 99, location: 'Roof' } }], characters: [], scenes: [], props: [] })
  const rows = buildStoryboardSheetRows(ctx)
  assert.equal(rows[0][7], 'Roof')
})

test('buildCsvText: BOM-free text, quotes and newlines escaped, localized header', () => {
  setLocale('en')
  const csv = buildCsvText([[1, 'a,b', 'say "hi"', 'x\ny']])
  const [head, ...rest] = csv.split('\r\n')
  assert.ok(head.startsWith('No.,Shot no.'))
  assert.equal(rest.join('\r\n'), '1,"a,b","say ""hi""","x\ny"')
})

test('buildExcelHtml: header cells, escaped content, &#10; line breaks, localized sheet name', () => {
  setLocale('en')
  const html = buildExcelHtml([[1, '<b>&"', 'l1\nl2']])
  assert.match(html, /<th>No\.<\/th>/)
  assert.match(html, /&lt;b&gt;&amp;&quot;/)
  assert.match(html, /l1&#10;l2/)
  assert.match(html, /<x:Name>Storyboard sheet<\/x:Name>/)
  setLocale('zh-CN')
  assert.match(buildExcelHtml([]), /<x:Name>分镜表<\/x:Name>/)
})

test('sheetFilename: strips path characters and labels the episode', () => {
  setLocale('en')
  assert.equal(sheetFilename({ title: 'A/B:C', episodeNumber: 2 }), 'A_B_C-Ep 2-storyboard-sheet')
  assert.equal(sheetFilename({ title: '', episodeId: 5 }), 'project-ep5-storyboard-sheet')
  setLocale('zh-CN')
  assert.equal(sheetFilename({ title: '我的剧', episodeNumber: 1 }), '我的剧-第1集-分镜表')
})
