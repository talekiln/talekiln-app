import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PROVIDERS, filterPresetProviders, normalizeProviders, oneKeyVisible, providerIdForConfig, providerLabels,
} from '../src/utils/providerEnablement.js'
import { setLocale } from '../src/i18n/index.js'

setLocale('zh-CN')

const both = [
  { id: 'bailian', label: '阿里云百炼', aliases: ['bailian', 'dashscope', 'qwen'] },
  { id: 'ark', label: '火山方舟', aliases: ['ark', 'volces', 'volcengine'] },
]

describe('providerEnablement', () => {
  it('falls back to bailian only when the server list is missing or empty', () => {
    assert.deepEqual(normalizeProviders(null), DEFAULT_PROVIDERS)
    assert.deepEqual(normalizeProviders([]), DEFAULT_PROVIDERS)
    assert.deepEqual(normalizeProviders([{ id: 'bailian' }]).map((p) => p.id), ['bailian'])
  })
  it('maps config providers to enabled provider ids', () => {
    assert.equal(providerIdForConfig(null, 'dashscope'), 'bailian')
    assert.equal(providerIdForConfig(null, 'volces'), null)
    assert.equal(providerIdForConfig(both, 'Volces'), 'ark')
  })
  it('hides presets of providers that are not enabled', () => {
    const presets = [{ id: 'dashscope' }, { id: 'volcengine' }, { id: 'openai' }, { id: 'qwen' }]
    assert.deepEqual(filterPresetProviders(presets, null).map((p) => p.id), ['dashscope', 'qwen'])
    assert.deepEqual(filterPresetProviders(presets, both).map((p) => p.id), ['dashscope', 'volcengine', 'qwen'])
  })
  it('one-key buttons and labels follow the list', () => {
    assert.equal(oneKeyVisible(null, 'bailian'), true)
    assert.equal(oneKeyVisible(null, 'ark'), false)
    assert.equal(oneKeyVisible(both, 'ark'), true)
    assert.equal(providerLabels(null), '阿里云百炼')
    assert.equal(providerLabels(both), '阿里云百炼、火山方舟')
  })
})

describe('providerEnablement in English', () => {
  it('names the default provider and joins labels in the current language', () => {
    setLocale('en')
    try {
      assert.equal(DEFAULT_PROVIDERS[0].label, 'Alibaba Cloud Bailian')
      assert.equal(providerLabels(null), 'Alibaba Cloud Bailian')
      assert.equal(providerLabels(both), '阿里云百炼, 火山方舟', 'labels sent by the server stay as they are')
    } finally {
      setLocale('zh-CN')
    }
    assert.equal(providerLabels(null), '阿里云百炼')
    assert.equal(providerLabels(both), '阿里云百炼、火山方舟')
  })
})
