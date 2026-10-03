import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assetName, assetImageUrl, hasAssetImage, parseExtraImages, addExtraImagePatch, setPrimaryPatch, removeExtraPatch,
  resolveMentionDetail, resolveMention, assetCounts, candidateOrder, searchAssets, refsForShot, affectedShots,
} from '../src/utils/assets.js'

const BY = {
  characters: [
    { id: 3, name: '林夏（小夏）' },
    { id: 1, name: '陈默' },
    { id: 2, name: '陈默' },
    { id: 4, name: 'Anna Lee' },
  ],
  scenes: [
    { id: 7, location: '旧书店', time: '黄昏' },
    { id: 8, location: '天台', time: '' },
  ],
  props: [
    { id: 5, name: '旧书' },
    { id: 6, name: '旧书店' },
  ],
}

test('assetName: scene uses location and time', () => {
  assert.equal(assetName('characters', { name: 'A' }), 'A')
  assert.equal(assetName('scenes', { location: '旧书店', time: '黄昏' }), '旧书店 · 黄昏')
  assert.equal(assetName('scenes', { location: '天台' }), '天台')
  assert.equal(assetName('props', null), '')
})

test('assetImageUrl prefers local static path; hasAssetImage', () => {
  assert.equal(assetImageUrl({ local_path: 'a/b.png', image_url: 'http://x/y.png' }), '/static/a/b.png')
  assert.equal(assetImageUrl({ image_url: 'http://x/y.png' }), 'http://x/y.png')
  assert.equal(assetImageUrl({}), '')
  assert.equal(hasAssetImage({ local_path: 'a.png' }), true)
  assert.equal(hasAssetImage({}), false)
})

test('extra images: parse, add, set primary, remove', () => {
  assert.deepEqual(parseExtraImages('["a.png","b.png"]'), ['a.png', 'b.png'])
  assert.deepEqual(parseExtraImages(['a.png']), ['a.png'])
  assert.deepEqual(parseExtraImages('oops'), [])
  assert.deepEqual(parseExtraImages(null), [])
  // first upload becomes primary, later ones go to extra_images
  assert.deepEqual(addExtraImagePatch({}, 'n.png'), { local_path: 'n.png' })
  assert.deepEqual(addExtraImagePatch({ local_path: 'p.png', extra_images: '["a.png"]' }, 'n.png'), { extra_images: ['a.png', 'n.png'] })
  // set an extra as primary: old primary is demoted to the first extra (legacy behaviour)
  assert.deepEqual(
    setPrimaryPatch({ local_path: 'p.png', extra_images: ['a.png', 'b.png'] }, 'b.png'),
    { local_path: 'b.png', image_url: '', extra_images: ['p.png', 'a.png'] },
  )
  assert.deepEqual(removeExtraPatch({ extra_images: ['a.png', 'b.png'] }, 'a.png'), { extra_images: ['b.png'] })
})

test('resolveMention: same name, @ vs #', () => {
  assert.equal(resolveMention('@陈默', BY).id, 1)
  assert.equal(resolveMention('@Anna Lee', BY).id, 4)
  assert.equal(resolveMention('#旧书店', BY).id, 7) // scene wins over same-named prop
  assert.equal(resolveMention('#旧书', BY).id, 5)
  assert.equal(resolveMention('#天台', BY).id, 8)
  assert.equal(resolveMention('#旧书店·黄昏', BY).id, 7)
})

test('resolveMention: duplicate names flagged ambiguous, lowest id wins', () => {
  const d = resolveMentionDetail('@陈默', BY)
  assert.equal(d.asset.id, 1)
  assert.equal(d.ambiguous, true)
  assert.deepEqual(d.candidates.map((c) => c.id), [1, 2])
  assert.equal(d.kind, 'characters')
})

test('resolveMention: bracketed alias, width and case normalisation', () => {
  assert.equal(resolveMention('@林夏', BY).id, 3)
  assert.equal(resolveMention('@小夏', BY).id, 3)
  assert.equal(resolveMention('@林夏(小夏)', BY).id, 3)
  assert.equal(resolveMention('@ anna  lee ', BY).id, 4)
  assert.equal(resolveMention('@ＡＮＮＡ　ＬＥＥ', BY).id, 4)
})

test('resolveMention: not found / malformed', () => {
  assert.equal(resolveMention('@不存在', BY), null)
  assert.equal(resolveMention('陈默', BY), null)
  assert.equal(resolveMention('@', BY), null)
  assert.equal(resolveMention('', BY), null)
  assert.equal(resolveMention(null, BY), null)
  const d = resolveMentionDetail('@不存在', BY)
  assert.equal(d.asset, null)
  assert.equal(d.ambiguous, false)
})

test('assetCounts', () => {
  assert.deepEqual(assetCounts(BY), { characters: 4, scenes: 2, props: 2 })
  assert.deepEqual(assetCounts({}), { characters: 0, scenes: 0, props: 0 })
})

test('candidateOrder: locked first, completed by score then id desc, pending, failed', () => {
  const list = [
    { id: 1, status: 'failed' },
    { id: 2, status: 'pending' },
    { id: 3, status: 'completed', score: 0.5 },
    { id: 4, status: 'completed', score: 0.9 },
    { id: 5, status: 'completed' },
    { id: 6, status: 'completed' },
    { id: 7, status: 'processing' },
  ]
  const out = candidateOrder(list, new Set([5])).map((c) => c.id)
  assert.deepEqual(out, [5, 4, 3, 6, 7, 2, 1])
  // does not mutate
  assert.equal(list[0].id, 1)
})

test('searchAssets filters by keyword across kinds', () => {
  assert.deepEqual(searchAssets(BY, '旧书').map((r) => `${r.kind}:${r.asset.id}`), ['scenes:7', 'props:5', 'props:6'])
  assert.equal(searchAssets(BY, '').length, 8)
  assert.deepEqual(searchAssets(BY, '小夏', 'characters').map((r) => r.asset.id), [3])
})

test('refsForShot resolves character/scene/prop references of a shot', () => {
  const shot = { character_ids: [1, 99], scene_id: 7, prop_ids: '[5,6]' }
  const r = refsForShot(shot, BY)
  assert.deepEqual(r.characters.map((a) => a.id), [1])
  assert.deepEqual(r.scenes.map((a) => a.id), [7])
  assert.deepEqual(r.props.map((a) => a.id), [5, 6])
  assert.deepEqual(refsForShot(null, BY), { characters: [], scenes: [], props: [] })
})

test('affectedShots finds shots that reference an asset', () => {
  const shots = [
    { id: 1, character_ids: [1], scene_id: 7 },
    { id: 2, character_ids: [2], scene_id: 8, prop_ids: [5] },
    { id: 3, characters: [{ id: 1 }], scene_id: 7 },
  ]
  assert.deepEqual(affectedShots('characters', 1, shots).map((s) => s.id), [1, 3])
  assert.deepEqual(affectedShots('scenes', 8, shots).map((s) => s.id), [2])
  assert.deepEqual(affectedShots('props', 5, shots).map((s) => s.id), [2])
  assert.deepEqual(affectedShots('props', 5, null), [])
})

test('pickEpisodeId: route > last viewed (if it still exists) > first episode > null', async () => {
  const { pickEpisodeId } = await import('../src/utils/assets.js')
  const eps = [{ id: 10 }, { id: 11 }]
  assert.equal(pickEpisodeId({ routeEpisodeId: '11', lastEpisodeId: 10, episodes: eps }), 11)
  assert.equal(pickEpisodeId({ lastEpisodeId: 11, episodes: eps }), 11)
  assert.equal(pickEpisodeId({ lastEpisodeId: 99, episodes: eps }), 10)
  assert.equal(pickEpisodeId({ episodes: [] }), null)
  assert.equal(pickEpisodeId(), null)
})

test('libraryItemToAsset maps library rows to create bodies', async () => {
  const { libraryItemToAsset } = await import('../src/utils/assets.js')
  assert.deepEqual(libraryItemToAsset('characters', { name: 'A', description: 'tall', local_path: 'a.png' }), {
    name: 'A', description: 'tall', appearance: 'tall', local_path: 'a.png',
  })
  assert.deepEqual(libraryItemToAsset('scenes', { location: 'L', time: 'T', description: 'd', image_url: 'http://x' }, { episodeId: 3 }), {
    location: 'L', time: 'T', prompt: 'd', episode_id: 3, image_url: 'http://x',
  })
  assert.deepEqual(libraryItemToAsset('props', { name: 'P', prompt: 'p' }), { name: 'P', type: '', description: '', prompt: 'p' })
})

test('mentionToken: @ for characters, # for scenes and props, and it resolves back', async () => {
  const { mentionToken, resolveMention } = await import('../src/utils/assets.js')
  const byKind = {
    characters: [{ id: 1, name: '林夏' }],
    scenes: [{ id: 7, location: '旧书店', time: '黄昏' }],
    props: [{ id: 5, name: '旧 书' }],
  }
  assert.equal(mentionToken('characters', byKind.characters[0]), '@林夏')
  assert.equal(mentionToken('scenes', byKind.scenes[0]), '#旧书店·黄昏')
  assert.equal(mentionToken('props', byKind.props[0]), '#旧书')
  assert.equal(mentionToken('props', { name: '' }), '')
  for (const kind of ['characters', 'scenes', 'props']) {
    const it = byKind[kind][0]
    assert.equal(resolveMention(mentionToken(kind, it), byKind).id, it.id)
  }
})
