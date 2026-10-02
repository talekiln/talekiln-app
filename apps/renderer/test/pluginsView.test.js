import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMMUNITY_NOTE, DEFAULT_SDK_DOCS_URL, capabilityLabels, detailRows, formatDate, mergeProviderList, normalizeInstallPath,
  permissionLabels, sdkDocsUrl, shortHash, signatureLabel, signatureTagType, statusText, switchState,
} from '../src/utils/pluginsView.js'

const providers = [
  { id: 'bailian', label: '阿里云百炼', aliases: ['bailian', 'dashscope'] },
  { id: 'ark', label: '火山方舟', aliases: ['ark'] },
]
const plugin = (o = {}) => ({
  id: 'acme', name: 'acme', label: 'Acme', version: '0.1.0', description: '', homepage: 'https://plugins.acme.example/', sdk_version: '1.0.0',
  dir: '/data/plugins/acme', source: 'plugin', capabilities: ['text.stream', 'image.generate', 'video.submit', 'video.poll', 'tts.synthesize'],
  permissions: ['network:api.acme.example', 'secret:apiKey'], hosts: ['api.acme.example'], needs_api_key: true,
  signature: { status: 'official', kid: 'lic-1', hash: 'a'.repeat(64), reason: null }, enabled: true, active: true, blocked_reason: null, load_error: null,
  installed_at: '2026-10-01T02:03:00.000Z', updated_at: '2026-10-01T02:03:00.000Z', reviewed_at: null, ...o,
})

describe('pluginsView', () => {
  it('merges built-ins first, then plugins by label; a plugin shadowing a built-in id is dropped', () => {
    const items = mergeProviderList(providers, [plugin({ id: 'zeta', label: 'Zeta' }), plugin(), plugin({ id: 'ark', label: 'Fake Ark' })])
    assert.deepEqual(items.map((i) => [i.id, i.source]), [['bailian', 'builtin'], ['ark', 'builtin'], ['acme', 'plugin'], ['zeta', 'plugin']])
    assert.deepEqual(items[0].signature, { status: 'builtin', kid: null, hash: null, reason: null })
    assert.equal(items[0].locked, true)
    assert.equal(items[2].locked, false)
    // no providers -> default (bailian only); no plugins -> only built-ins
    assert.deepEqual(mergeProviderList(null, null).map((i) => i.id), ['bailian'])
    assert.deepEqual(mergeProviderList([], [{ id: '' }, null, { nope: 1 }]).map((i) => i.id), ['bailian'])
  })

  it('normalises a plugin item: unknown signature status counts as invalid, hosts derive from permissions', () => {
    const [, p] = mergeProviderList([{ id: 'bailian' }], [{ id: 'x', permissions: ['network:a.example', 'secret:apiKey'], signature: { status: 'weird' }, enabled: 1 }])
    assert.equal(p.signature.status, 'invalid')
    assert.deepEqual(p.hosts, ['a.example'])
    assert.equal(p.needs_api_key, true)
    assert.equal(p.enabled, true)
    assert.equal(p.label, 'x')
  })

  it('signature labels and tag colours', () => {
    assert.deepEqual(['builtin', 'official', 'unsigned', 'invalid', 'other'].map(signatureLabel), ['官方内置', '官方签名', '未签名', '签名无效', '签名无效'])
    assert.deepEqual(['builtin', 'official', 'unsigned', 'invalid', 'other'].map(signatureTagType), ['success', 'success', 'warning', 'danger', 'danger'])
  })

  it('capability and permission labels merge video submit/poll and network hosts', () => {
    assert.deepEqual(capabilityLabels(['llm.chat', 'text.stream', 'video.submit', 'video.poll', 'tts.synthesize', 'custom.x']), ['文本生成', '视频生成', '配音合成', 'custom.x'])
    assert.deepEqual(capabilityLabels(null), [])
    assert.deepEqual(permissionLabels(['network:a.example', 'network:*.b.example', 'secret:apiKey', 'other']), ['访问 a.example、*.b.example', '使用你保存的 API Key', 'other'])
    assert.deepEqual(permissionLabels([]), [])
  })

  it('switch state follows the trust model and developer mode', () => {
    const items = mergeProviderList(providers, [plugin(), plugin({ id: 'u', label: 'U', signature: { status: 'unsigned', hash: 'b'.repeat(64) }, enabled: false, active: false })])
    const [builtin, , official, unsigned] = [items[0], items[1], items[2], items[3]]
    assert.deepEqual(switchState(builtin, false), { checked: true, disabled: true, hint: '内置服务商随应用发布，开关由安装包决定' })
    assert.deepEqual(switchState(official, false), { checked: true, disabled: false, hint: null })
    const off = switchState(unsigned, false)
    assert.deepEqual([off.checked, off.disabled], [false, true])
    assert.match(off.hint, /开发者模式/)
    assert.deepEqual(switchState(unsigned, true), { checked: false, disabled: false, hint: null })
  })

  it('status text explains why a plugin is not running', () => {
    assert.equal(statusText(mergeProviderList(providers, [])[0], false), '可用')
    const run = (o, dev = false) => statusText(mergeProviderList([], [plugin(o)])[1], dev)
    assert.equal(run({}), '运行中')
    assert.equal(run({ enabled: false, active: false }), '已关闭')
    assert.equal(run({ active: false, load_error: 'boom' }), '加载失败：boom')
    assert.equal(run({ active: false, signature: { status: 'unsigned' } }), '未启用：需开启开发者模式')
    assert.equal(run({ signature: { status: 'unsigned' } }, true), '运行中（开发者模式）')
    assert.equal(run({ active: false, blocked_reason: '等待' }), '等待')
  })

  it('detail rows: built-ins show only the generic rows, plugins add signature, hash, review date and folder', () => {
    const [b, p] = mergeProviderList([{ id: 'bailian', label: '阿里云百炼' }], [plugin({ reviewed_at: '2026-10-02T00:00:00.000Z' })])
    const keys = (rows) => rows.map((r) => r.key)
    assert.deepEqual(keys(detailRows(b)), ['source', 'version', 'capabilities', 'hosts', 'permissions', 'signature'])
    const rows = detailRows(p)
    assert.deepEqual(keys(rows), ['source', 'version', 'capabilities', 'hosts', 'permissions', 'signature', 'kid', 'hash', 'reviewed', 'installed', 'sdk', 'dir', 'homepage'])
    const by = Object.fromEntries(rows.map((r) => [r.key, r]))
    assert.equal(by.capabilities.value, '文本生成、图片生成、视频生成、配音合成')
    assert.equal(by.hosts.value, 'api.acme.example')
    assert.equal(by.permissions.value, '访问 api.acme.example；使用你保存的 API Key')
    assert.equal(by.signature.value, '官方签名')
    assert.equal(by.hash.value, 'a'.repeat(64))
    assert.equal(by.reviewed.value, formatDate('2026-10-02T00:00:00.000Z'))
    assert.equal(by.homepage.link, 'https://plugins.acme.example/')
    const inv = detailRows(mergeProviderList([], [plugin({ signature: { status: 'invalid', reason: 'bad signature' }, reviewed_at: null, homepage: 'http://x' })])[1])
    const ib = Object.fromEntries(inv.map((r) => [r.key, r]))
    assert.equal(ib.signature.value, '签名无效（bad signature）')
    assert.equal(ib.reviewed.value, '未知')
    assert.equal(ib.homepage.link, null, 'only https homepages become links')
  })

  it('helpers: short hash, date formatting, install path, docs url, community note', () => {
    assert.equal(shortHash('abcdef0123456789'), 'abcdef012345…')
    assert.equal(shortHash('abc'), 'abc')
    assert.equal(shortHash(null), '')
    assert.equal(formatDate(null), '—')
    assert.equal(formatDate('nope', '?'), '?')
    assert.match(formatDate('2026-10-02T00:00:00.000Z'), /^2026-\d{2}-\d{2} \d{2}:\d{2}$/)
    assert.equal(normalizeInstallPath('  "C:\\plugins\\acme"  '), 'C:\\plugins\\acme')
    assert.equal(normalizeInstallPath(''), null)
    assert.equal(normalizeInstallPath(null), null)
    assert.equal(sdkDocsUrl({}), DEFAULT_SDK_DOCS_URL)
    assert.equal(sdkDocsUrl({ VITE_PLUGIN_SDK_DOCS_URL: 'https://docs.example/sdk' }), 'https://docs.example/sdk')
    assert.equal(sdkDocsUrl({ VITE_PLUGIN_SDK_DOCS_URL: 'http://docs.example/sdk' }), DEFAULT_SDK_DOCS_URL, 'non-https falls back')
    assert.equal(sdkDocsUrl({ VITE_PLUGIN_SDK_DOCS_URL: 'https://u:p@docs.example/' }), DEFAULT_SDK_DOCS_URL)
    assert.match(COMMUNITY_NOTE, /维护者/)
  })
})
