import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createApi } from '../src/api.js'
import { ROUTE_META } from '../src/route-meta.js'
import { auditActionLabel } from '../src/ops.js'
import {
  TIER_OPTIONS, latestPublished, manifestSummary, parseManifestText, templateBody, templateRow, tierLabel, validateTemplate, versionBody, versionState,
} from '../src/templates.js'

function recorder(body = {}) {
  const calls = []
  const f = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined })
    return { ok: true, status: 200, json: async () => body }
  }
  return { api: createApi({ fetchImpl: f }), calls }
}

const MANIFEST = {
  id: 'tpl-a', name: 'A', version: '1.0.0', genre: 'guofeng', tier: 'free', style: { name: 's', prompt: 'p' },
  character_slots: [{ id: 'x', name: '甲' }],
  shots: [{ title: '一', duration_ms: 5000, prompt_template: '{{x}}', character_slots: ['x'] }, { title: '二', duration_ms: 7000, prompt_template: 'y', character_slots: [] }],
}

describe('模板市场后台', () => {
  it('新建表单校验与请求体', () => {
    assert.match(validateTemplate({ id: 'Bad Id', name: 'x', genre: 'g', tier: 'free' }), /id/)
    assert.match(validateTemplate({ id: 'ok-id', name: '', genre: 'g', tier: 'free' }), /名称/)
    assert.match(validateTemplate({ id: 'ok-id', name: 'x', genre: '', tier: 'free' }), /类型/)
    assert.match(validateTemplate({ id: 'ok-id', name: 'x', genre: 'g', tier: 'vip' }), /档位/)
    assert.equal(validateTemplate({ id: 'ok-id', name: 'x', genre: 'g', tier: 'pro' }), null)
    assert.deepEqual(templateBody({ id: ' ok-id ', name: ' 名 ', genre: ' g ', tier: 'pro', description: undefined }), { id: 'ok-id', name: '名', genre: 'g', tier: 'pro', description: '' })
    assert.equal(tierLabel('pro'), '付费')
    assert.equal(tierLabel('zzz'), 'zzz')
    assert.equal(TIER_OPTIONS.length, 2)
  })

  it('清单文本解析：JSON、必填字段、id 一致、禁止自带签名', () => {
    assert.match(parseManifestText('{nope').error, /JSON/)
    assert.match(parseManifestText('[]').error, /对象/)
    assert.match(parseManifestText(JSON.stringify({ id: 'a' })).error, /缺少字段 name/)
    assert.match(parseManifestText(JSON.stringify({ ...MANIFEST, shots: [] })).error, /shots/)
    assert.match(parseManifestText(JSON.stringify(MANIFEST), 'tpl-b').error, /不一致/)
    assert.match(parseManifestText(JSON.stringify({ ...MANIFEST, signature: 'x' })).error, /signature/)
    assert.deepEqual(parseManifestText(JSON.stringify(MANIFEST), 'tpl-a').manifest, MANIFEST)
    assert.equal(parseManifestText(JSON.stringify(MANIFEST)).error, undefined)
    assert.equal(manifestSummary(MANIFEST), '2 个镜头 · 1 个角色槽位 · 12 秒')
    assert.equal(manifestSummary(null), '—')
    assert.deepEqual(versionBody({ manifest: MANIFEST, packageUrl: ' ' }), { manifest: MANIFEST, packageUrl: null })
    assert.equal(versionBody({ manifest: MANIFEST, packageUrl: 'https://x/y.lytpl' }).packageUrl, 'https://x/y.lytpl')
  })

  it('版本状态与目录里的版本', () => {
    assert.deepEqual(versionState({ published: true }), { label: '已发布', type: 'success' })
    assert.equal(versionState(null).label, '未发布')
    const vs = [
      { id: '1', version: '1.0.0', published: true, publishedAt: '2026-10-01T00:00:00Z' },
      { id: '2', version: '1.1.0', published: true, publishedAt: '2026-10-03T00:00:00Z' },
      { id: '3', version: '1.2.0', published: false, publishedAt: null },
    ]
    assert.equal(latestPublished(vs).version, '1.1.0')
    assert.equal(latestPublished([vs[2]]), null)
    assert.equal(latestPublished([]), null)
    const row = templateRow({ id: 'tpl-a', name: 'A', versions: vs })
    assert.equal(row.versionCount, 3)
    assert.equal(row.liveVersion, '1.1.0')
    assert.equal(row.state.label, '目录中：v1.1.0')
    assert.equal(templateRow({ id: 'b', versions: [] }).state.label, '未发布')
  })

  it('api 路径、方法与请求体', async () => {
    const { api, calls } = recorder()
    await api.listTemplates()
    await api.getTemplate('a/b')
    await api.createTemplate({ id: 'tpl-a', name: 'A', genre: 'g' })
    await api.updateTemplate('tpl-a', { description: 'd' })
    await api.addTemplateVersion('tpl-a', { manifest: MANIFEST, packageUrl: null })
    await api.publishTemplateVersion('tpl-a', 'v1')
    await api.publishTemplateVersion('tpl-a', 'v1', false)
    await api.deleteTemplate('tpl-a')
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
      'GET /api/admin/templates',
      'GET /api/admin/templates/a%2Fb',
      'POST /api/admin/templates',
      'PUT /api/admin/templates/tpl-a',
      'POST /api/admin/templates/tpl-a/versions',
      'POST /api/admin/templates/tpl-a/versions/v1/publish',
      'POST /api/admin/templates/tpl-a/versions/v1/unpublish',
      'DELETE /api/admin/templates/tpl-a',
    ])
    assert.deepEqual(calls[4].body, { manifest: MANIFEST, packageUrl: null })
    assert.deepEqual(calls[5].body, {})
  })

  it('路由元信息与审计动作文案', () => {
    assert.deepEqual(ROUTE_META.templates, { title: '模板市场', perm: 'read' })
    assert.equal(auditActionLabel('POST /admin/templates'), '新建模板')
    assert.equal(auditActionLabel('POST /admin/templates/:id/versions'), '新增模板版本')
    assert.equal(auditActionLabel('POST /admin/templates/:id/versions/:vid/publish'), '发布模板版本')
    assert.equal(auditActionLabel('POST /admin/templates/:id/versions/:vid/unpublish'), '下架模板版本')
    assert.equal(auditActionLabel('DELETE /admin/templates/:id'), '删除模板')
  })
})
