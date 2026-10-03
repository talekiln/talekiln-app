import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cardNextStop,
  projectCardInfo,
  filterProjects,
  splitNovelChapters,
  buildEpisodesFromChapters,
  backupFileName,
  rememberDeleted,
  forgetDeleted,
  parseDeletedLog,
  isBackupFileName,
} from '../src/utils/homeModel.js'

const project = {
  id: 12,
  title: 'Rain',
  episodes: [
    { id: 31, episode_number: 2, title: 'B', storyboards: [{ id: 1 }, { id: 2 }] },
    { id: 30, episode_number: 1, title: 'A', storyboards: [{ id: 3, local_path: 'images/a.png' }] },
  ],
}

test('cardNextStop: remembered episode and view win', () => {
  const s = cardNextStop(project, { episodeId: 31, view: 'timeline' })
  assert.equal(s.kind, 'last')
  assert.equal(s.episodeNumber, 2)
  assert.equal(s.view, 'timeline')
  assert.deepEqual(s.location, { name: 'episode-timeline', params: { dramaId: 12, episodeId: 31 } })
})

test('cardNextStop: no record falls back to the first episode script (by episode number)', () => {
  const s = cardNextStop(project, null)
  assert.equal(s.kind, 'first')
  assert.deepEqual(s.location, { name: 'episode-script', params: { dramaId: 12, episodeId: 30 } })
  assert.equal(s.episodeNumber, 1)
  assert.equal(s.view, 'script')
})

test('cardNextStop: deleted episode falls back to the first episode script', () => {
  const s = cardNextStop(project, { episodeId: 999, view: 'canvas' })
  assert.equal(s.kind, 'first')
  assert.equal(s.location.name, 'episode-script')
  assert.equal(s.location.params.episodeId, 30)
})

test('cardNextStop: unknown view or garbage record falls back safely', () => {
  assert.equal(cardNextStop(project, { episodeId: 31, view: 'nope' }).kind, 'first')
  assert.equal(cardNextStop(project, 'x').kind, 'first')
  assert.equal(cardNextStop(project, {}).kind, 'first')
  assert.equal(cardNextStop(project, { episodeId: '31', view: 'canvas' }).location.name, 'episode-canvas')
})

test('cardNextStop: project without episodes goes to project-home (script empty state)', () => {
  for (const p of [{ id: 5, episodes: [] }, { id: 5 }, { id: 5, episodes: null }]) {
    const s = cardNextStop(p, { episodeId: 1, view: 'script' })
    assert.equal(s.kind, 'empty')
    assert.deepEqual(s.location, { name: 'project-home', params: { dramaId: 5 } })
    assert.equal(s.episodeId, null)
  }
})

test('cardNextStop: never produces legacy paths', () => {
  const s = cardNextStop(project, { episodeId: 31, view: 'storyboard' })
  assert.equal(JSON.stringify(s).includes('/film/'), false)
  assert.equal(JSON.stringify(s).includes('/drama/'), false)
})

test('cardNextStop: missing project returns the list route', () => {
  assert.deepEqual(cardNextStop(null, null).location, { name: 'list' })
})

test('projectCardInfo summarises episodes, shots, ratio and cover', () => {
  const info = projectCardInfo({ ...project, metadata: { aspect_ratio: '9:16' }, updated_at: '2026-10-02T13:40:00Z' })
  assert.equal(info.episodeCount, 2)
  assert.equal(info.shotCount, 3)
  assert.equal(info.aspect, '9:16')
  assert.equal(info.cover, '/static/images/a.png')
  assert.equal(info.updatedAt, '2026-10-02T13:40:00Z')
  const bare = projectCardInfo({ id: 1 })
  assert.equal(bare.episodeCount, 0)
  assert.equal(bare.shotCount, 0)
  assert.equal(bare.cover, '')
  assert.equal(bare.aspect, '')
})

test('projectCardInfo prefers drama.thumbnail and accepts remote cover urls', () => {
  assert.equal(projectCardInfo({ id: 1, thumbnail: 'thumbs/t.png' }).cover, '/static/thumbs/t.png')
  assert.equal(projectCardInfo({ id: 1, thumbnail: 'https://x/y.png' }).cover, 'https://x/y.png')
  const p = { id: 1, episodes: [{ id: 1, storyboards: [{ image_url: 'https://x/a.png' }] }] }
  assert.equal(projectCardInfo(p).cover, 'https://x/a.png')
})

test('filterProjects matches title and description, case-insensitive', () => {
  const list = [{ id: 1, title: 'Rain Letter', description: '' }, { id: 2, title: 'Shop', description: 'about the SEA' }]
  assert.deepEqual(filterProjects(list, 'rain').map((p) => p.id), [1])
  assert.deepEqual(filterProjects(list, ' sea ').map((p) => p.id), [2])
  assert.equal(filterProjects(list, '').length, 2)
  assert.equal(filterProjects(null, 'x').length, 0)
})

test('splitNovelChapters splits on the chapter pattern', () => {
  const text = 'intro\nChapter 1 Rain\nline a\nline b\nChapter 2 Sun\nline c'
  const ch = splitNovelChapters(text, '^\\s*(Chapter \\d+[^\\n]*)')
  assert.deepEqual(ch.map((c) => c.title), ['Chapter 1 Rain', 'Chapter 2 Sun'])
  assert.equal(ch[0].content, 'line a\nline b')
  assert.equal(ch[1].content, 'line c')
})

test('splitNovelChapters: CRLF input, empty pattern and failures use error codes', () => {
  const ch = splitNovelChapters('Chapter 1\r\nx\r\nChapter 2\r\ny', '^(Chapter \\d+)')
  assert.equal(ch.length, 2)
  assert.equal(ch[0].content, 'x')
  const whole = splitNovelChapters('just a script\nwith lines', '')
  assert.equal(whole.length, 1)
  assert.equal(whole[0].content, 'just a script\nwith lines')
  assert.throws(() => splitNovelChapters('abc', '('), (e) => e.code === 'BAD_PATTERN')
  assert.throws(() => splitNovelChapters('abc', '^(Chapter)'), (e) => e.code === 'NO_MATCH')
  assert.throws(() => splitNovelChapters('   ', '^(x)'), (e) => e.code === 'EMPTY_TEXT')
})

test('buildEpisodesFromChapters groups chapters and numbers from the start number', () => {
  const chapters = [
    { title: 'C1', content: 'a' },
    { title: 'C2', content: 'b' },
    { title: 'C3', content: 'c' },
  ]
  const eps = buildEpisodesFromChapters(chapters, 2, 4)
  assert.equal(eps.length, 2)
  assert.deepEqual(eps.map((e) => e.episode_number), [4, 5])
  assert.equal(eps[0].title, 'C1 - C2')
  assert.equal(eps[1].title, 'C3')
  assert.equal(eps[0].script_content, 'C1\na\n\nC2\nb')
  assert.deepEqual(eps[0].chapter_titles, ['C1', 'C2'])
  assert.equal(buildEpisodesFromChapters(chapters, 0).length, 3)
  assert.deepEqual(buildEpisodesFromChapters([], 1), [])
})

test('backupFileName is filesystem safe and ends with .talekiln.zip', () => {
  const now = new Date('2026-10-03T08:00:00Z')
  assert.match(backupFileName('A/B:C*?', now), /^A_B_C__-\d{8}\.talekiln\.zip$/)
  assert.match(backupFileName('', now), /^project-\d{8}\.talekiln\.zip$/)
  assert.equal(isBackupFileName('x.talekiln.zip'), true)
  assert.equal(isBackupFileName('x.zip'), false)
})

test('deleted-project log keeps the 5 newest, de-duplicates and survives garbage', () => {
  let log = []
  for (let i = 1; i <= 7; i++) log = rememberDeleted(log, { dramaId: i, title: `P${i}`, snapshotId: `s${i}`, at: i })
  assert.equal(log.length, 5)
  assert.deepEqual(log.map((r) => r.dramaId), [7, 6, 5, 4, 3])
  log = rememberDeleted(log, { dramaId: 5, title: 'P5b', snapshotId: 's5b', at: 9 })
  assert.equal(log.length, 5)
  assert.equal(log[0].title, 'P5b')
  log = forgetDeleted(log, 7)
  assert.equal(log.some((r) => r.dramaId === 7), false)
  assert.deepEqual(parseDeletedLog('not json'), [])
  assert.deepEqual(parseDeletedLog('{"a":1}'), [])
  assert.deepEqual(parseDeletedLog(JSON.stringify([{ dramaId: 1, title: 'x', snapshotId: 's', at: 1 }, { nope: true }])).length, 1)
  assert.deepEqual(rememberDeleted(log, { title: 'no id' }), log)
})
