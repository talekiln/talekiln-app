import test from 'node:test'
import assert from 'node:assert/strict'
import { formatSrtTimestamp, wrapCueText, cuesFromTimeline, buildSrt } from '../src/utils/exportSrt.js'

test('formatSrtTimestamp: HH:MM:SS,mmm with carry', () => {
  assert.equal(formatSrtTimestamp(0), '00:00:00,000')
  assert.equal(formatSrtTimestamp(999), '00:00:00,999')
  assert.equal(formatSrtTimestamp(1000), '00:00:01,000')
  assert.equal(formatSrtTimestamp(59999), '00:00:59,999')
  assert.equal(formatSrtTimestamp(60000), '00:01:00,000')
  assert.equal(formatSrtTimestamp(3600000 + 61001), '01:01:01,001')
  assert.equal(formatSrtTimestamp(100 * 3600000), '100:00:00,000')
})

test('formatSrtTimestamp: rounds fractions without producing 1000 ms, clamps bad input', () => {
  assert.equal(formatSrtTimestamp(999.6), '00:00:01,000')
  assert.equal(formatSrtTimestamp(1234.4), '00:00:01,234')
  assert.equal(formatSrtTimestamp(-5), '00:00:00,000')
  assert.equal(formatSrtTimestamp(NaN), '00:00:00,000')
  assert.equal(formatSrtTimestamp(undefined), '00:00:00,000')
})

test('buildSrt: numbered blocks, blank-line separated, trailing newline', () => {
  const srt = buildSrt([
    { start_ms: 0, end_ms: 1500, text: 'Hello' },
    { start_ms: 2000, end_ms: 3200, text: 'World' },
  ])
  assert.equal(srt, '1\n00:00:00,000 --> 00:00:01,500\nHello\n\n2\n00:00:02,000 --> 00:00:03,200\nWorld\n')
})

test('buildSrt: accepts duration_ms in place of end_ms', () => {
  const srt = buildSrt([{ start_ms: 1000, duration_ms: 500, text: 'a' }])
  assert.match(srt, /00:00:01,000 --> 00:00:01,500/)
})

test('buildSrt: empty, blank and invalid cues are dropped and numbering stays contiguous', () => {
  const srt = buildSrt([
    { start_ms: 0, end_ms: 1000, text: '   ' },
    { start_ms: 1000, end_ms: 2000, text: 'keep' },
    { start_ms: 2000, end_ms: 2000, text: 'zero length' },
    { start_ms: 3000, end_ms: 2500, text: 'backwards' },
    { start_ms: NaN, end_ms: 4000, text: 'nan' },
    { start_ms: 5000, end_ms: 6000, text: null },
    { start_ms: 7000, end_ms: 8000, text: 'last' },
  ])
  assert.equal(srt, '1\n00:00:01,000 --> 00:00:02,000\nkeep\n\n2\n00:00:07,000 --> 00:00:08,000\nlast\n')
})

test('buildSrt: nothing exportable -> empty string', () => {
  assert.equal(buildSrt([]), '')
  assert.equal(buildSrt(null), '')
  assert.equal(buildSrt([{ start_ms: 0, end_ms: 100, text: '' }]), '')
})

test('buildSrt: unsorted cues are ordered by start time', () => {
  const srt = buildSrt([
    { start_ms: 2000, end_ms: 3000, text: 'second' },
    { start_ms: 0, end_ms: 1000, text: 'first' },
  ])
  assert.ok(srt.indexOf('first') < srt.indexOf('second'))
  assert.match(srt, /^1\n00:00:00,000/)
})

test('buildSrt: overlap trims the earlier cue so cues never overlap', () => {
  const srt = buildSrt([
    { start_ms: 0, end_ms: 3000, text: 'a' },
    { start_ms: 2000, end_ms: 4000, text: 'b' },
  ])
  assert.match(srt, /00:00:00,000 --> 00:00:02,000\na/)
  assert.match(srt, /00:00:02,000 --> 00:00:04,000\nb/)
})

test('buildSrt: cues starting together are merged instead of losing text', () => {
  const srt = buildSrt([
    { start_ms: 1000, end_ms: 2000, text: 'a' },
    { start_ms: 1000, end_ms: 3000, text: 'b' },
  ])
  assert.equal(srt, '1\n00:00:01,000 --> 00:00:03,000\na\nb\n')
})

test('buildSrt: text is trimmed and inner blank lines collapse (a blank line would end the cue)', () => {
  const srt = buildSrt([{ start_ms: 0, end_ms: 1000, text: '  one\r\n\r\n two \n\n\nthree  ' }])
  assert.equal(srt, '1\n00:00:00,000 --> 00:00:01,000\none\ntwo\nthree\n')
})

test('wrapCueText: short text untouched; CJK wraps at max chars preferring punctuation', () => {
  assert.deepEqual(wrapCueText('你好', 10), ['你好'])
  assert.deepEqual(wrapCueText('今天天气很好，我们出去玩吧。', 8), ['今天天气很好，', '我们出去玩吧。'])
  assert.deepEqual(wrapCueText('一二三四五六七八九十', 4), ['一二三四', '五六七八', '九十'])
})

test('wrapCueText: Latin text wraps on spaces; a word longer than a line is hard-cut', () => {
  assert.deepEqual(wrapCueText('the quick brown fox jumps', 10), ['the quick', 'brown fox', 'jumps'])
  assert.deepEqual(wrapCueText('supercalifragilistic word', 8), ['supercal', 'ifragili', 'stic', 'word'])
})

test('wrapCueText: max <= 0 disables wrapping', () => {
  assert.deepEqual(wrapCueText('一二三四五六七八九十', 0), ['一二三四五六七八九十'])
})

test('buildSrt: maxLineChars wraps lines inside a cue; more than maxLines splits the cue by time', () => {
  const text = '一二三四五六七八九十'
  const wrapped = buildSrt([{ start_ms: 0, end_ms: 4000, text }], { maxLineChars: 5, maxLines: 2 })
  assert.equal(wrapped, '1\n00:00:00,000 --> 00:00:04,000\n一二三四五\n六七八九十\n')
  const split = buildSrt([{ start_ms: 0, end_ms: 4000, text }], { maxLineChars: 3, maxLines: 2 })
  // 10 chars / 3 per line = 4 lines -> 2 cues of 2 lines; time split in proportion to chars (6 : 4)
  const blocks = split.trim().split('\n\n')
  assert.equal(blocks.length, 2)
  assert.match(blocks[0], /^1\n00:00:00,000 --> 00:00:02,400\n一二三\n四五六$/)
  assert.match(blocks[1], /^2\n00:00:02,400 --> 00:00:04,000\n七八九\n十$/)
})

test('cuesFromTimeline: reads the subtitle track of the timeline view', () => {
  const view = {
    duration_ms: 5000,
    tracks: [
      { kind: 'video', clips: [{ id: 'v', start_ms: 0, duration_ms: 5000 }] },
      { kind: 'subtitle', clips: [
        { id: 'sub_1', start_ms: 100, duration_ms: 900, text: 'x' },
        { id: 'sub_2', start_ms: 2000, duration_ms: 1000, text: 'y' },
      ] },
    ],
  }
  assert.deepEqual(cuesFromTimeline(view), [
    { start_ms: 100, end_ms: 1000, text: 'x' },
    { start_ms: 2000, end_ms: 3000, text: 'y' },
  ])
  assert.deepEqual(cuesFromTimeline({ tracks: [] }), [])
  assert.deepEqual(cuesFromTimeline(null), [])
})
