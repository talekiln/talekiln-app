import test from 'node:test'
import assert from 'node:assert/strict'

import {
  msToPx, pxToMs, zoomBy, ZOOM_MAX, formatTime, rulerStepMs, snapValue, snapMove, snapPoints,
  overlapsInTrack, resolveMove, resolveResize, splitClipAt, sourceTimeAt, resolveAssetUrl, timelineDuration,
  clipAt, findClip
} from '../src/utils/timelineMath.js'

const clip = (id, start_ms, duration_ms, extra = {}) => ({ id, start_ms, duration_ms, src_in_ms: null, src_out_ms: null, ...extra })
const vtrack = () => ({
  kind: 'video',
  clips: [clip('a', 0, 1000, { src_in_ms: 0, src_out_ms: 1000 }), clip('b', 1000, 2000, { src_in_ms: 0, src_out_ms: 2000 }), clip('c', 5000, 1000)]
})

test('ms/px conversion round-trips', () => {
  assert.equal(msToPx(2000, 60), 120)
  assert.equal(pxToMs(120, 60), 2000)
  assert.equal(zoomBy(300, 2), ZOOM_MAX)
})

test('formatTime and ruler step', () => {
  assert.equal(formatTime(65300), '01:05.3')
  assert.ok(msToPx(rulerStepMs(10), 10) >= 70)
})

test('snapValue picks nearest within threshold', () => {
  assert.deepEqual(snapValue(980, [0, 1000, 2000], 50), { ms: 1000, snapped: true })
  assert.deepEqual(snapValue(900, [0, 1000], 50), { ms: 900, snapped: false })
})

test('snapMove snaps either edge and includes playhead', () => {
  const pts = snapPoints([vtrack()], 'c', 3500)
  assert.ok(pts.includes(3500) && pts.includes(3000) && !pts.includes(6000))
  assert.equal(snapMove(3480, 1000, pts, 50), 3500)
  assert.equal(snapMove(2520, 1000, pts, 50), 2500)
  assert.equal(snapMove(4000, 500, pts, 50), 4000)
})

test('overlapsInTrack', () => {
  const t = vtrack()
  assert.equal(overlapsInTrack(t.clips, 900, 200, 'x'), true)
  assert.equal(overlapsInTrack(t.clips, 900, 200, 'a'), true)
  assert.equal(overlapsInTrack(t.clips, 3000, 2000, 'x'), false)
})

test('resolveMove clamps between neighbours', () => {
  const t = vtrack()
  const b = t.clips[1]
  assert.equal(resolveMove(t, b, -500), 1000)
  assert.equal(resolveMove(t, b, 4500), 3000)
  assert.equal(resolveMove(t, b, 1500), 1500)
  assert.equal(resolveMove({ kind: 'music', clips: t.clips }, b, -5), 0)
})

test('resolveResize keeps source range consistent and respects neighbours', () => {
  const t = vtrack()
  const b = t.clips[1]
  assert.deepEqual(resolveResize(t, b, 'end', 2500), { start_ms: 1000, duration_ms: 1500, src_in_ms: 0, src_out_ms: 1500 })
  assert.equal(resolveResize(t, b, 'end', 9000).duration_ms, 4000)
  assert.deepEqual(resolveResize(t, b, 'start', 1500), { start_ms: 1500, duration_ms: 1500, src_in_ms: 500, src_out_ms: 2000 })
  assert.equal(resolveResize(t, b, 'start', 200).start_ms, 1000)
  assert.equal(resolveResize(t, b, 'end', 1010).duration_ms, 100)
  const c = t.clips[2]
  assert.deepEqual(resolveResize(t, c, 'start', 4000), { start_ms: 4000, duration_ms: 2000 })
})

test('splitClipAt divides clip and source range', () => {
  const [x, y] = splitClipAt(clip('b', 1000, 2000, { src_in_ms: 300, src_out_ms: 2300 }), 1500, 'n')
  assert.deepEqual([x.start_ms, x.duration_ms, x.src_in_ms, x.src_out_ms], [1000, 500, 300, 800])
  assert.deepEqual([y.id, y.start_ms, y.duration_ms, y.src_in_ms, y.src_out_ms], ['n', 1500, 1500, 800, 2300])
  assert.equal(splitClipAt(clip('b', 1000, 2000), 1000, 'n'), null)
  assert.equal(splitClipAt(clip('b', 1000, 2000), 1050, 'n'), null)
  assert.equal(splitClipAt(clip('b', 1000, 2000), NaN, 'n'), null)
})

test('lookup helpers', () => {
  const t = vtrack()
  assert.equal(clipAt(t, 1000).id, 'b')
  assert.equal(clipAt(t, 4000), null)
  assert.equal(findClip([t], 'c').track, t)
  assert.equal(timelineDuration([t]), 6000)
  assert.equal(sourceTimeAt(t.clips[1], 1250), 250)
  assert.equal(sourceTimeAt(t.clips[1], 3000), null)
})

test('resolveAssetUrl', () => {
  assert.equal(resolveAssetUrl('data/a.mp4'), '/static/data/a.mp4')
  assert.equal(resolveAssetUrl('/static/a.mp4'), '/static/a.mp4')
  assert.equal(resolveAssetUrl('https://x/y.mp4'), 'https://x/y.mp4')
  assert.equal(resolveAssetUrl(null), '')
})
