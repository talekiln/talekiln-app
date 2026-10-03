import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  GENRE_LABEL, applyBody, applyTarget, canApply, characterOptions, cloudItemState, estimateText, formatDuration, genreLabel, groupByGenre,
  signatureLabel, sourceLabel, summaryLines, tierLabel, validateSlotMapping,
} from '../src/utils/templateMarket.js'
import { createBuiltinCommands } from '../src/utils/builtinCommands.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SUMMARY = {
  shot_count: 8, total_duration_ms: 45000, group_count: 3, groups: ['开场', '冲突', '反转'], line_count: 9,
  slots: [{ id: 'heroine', name: '沈清辞' }, { id: 'hero', name: '顾长宁' }, { id: 'villain', name: '柳姨娘' }],
  style: { name: '古风写实', preset: 'historical', aspect_ratio: '9:16' }, music_hint: '古筝慢板', cameras: ['全景缓推', '近景'],
}

test('groupByGenre: 按类型分组，组内按使用次数再按名字', () => {
  const items = [
    { id: 'a', name: '乙', genre: 'guofeng', use_count: 1 },
    { id: 'b', name: '甲', genre: 'ecommerce', use_count: 0 },
    { id: 'c', name: '甲', genre: 'guofeng', use_count: 1 },
    { id: 'd', name: '丙', genre: 'guofeng', use_count: 5 },
    { id: 'e', name: '无类型', genre: '', use_count: 0 },
  ]
  const g = groupByGenre(items)
  assert.deepEqual(g.map((x) => x.label), ['国风短剧', '产品种草', '其他'])
  assert.deepEqual(g[0].items.map((x) => x.id), ['d', 'c', 'a'])
  assert.deepEqual(groupByGenre([]), [])
  assert.equal(genreLabel('knowledge'), '知识讲解')
  assert.equal(genreLabel('xyz'), 'xyz')
  assert.equal(genreLabel(''), '其他')
})

test('genreLabel: 每个内置官方模板的 genre 都有中文名', () => {
  const dir = path.join(__dirname, '..', '..', '..', 'packages', 'local', 'templates')
  const ids = fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'manifest.json')))
  assert.ok(ids.length >= 11)
  const genres = new Set(ids.map((id) => JSON.parse(fs.readFileSync(path.join(dir, id, 'manifest.json'), 'utf8')).genre))
  for (const g of genres) {
    assert.ok(Object.prototype.hasOwnProperty.call(GENRE_LABEL, g), `genre ${g} 没有中文名`)
    assert.match(GENRE_LABEL[g], /^[一-龥]{2,6}$/, g)
  }
  assert.deepEqual([...genres].sort(), ['campus', 'ecommerce', 'family', 'guofeng', 'healing', 'knowledge', 'rebirth', 'revenge', 'suspense', 'urban-sweet', 'workplace'])
  assert.equal(groupByGenre(ids.map((id) => ({ id, genre: JSON.parse(fs.readFileSync(path.join(dir, id, 'manifest.json'), 'utf8')).genre }))).some((g) => g.label === '其他'), false)
})

test('标签与时长', () => {
  assert.deepEqual(tierLabel('pro'), { label: '付费', type: 'warning' })
  assert.equal(tierLabel('free').label, '免费')
  assert.equal(tierLabel('weird').label, 'weird')
  assert.equal(sourceLabel('builtin'), '内置')
  assert.equal(signatureLabel('official').label, '官方')
  assert.equal(signatureLabel('invalid').type, 'danger')
  assert.equal(formatDuration(45000), '45 秒')
  assert.equal(formatDuration(80000), '1 分 20 秒')
  assert.equal(formatDuration(120000), '2 分')
  assert.equal(formatDuration(null), '0 秒')
})

test('summaryLines: 「套用后会得到」', () => {
  const lines = summaryLines(SUMMARY)
  assert.equal(lines[0], '8 个镜头，总时长 45 秒，3 个段落（开场、冲突、反转）')
  assert.equal(lines[1], '3 个角色槽位：沈清辞、顾长宁、柳姨娘')
  assert.equal(lines[2], '风格：古风写实（historical，9:16）')
  assert.ok(lines.includes('9 条台词 / 旁白行，会直接进入剧本'))
  assert.ok(lines.includes('配乐提示：古筝慢板'))
  assert.ok(lines.includes('运镜：全景缓推、近景'))
  const none = summaryLines({ shot_count: 2, total_duration_ms: 6000, groups: [], slots: [], style: { name: 'x' } })
  assert.equal(none[0], '2 个镜头，总时长 6 秒')
  assert.equal(none[1], '没有角色槽位，不需要映射角色')
  assert.equal(none[2], '风格：x')
  assert.deepEqual(summaryLines(null), [])
})

test('estimateText 与 canApply', () => {
  assert.equal(estimateText({ total: 6.1, max: 7.32, currency: 'CNY', known: true, sample_prices: true }), '预计 ¥6.10，最高 ¥7.32（示例价）')
  assert.equal(estimateText({ total: 0, max: 0, currency: 'CNY', known: false, sample_prices: false }), '预计 ¥0.00，最高 ¥0.00（部分模型没有价格，按 0 计）')
  assert.equal(estimateText(null), '')
  assert.deepEqual(canApply({ tier: 'free' }, false, '需要登录'), { ok: true, reason: '' })
  assert.deepEqual(canApply({ tier: 'pro' }, false, '需要登录'), { ok: false, reason: '需要登录' })
  assert.deepEqual(canApply({ tier: 'pro' }, true), { ok: true, reason: '' })
  assert.equal(canApply(null, true).ok, false)
})

test('characterOptions: 锁定的排前面并标注', () => {
  const opts = characterOptions([{ id: 1, name: '阿宁' }, { id: 2, name: '老周' }, { id: 3, name: '小花' }], [{ entity_id: 2 }])
  assert.deepEqual(opts.map((o) => [o.id, o.locked]), [[2, true], [1, false], [3, false]])
  assert.equal(opts[0].label, '老周（已锁定参考图）')
  assert.equal(opts[1].label, '阿宁')
  assert.deepEqual(characterOptions(null, null), [])
})

test('validateSlotMapping: 未映射允许、未知角色与重复映射报错', () => {
  const opts = characterOptions([{ id: 1, name: '阿宁' }, { id: 2, name: '老周' }], [])
  const ok = validateSlotMapping(SUMMARY.slots, { heroine: 1, hero: '2' }, opts)
  assert.equal(ok.ok, true)
  assert.equal(ok.mapped, 2)
  assert.deepEqual(ok.unmapped, ['柳姨娘'])
  const dup = validateSlotMapping(SUMMARY.slots, { heroine: 1, hero: 1 }, opts)
  assert.equal(dup.ok, false)
  assert.match(dup.errors[0], /同一个角色/)
  const unknown = validateSlotMapping(SUMMARY.slots, { heroine: 99 }, opts)
  assert.equal(unknown.ok, false)
  assert.match(unknown.errors[0], /不在所选项目里/)
  const none = validateSlotMapping(SUMMARY.slots, {}, opts)
  assert.equal(none.ok, true)
  assert.equal(none.mapped, 0)
  assert.equal(none.unmapped.length, 3)
  assert.equal(validateSlotMapping([], null, null).ok, true)
})

test('applyBody / applyTarget / cloudItemState', () => {
  assert.deepEqual(applyBody({ mode: 'new', title: ' 我的剧 ', map: { heroine: 1, hero: '', villain: null } }), { mode: 'new', title: '我的剧', character_map: { heroine: 1 } })
  assert.deepEqual(applyBody({ mode: 'episode', dramaId: '7', title: '', map: { host: '3' } }), { mode: 'episode', drama_id: 7, character_map: { host: 3 } })
  assert.deepEqual(applyBody({ mode: 'weird' }), { mode: 'new', character_map: {} })
  assert.deepEqual(applyTarget({ drama_id: 2, episode_id: 9 }), { name: 'episode-storyboard', params: { dramaId: 2, episodeId: 9 } })
  assert.equal(cloudItemState({ installed: false }).action, '安装')
  assert.equal(cloudItemState({ installed: true, version: '1.1.0', installed_version: '1.0.0' }).action, '更新')
  assert.equal(cloudItemState({ installed: true, version: '1.0.0', installed_version: '1.0.0' }).label, '已安装')
})

test('命令面板有「模板市场」入口', () => {
  const gone = []
  const cmds = createBuiltinCommands({ go: (l) => gone.push(l) })
  const c = cmds.find((x) => x.id === 'nav.templates')
  assert.ok(c)
  assert.equal(c.title, '模板市场')
  assert.ok(c.keywords.includes('模板'))
  c.run({})
  assert.deepEqual(gone, ['/templates'])
})
