import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import {
  DEFAULT_CHAPTER_PATTERN,
  affectedEpisodeIds,
  buildProjectSettingsRequests,
  buildStoryRequest,
  canEditFullText,
  episodeOrderAfterMove,
  episodesPayload,
  nextEpisodeNumber,
  parseScriptLines,
  reorderRows,
  scriptReplaceOps,
  scriptTextOfView,
  shotCountOfView,
  splitNovelIntoEpisodes,
  storyResultToEpisodes,
  withAppended,
  withContent,
  withRenamed,
  withoutEpisode,
} from '../src/utils/scriptTools.js'

const K = createRequire(import.meta.url)('../../../packages/kernel/src/index.js')

// ---------------------------------------------------------------- splitNovelIntoEpisodes

test('splitNovelIntoEpisodes: empty or blank text reports "empty" and yields nothing', () => {
  for (const t of ['', '   \n\t ', null, undefined]) {
    const r = splitNovelIntoEpisodes(t)
    assert.equal(r.error, 'empty')
    assert.deepEqual(r.episodes, [])
    assert.deepEqual(r.chapters, [])
  }
})

test('splitNovelIntoEpisodes: one chapter per episode by default, numbered from startNumber', () => {
  const r = splitNovelIntoEpisodes('第1章 开端\n甲说话\n第2章 发展\n乙回答', { startNumber: 4 })
  assert.equal(r.error, null)
  assert.equal(r.chapters.length, 2)
  assert.deepEqual(r.episodes.map((e) => [e.episode_number, e.title]), [[4, '第1章 开端'], [5, '第2章 发展']])
  assert.equal(r.episodes[0].script_content, '第1章 开端\n甲说话')
  assert.deepEqual(r.episodes[1].chapter_titles, ['第2章 发展'])
})

test('splitNovelIntoEpisodes: chaptersPerEpisode groups chapters and titles the range', () => {
  const text = [1, 2, 3, 4, 5].map((n) => `第${n}章 T${n}\n内容${n}`).join('\n')
  const r = splitNovelIntoEpisodes(text, { chaptersPerEpisode: 2 })
  assert.equal(r.episodes.length, 3)
  assert.equal(r.episodes[0].title, '第1章 T1 - 第2章 T2')
  assert.equal(r.episodes[2].title, '第5章 T5')
  assert.equal(r.episodes[0].script_content, '第1章 T1\n内容1\n\n第2章 T2\n内容2')
})

test('splitNovelIntoEpisodes: invalid chaptersPerEpisode falls back to 1', () => {
  const text = '第1章 A\nx\n第2章 B\ny'
  for (const v of [0, -3, NaN, 'abc', undefined]) assert.equal(splitNovelIntoEpisodes(text, { chaptersPerEpisode: v }).episodes.length, 2)
})

test('splitNovelIntoEpisodes: duplicate chapter names stay separate episodes with their own text', () => {
  const r = splitNovelIntoEpisodes('第1章 重复\n甲\n第1章 重复\n乙\n第1章 重复\n丙')
  assert.equal(r.episodes.length, 3)
  assert.deepEqual(r.episodes.map((e) => e.episode_number), [1, 2, 3])
  assert.deepEqual(r.episodes.map((e) => e.script_content.split('\n')[1]), ['甲', '乙', '丙'])
  const g = splitNovelIntoEpisodes('第1章 重复\n甲\n第1章 重复\n乙', { chaptersPerEpisode: 2 })
  assert.equal(g.episodes[0].title, '第1章 重复')
})

test('splitNovelIntoEpisodes: default pattern handles mixed Chinese and English headings', () => {
  const r = splitNovelIntoEpisodes('Chapter 1: Rain\nIt rained 一整夜.\n第二章 雨停\nThe end.\nCHAPTER 3\nepilogue')
  assert.equal(r.chapters.length, 3)
  assert.equal(r.chapters[0].title, 'Chapter 1: Rain')
  assert.equal(r.chapters[1].title, '第二章 雨停')
  assert.equal(r.chapters[2].title, 'CHAPTER 3')
  assert.match(r.chapters[0].content, /一整夜/)
})

test('splitNovelIntoEpisodes: text before the first heading is kept in the first episode, not dropped', () => {
  const r = splitNovelIntoEpisodes('作者的话\n\n第1章 A\n正文')
  assert.equal(r.episodes.length, 1)
  assert.match(r.episodes[0].script_content, /^作者的话/)
  assert.match(r.episodes[0].script_content, /第1章 A\n正文$/)
})

test('splitNovelIntoEpisodes: CRLF input is normalised', () => {
  const r = splitNovelIntoEpisodes('第1章 A\r\n甲\r\n第2章 B\r\n乙')
  assert.equal(r.episodes.length, 2)
  assert.ok(!r.episodes[0].script_content.includes('\r'))
})

test('splitNovelIntoEpisodes: custom pattern with and without a capture group', () => {
  const withGroup = splitNovelIntoEpisodes('EP-1 开始\na\nEP-2 继续\nb', { pattern: '^(EP-\\d+[^\\n]*)' })
  assert.deepEqual(withGroup.chapters.map((c) => c.title), ['EP-1 开始', 'EP-2 继续'])
  const noGroup = splitNovelIntoEpisodes('## one\na\n## two\nb', { pattern: '^## \\w+' })
  assert.deepEqual(noGroup.chapters.map((c) => c.title), ['## one', '## two'])
})

test('splitNovelIntoEpisodes: reports bad_pattern, no_pattern and no_match', () => {
  assert.equal(splitNovelIntoEpisodes('第1章 A\nx', { pattern: '(' }).error, 'bad_pattern')
  assert.equal(splitNovelIntoEpisodes('第1章 A\nx', { pattern: '   ' }).error, 'no_pattern')
  assert.equal(splitNovelIntoEpisodes('没有任何章节标题的文字', {}).error, 'no_match')
  assert.equal(splitNovelIntoEpisodes('abc\ndef', { pattern: '^' }).error, 'no_match')
})

test('splitNovelIntoEpisodes: very long text with hundreds of chapters is split quickly and completely', () => {
  const body = '这是一段很长的正文。'.repeat(200)
  const text = Array.from({ length: 400 }, (_, i) => `第${i + 1}章 标题${i + 1}\n${body}`).join('\n')
  assert.ok(text.length > 800000)
  const t0 = Date.now()
  const r = splitNovelIntoEpisodes(text, { chaptersPerEpisode: 3 })
  assert.ok(Date.now() - t0 < 3000)
  assert.equal(r.chapters.length, 400)
  assert.equal(r.episodes.length, Math.ceil(400 / 3))
  assert.equal(r.episodes[r.episodes.length - 1].episode_number, r.episodes.length)
})

test('splitNovelIntoEpisodes: by "marker" splits on 第N集/章/节 lines', () => {
  const r = splitNovelIntoEpisodes('第一集\nA\n第二集\nB', { by: 'marker' })
  assert.equal(r.error, null)
  assert.deepEqual(r.episodes.map((e) => e.title), ['第一集', '第二集'])
  assert.equal(r.episodes[1].script_content, 'B')
  const one = splitNovelIntoEpisodes('只有一段', { by: 'marker' })
  assert.equal(one.episodes.length, 1)
  assert.equal(one.episodes[0].script_content, '只有一段')
})

test('splitNovelIntoEpisodes: by "size" chunks long text on paragraph boundaries without losing characters', () => {
  const para = '甲乙丙丁戊己庚辛壬癸。'.repeat(30)
  const text = Array.from({ length: 40 }, () => para).join('\n\n')
  const r = splitNovelIntoEpisodes(text, { by: 'size', size: 1000 })
  assert.equal(r.error, null)
  assert.ok(r.episodes.length > 10)
  for (const e of r.episodes) assert.ok(e.script_content.length <= 1000, `chunk too long: ${e.script_content.length}`)
  const strip = (s) => s.replace(/\s+/g, '')
  assert.equal(strip(r.episodes.map((e) => e.script_content).join('')), strip(text))
  assert.deepEqual(r.episodes.map((e) => e.episode_number), r.episodes.map((_, i) => i + 1))
})

test('splitNovelIntoEpisodes: by "size" hard-splits one paragraph longer than the limit', () => {
  const text = '没有换行也没有句号'.repeat(500)
  const r = splitNovelIntoEpisodes(text, { by: 'size', size: 700 })
  assert.ok(r.episodes.length >= 6)
  for (const e of r.episodes) assert.ok(e.script_content.length <= 700)
  assert.equal(r.episodes.map((e) => e.script_content).join(''), text)
  assert.equal(splitNovelIntoEpisodes('abc', { by: 'size', size: 0 }).error, 'bad_size')
})

test('DEFAULT_CHAPTER_PATTERN is a valid regular expression source', () => {
  assert.doesNotThrow(() => new RegExp(DEFAULT_CHAPTER_PATTERN, 'gm'))
})

// ---------------------------------------------------------------- buildStoryRequest

test('buildStoryRequest: blank premise is rejected', () => {
  assert.deepEqual(buildStoryRequest({ premise: '   ' }), { ok: false, error: 'empty_premise' })
  assert.deepEqual(buildStoryRequest({}), { ok: false, error: 'empty_premise' })
})

test('buildStoryRequest: maps the form to the /generation/story body', () => {
  const r = buildStoryRequest({
    premise: '  少女与狐狸  ', storyStyle: 'fantasy', storyType: 'adventure', episodeCount: 3, title: ' 狐狸 ',
    generationStyle: 'realistic', aspectRatio: '9:16',
  })
  assert.equal(r.ok, true)
  const b = r.body
  assert.equal(b.premise, '少女与狐狸')
  assert.equal(b.summary, '少女与狐狸')
  assert.equal(b.style, 'fantasy')
  assert.equal(b.type, 'adventure')
  assert.equal(b.genre, 'adventure')
  assert.equal(b.episode_count, 3)
  assert.equal(b.title, '狐狸')
  assert.equal(b.drama_style, 'realistic')
  assert.equal(b.metadata.aspect_ratio, '9:16')
  assert.equal(b.metadata.story_style, 'fantasy')
  assert.ok(b.metadata.style_prompt_zh.length > 0)
  assert.ok(!('drama_id' in b))
})

test('buildStoryRequest: omits blank optional fields and defaults aspect ratio', () => {
  const b = buildStoryRequest({ premise: 'x' }).body
  assert.equal(b.episode_count, 1)
  for (const k of ['style', 'type', 'genre', 'title', 'drama_style', 'drama_id']) assert.ok(!(k in b), k)
  assert.equal(b.metadata.aspect_ratio, '16:9')
  assert.ok(!('story_style' in b.metadata))
})

test('buildStoryRequest: clamps episode count to 1..20 and floors fractions', () => {
  const n = (v) => buildStoryRequest({ premise: 'x', episodeCount: v }).body.episode_count
  assert.equal(n(0), 1)
  assert.equal(n(-5), 1)
  assert.equal(n(NaN), 1)
  assert.equal(n('abc'), 1)
  assert.equal(n(2.9), 2)
  assert.equal(n('4'), 4)
  assert.equal(n(500), 20)
})

test('buildStoryRequest: custom style needs a prompt, and passes it through when present', () => {
  assert.deepEqual(buildStoryRequest({ premise: 'x', generationStyle: 'custom', customStylePrompt: '  ' }), { ok: false, error: 'custom_style_prompt' })
  const b = buildStoryRequest({ premise: 'x', generationStyle: 'custom', customStylePrompt: '水彩' }).body
  assert.equal(b.drama_style, 'custom')
  assert.equal(b.metadata.style_prompt_zh, '水彩')
})

test('buildStoryRequest: English scripts are requested in the premise text, summary stays clean', () => {
  const b = buildStoryRequest({ premise: 'fox', language: 'en' }).body
  assert.equal(b.premise, 'fox\n\nWrite the script in English.')
  assert.equal(b.summary, 'fox')
  assert.equal(buildStoryRequest({ premise: 'fox', language: 'zh' }).body.premise, 'fox')
})

test('buildStoryRequest: a dramaId turns on the async variant', () => {
  assert.equal(buildStoryRequest({ premise: 'x', dramaId: 12 }).body.drama_id, 12)
})

test('storyResultToEpisodes: orders by episode number and drops empty bodies', () => {
  const rows = storyResultToEpisodes({ episodes: [
    { episode: 2, title: ' 二 ', content: ' 正文二 ' },
    { episode: 1, title: '', content: '正文一' },
    { episode: 3, title: '空', content: '   ' },
  ] })
  assert.deepEqual(rows, [
    { title: '', script_content: '正文一' },
    { title: '二', script_content: '正文二' },
  ])
  assert.deepEqual(storyResultToEpisodes(null), [])
  assert.deepEqual(storyResultToEpisodes({}), [])
})

// ---------------------------------------------------------------- full-text gate

test('canEditFullText: only before any shot exists', () => {
  assert.equal(canEditFullText({ hasShots: false }), true)
  assert.equal(canEditFullText({ hasShots: true }), false)
  assert.equal(canEditFullText({ hasShots: 3 }), false)
  assert.equal(canEditFullText({ hasShots: 0 }), true)
  assert.equal(canEditFullText({}), true)
  assert.equal(canEditFullText(), true)
})

test('shotCountOfView: counts shots in every group, tolerating missing data', () => {
  assert.equal(shotCountOfView(null), 0)
  assert.equal(shotCountOfView({ groups: [] }), 0)
  assert.equal(shotCountOfView({ groups: [{ shots: [1, 2] }, { shots: [3] }, {}] }), 3)
})

// ---------------------------------------------------------------- episode lists

const EPS = [
  { id: 11, episode_number: 1, title: 'A', script_content: 'a', description: 'da', duration: 3 },
  { id: 12, episode_number: 2, title: 'B', script_content: null, description: null, duration: 0 },
  { id: 13, episode_number: 5, title: '', script_content: 'c' },
]

test('episodesPayload keeps episode numbers and normalises null fields', () => {
  assert.deepEqual(episodesPayload(EPS), [
    { episode_number: 1, title: 'A', script_content: 'a', description: 'da', duration: 3 },
    { episode_number: 2, title: 'B', script_content: '', description: null, duration: 0 },
    { episode_number: 5, title: '', script_content: 'c', description: null, duration: 0 },
  ])
})

test('episodesPayload sorts by number and falls back to position when a number is missing', () => {
  const rows = episodesPayload([{ id: 1, title: 'x' }, { id: 2, episode_number: 7, title: 'y' }])
  assert.deepEqual(rows.map((r) => r.episode_number), [1, 7])
})

test('nextEpisodeNumber is max + 1 and never reuses a gap', () => {
  assert.equal(nextEpisodeNumber([]), 1)
  assert.equal(nextEpisodeNumber(EPS), 6)
  assert.equal(nextEpisodeNumber([{ episode_number: '3' }, { episode_number: 'x' }]), 4)
})

test('withAppended renumbers appended episodes after the current maximum and leaves existing ones alone', () => {
  const rows = withAppended(EPS, [{ episode_number: 1, title: 'N1', script_content: 'n1' }, { title: '', script_content: 'n2' }])
  assert.deepEqual(rows.map((r) => r.episode_number), [1, 2, 5, 6, 7])
  assert.equal(rows[3].title, 'N1')
  assert.equal(rows[4].script_content, 'n2')
  assert.equal(rows[0].script_content, 'a')
})

test('withRenamed changes one title only', () => {
  const rows = withRenamed(EPS, 12, '新名字')
  assert.deepEqual(rows.map((r) => r.title), ['A', '新名字', ''])
  assert.deepEqual(rows.map((r) => r.episode_number), [1, 2, 5])
  assert.equal(withRenamed(EPS, 999, 'x'), null)
})

test('withoutEpisode drops one row without renumbering the rest', () => {
  const rows = withoutEpisode(EPS, 12)
  assert.deepEqual(rows.map((r) => r.episode_number), [1, 5])
  assert.equal(withoutEpisode(EPS, 999), null)
})

test('withContent replaces script text (and optionally the title) of one episode', () => {
  const rows = withContent(EPS, 13, { script_content: '新正文' })
  assert.equal(rows[2].script_content, '新正文')
  assert.equal(rows[2].title, '')
  const t = withContent(EPS, 13, { script_content: 'z', title: 'T' })
  assert.equal(t[2].title, 'T')
  assert.equal(withContent(EPS, 999, { script_content: 'x' }), null)
})

test('episodeOrderAfterMove returns the new id order, indexes counted in episode_number order', () => {
  const eps = [{ id: 'd', episode_number: 4 }, { id: 'a', episode_number: 1 }, { id: 'c', episode_number: 3 }, { id: 'b', episode_number: 2 }]
  assert.deepEqual(episodeOrderAfterMove(eps, 0, 2), ['b', 'c', 'a', 'd'])
  assert.deepEqual(episodeOrderAfterMove(eps, 3, 0), ['d', 'a', 'b', 'c'])
  assert.deepEqual(episodeOrderAfterMove(eps, 1, 2), ['a', 'c', 'b', 'd'])
})

test('episodeOrderAfterMove returns null for no-ops and bad indexes', () => {
  const eps = [{ id: 1, episode_number: 1 }, { id: 2, episode_number: 2 }]
  assert.equal(episodeOrderAfterMove(eps, 1, 1), null)
  assert.equal(episodeOrderAfterMove(eps, -1, 0), null)
  assert.equal(episodeOrderAfterMove(eps, 0, 2), null)
  assert.equal(episodeOrderAfterMove(eps, 0.5, 1), null)
  assert.equal(episodeOrderAfterMove([], 0, 0), null)
  assert.equal(episodeOrderAfterMove(null, 0, 1), null)
})

test('affectedEpisodeIds lists the episodes between the two positions, inclusive', () => {
  const eps = [1, 2, 3, 4].map((n) => ({ id: n * 10, episode_number: n }))
  assert.deepEqual(affectedEpisodeIds(eps, 0, 2), [10, 20, 30])
  assert.deepEqual(affectedEpisodeIds(eps, 3, 1), [20, 30, 40])
  assert.deepEqual(affectedEpisodeIds(eps, 2, 2), [30])
})

test('reorderRows keeps the number slots and moves the content, so ids stay on their numbers', () => {
  const eps = [
    { id: 1, episode_number: 1, title: 'one', script_content: '1' },
    { id: 2, episode_number: 2, title: 'two', script_content: '2' },
    { id: 3, episode_number: 4, title: 'four', script_content: '4' },
  ]
  const rows = reorderRows(eps, [2, 3, 1])
  assert.deepEqual(rows.map((r) => r.episode_number), [1, 2, 4])
  assert.deepEqual(rows.map((r) => r.title), ['two', 'four', 'one'])
  assert.deepEqual(rows.map((r) => r.script_content), ['2', '4', '1'])
  assert.equal(reorderRows(eps, [1, 2]), null)
  assert.equal(reorderRows(eps, [1, 2, 99]), null)
})

// ---------------------------------------------------------------- project settings

test('buildProjectSettingsRequests: splits into the PUT /dramas/:id and outline bodies', () => {
  const r = buildProjectSettingsRequests({
    title: ' 我的剧 ', description: ' 梗概 ', genre: 'drama', storyStyle: 'modern', style: 'realistic',
    aspectRatio: '9:16', clipDuration: 8, language: 'en',
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.update, { title: '我的剧', description: '梗概' })
  assert.equal(r.outline.genre, 'drama')
  assert.equal(r.outline.style, 'realistic')
  assert.equal(r.outline.metadata.aspect_ratio, '9:16')
  assert.equal(r.outline.metadata.video_clip_duration, 8)
  assert.equal(r.outline.metadata.script_language, 'en')
  assert.equal(r.outline.metadata.story_style, 'modern')
  assert.ok(r.outline.metadata.style_prompt_zh.length > 0)
})

test('buildProjectSettingsRequests: validates title, clip duration and custom style', () => {
  assert.deepEqual(buildProjectSettingsRequests({ title: '  ' }), { ok: false, error: 'empty_title' })
  assert.deepEqual(buildProjectSettingsRequests({ title: 'x', style: 'custom', customStylePrompt: '' }), { ok: false, error: 'custom_style_prompt' })
  const r = buildProjectSettingsRequests({ title: 'x', clipDuration: 0, aspectRatio: '', language: 'fr' })
  assert.equal(r.outline.metadata.video_clip_duration, 5)
  assert.equal(r.outline.metadata.aspect_ratio, '16:9')
  assert.equal(r.outline.metadata.script_language, 'zh')
})

// ---------------------------------------------------------------- script text <-> kernel lines

const SAMPLE = [
  '# 雨夜',
  '△ 林夏推开门',
  '林夏：你来晚了。',
  '（雷声）',
  '旁白一句',
  '',
  '# 清晨',
  '阿杰: Hello 你好',
  '另一句旁白',
].join('\n')

const shape = (scenes) => scenes.map((s) => ({ title: s.title, lines: s.lines.map((l) => [l.kind, l.speaker, l.text]) }))

test('parseScriptLines matches the kernel parseScript grammar', () => {
  const corpus = [
    SAMPLE, '', '   \n  ', '只有一行', '△动作\n▲另一个动作', '（整行括号）', '(ascii paren)', '甲：乙\r\n丙：丁',
    '# A\n# B\n句子', '：没有说话人', '很长的名字很长的名字很长的名字很长的名字：台词',
  ]
  for (const text of corpus) assert.deepEqual(shape(parseScriptLines(text)), shape(K.parseScript(text)), JSON.stringify(text))
})

test('scriptTextOfView -> parseScriptLines round-trips a kernel graph', () => {
  const g = K.buildGraphFromScript('p', SAMPLE)
  const text = scriptTextOfView(K.scriptView(g))
  assert.deepEqual(shape(parseScriptLines(text)), shape(K.parseScript(SAMPLE)))
})

test('scriptTextOfView does not double the speaker on lines imported with the speaker inside the text', () => {
  const view = { groups: [{ id: 'g', title: '', lines: [
    { id: 'l1', kind: 'dialogue', speaker: '林夏', text: '林夏：你好' },
    { id: 'l2', kind: 'dialogue', speaker: '阿杰', text: '早' },
    { id: 'l3', kind: 'dialogue', speaker: '', text: '无名' },
  ] }] }
  assert.equal(scriptTextOfView(view), '林夏：你好\n阿杰：早\n无名')
})

test('scriptTextOfView emits a heading for titled groups that have no heading line', () => {
  const view = { groups: [
    { id: 'g1', title: '第一段', lines: [{ id: 'l1', kind: 'narration', speaker: '', text: '甲' }] },
    { id: 'g2', title: '', lines: [{ id: 'l2', kind: 'action', speaker: '', text: '跑' }] },
  ] }
  assert.equal(scriptTextOfView(view), '# 第一段\n甲\n△跑')
  assert.equal(scriptTextOfView(null), '')
  assert.equal(scriptTextOfView({ groups: [] }), '')
})

test('scriptReplaceOps replaces every line of a shot-less graph and leaves a valid graph', () => {
  const g = K.buildGraphFromScript('p', SAMPLE)
  const next = '# 新场景\n甲：新台词\n△新动作\n旁白'
  const r = scriptReplaceOps(g, next)
  assert.equal(r.ok, true)
  const out = K.applyTx(g, { tx_id: 't1', label: 'replace script', ops: r.ops }).graph
  assert.deepEqual(shape(K.scriptView(out).groups), shape(K.parseScript(next)))
  assert.equal(Object.values(out.nodes).filter((n) => n.type === 'script_line').length, 4)
})

test('scriptReplaceOps with empty text clears the script', () => {
  const g = K.buildGraphFromScript('p', SAMPLE)
  const r = scriptReplaceOps(g, '   ')
  const out = K.applyTx(g, { tx_id: 't2', label: 'clear', ops: r.ops }).graph
  assert.deepEqual(K.scriptView(out).groups.flatMap((x) => x.lines), [])
})

test('scriptReplaceOps works repeatedly and never reuses existing ids', () => {
  const g0 = K.buildGraphFromScript('p', '')
  const r = scriptReplaceOps(g0, '一\n二')
  const g1 = K.applyTx(g0, { tx_id: 't3', label: 'seed', ops: r.ops }).graph
  const r2 = scriptReplaceOps(g1, '三\n四\n五')
  const g2 = K.applyTx(g1, { tx_id: 't4', label: 'again', ops: r2.ops }).graph
  assert.deepEqual(K.scriptView(g2).groups.flatMap((x) => x.lines.map((l) => l.text)), ['三', '四', '五'])
})

test('scriptReplaceOps refuses once shots exist', () => {
  const g = K.buildGraph({ project_id: 'p', scenes: [{ title: 's', lines: [{ kind: 'narration', text: 'x' }], shots: [{ lines: [0] }] }] })
  assert.deepEqual(scriptReplaceOps(g, 'new'), { ok: false, error: 'has_shots' })
})

// ---------------------------------------------------------------- 检查器：出场资产

const { extractMentions, mentionAssets, appearingAssets } = await import('../src/utils/scriptTools.js')

test('extractMentions: finds @ and # tokens, in order, deduplicated', () => {
  assert.deepEqual(extractMentions('@林夏走进#旧书店，@林夏看了看#旧书店'), ['@林夏走进', '#旧书店', '@林夏看了看'])
  assert.deepEqual(extractMentions('no mentions', '', null), [])
  assert.deepEqual(extractMentions('mail a@b.com', 'x #tag, y'), ['@b', '#tag'])
})

test('mentionAssets: shortens a run-on token until an asset matches', () => {
  const lin = { id: 1, name: '林夏' }
  const shop = { id: 2, name: '旧书店' }
  const resolve = (t) => (t === '@林夏' ? lin : t === '#旧书店' ? shop : null)
  assert.deepEqual(mentionAssets(['@林夏走进#旧书店'], resolve), [lin, shop])
  assert.deepEqual(mentionAssets(['@路人甲'], resolve), [])
  assert.deepEqual(mentionAssets(['@林夏 @林夏'], resolve), [lin])
})

test('appearingAssets: shot bindings plus mentions, no duplicates, empty without assets', () => {
  const lin = { id: 1, name: '林夏' }
  const shop = { id: 2, name: '旧书店' }
  const book = { id: 3, name: '旧书' }
  const byKind = { characters: [lin], scenes: [shop], props: [book] }
  const resolve = (t) => ({ '@林夏': lin, '#旧书店': shop, '#旧书': book })[t] || null
  const refsFor = (p) => ({ characters: (p.characters || []).filter((x) => x === 1).length ? [lin] : [], scenes: [], props: [] })
  const r = appearingAssets({ shots: [{ params: { characters: [1], description: '#旧书 特写' } }], texts: ['@林夏走进#旧书店'], byKind, refsFor, resolve })
  assert.deepEqual(r, { characters: [lin], scenes: [shop], props: [book] })
  assert.deepEqual(appearingAssets({}), { characters: [], scenes: [], props: [] })
  const byName = appearingAssets({ shots: [{ params: { characters: ['林夏'] } }], byKind, resolve })
  assert.deepEqual(byName.characters, [lin])
})
