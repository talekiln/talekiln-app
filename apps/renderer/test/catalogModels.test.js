import test from 'node:test'
import assert from 'node:assert/strict'

import { getCatalogModels, mergeModelOptions, formatPriceHint } from '../src/utils/modelSelection.js'

const catalog = {
  models: [
    { provider: 'bailian', service_type: 'video', id: 'wan2.6-t2v', label: '万相 2.6 文生视频' },
    { provider: 'bailian', service_type: 'video', id: 'wan9-t2v', label: '万相 9' },
    { provider: 'ark', service_type: 'video', id: 'seedance', label: 'Seedance' },
    { provider: 'bailian', service_type: 'text', id: 'qwen-max', label: '通义千问 Max' }
  ],
  prices: {
    currency: 'CNY',
    providers: { bailian: { video: { 'wan2.6-t2v': { per: 'second', price: 0.6 } } } }
  }
}

test('云端目录按服务类型与平台筛选，并附带价格提示', () => {
  const v = getCatalogModels(catalog, 'video', 'bailian')
  assert.deepEqual(v.map((m) => m.id), ['wan2.6-t2v', 'wan9-t2v'])
  assert.equal(v[0].priceHint, '¥0.6/秒')
  assert.equal(v[1].priceHint, '')
  assert.deepEqual(getCatalogModels(catalog, 'video').map((m) => m.id), ['wan2.6-t2v', 'wan9-t2v', 'seedance'])
  assert.deepEqual(getCatalogModels(catalog, 'image'), [])
})

test('目录缺失或残缺时不报错', () => {
  assert.deepEqual(getCatalogModels(null, 'text'), [])
  assert.deepEqual(getCatalogModels({}, 'text'), [])
  assert.deepEqual(getCatalogModels({ models: [null, { service_type: 'text', id: 'a', provider: 'p' }] }, 'text').map((m) => m.id), ['a'])
})

test('价格提示格式', () => {
  assert.equal(formatPriceHint({ per: 'image', price: 0.2 }), '¥0.2/张')
  assert.equal(formatPriceHint({ per: 'char', price: 0.0002 }), '¥0.0002/字')
  assert.equal(formatPriceHint({ per: 'flat', price: 3 }, 'USD'), 'USD 3')
  assert.equal(formatPriceHint({ per: 'second' }), '')
  assert.equal(formatPriceHint(null), '')
})

test('合并：本地配置的模型在前，目录补充在后并去重，已有模型补上价格提示', () => {
  const merged = mergeModelOptions(['wan2.6-t2v', 'custom'], getCatalogModels(catalog, 'video', 'bailian'))
  assert.deepEqual(merged.map((m) => m.id), ['wan2.6-t2v', 'custom', 'wan9-t2v'])
  assert.equal(merged[0].priceHint, '¥0.6/秒')
  assert.equal(merged[0].fromCatalog, false)
  assert.equal(merged[0].label, '万相 2.6 文生视频')
  assert.equal(merged[2].fromCatalog, true)
  assert.deepEqual(mergeModelOptions(['a', 'a'], []).map((m) => m.id), ['a'])
  assert.deepEqual(mergeModelOptions(undefined, undefined), [])
})
