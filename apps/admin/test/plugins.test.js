import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createApi } from '../src/api.js'
import { ROUTE_META } from '../src/route-meta.js'
import { auditActionLabel } from '../src/ops.js'
import { visibleMenu } from '../src/permissions.js'
import {
  STATUS_OPTIONS, actionGate, fileHashRows, keySummary, manifestFileName, parseInspectText, prettyJson, reviewActionLabel,
  signState, signedManifestText, statusTag, submitBody, validateSubmission, versionRow,
} from '../src/plugins.js'

function recorder(body = {}) {
  const calls = []
  const f = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined })
    return { ok: true, status: 200, json: async () => body }
  }
  return { api: createApi({ fetchImpl: f }), calls }
}

const SHA = 'a'.repeat(64)
const MANIFEST = {
  name: 'acme', version: '0.1.0', sdkVersion: '1.0.0', label: 'Acme', capabilities: ['llm.chat'],
  permissions: ['network:api.acme.example', 'secret:apiKey'], entry: 'index.js', files: ['index.js', 'lib/helper.js'],
}
const HASHES = { 'index.js': '1'.repeat(64), 'lib/helper.js': '2'.repeat(64) }
/** sign-plugin.mjs --inspect 的输出形状 */
const INSPECT = { name: 'acme', version: '0.1.0', files: MANIFEST.files, fileHashes: HASHES, hash: 'f'.repeat(64), manifest: MANIFEST, signature: { status: 'unsigned', reason: null, kid: null } }
const SIG = { alg: 'ES256', kid: 'plg-1', value: 'A'.repeat(86) }
const VERSION = {
  id: 'v1', name: 'acme', version: '0.1.0', label: 'Acme', manifest: MANIFEST, fileHashes: HASHES, hash: 'f'.repeat(64),
  packageUrl: 'https://dl.example/acme.zip', sha256: SHA, signature: null, kid: null, signedManifest: null, reviewStatus: 'pending',
}

describe('插件审核后台', () => {
  it('状态与审核动作文案', () => {
    assert.deepEqual(statusTag('pending'), { label: '待审核', type: 'warning' })
    assert.deepEqual(statusTag('approved'), { label: '已通过', type: 'success' })
    assert.deepEqual(statusTag('rejected'), { label: '已驳回', type: 'danger' })
    assert.equal(statusTag('weird').label, 'weird')
    assert.deepEqual(STATUS_OPTIONS.map((o) => o.value), ['', 'pending', 'approved', 'rejected'])
    assert.deepEqual(['submit', 'approve', 'reject', 'sign'].map(reviewActionLabel), ['登记', '通过', '驳回', '签名'])
    assert.equal(reviewActionLabel(undefined), '—')
  })

  it('签名状态：未签名 / 当前密钥 / 旧密钥；不知道当前 kid 时只分已签未签', () => {
    assert.deepEqual(signState(VERSION, 'plg-1'), { label: '未签名', type: 'info', kid: null, stale: false })
    const signed = { ...VERSION, signature: SIG }
    assert.deepEqual(signState(signed, 'plg-1'), { label: '已签名 plg-1', type: 'success', kid: 'plg-1', stale: false })
    assert.deepEqual(signState(signed, 'plg-2'), { label: '旧密钥 plg-1', type: 'warning', kid: 'plg-1', stale: true })
    assert.deepEqual(signState(signed, null), { label: '已签名 plg-1', type: 'success', kid: 'plg-1', stale: false })
    assert.equal(signState(null, 'plg-1').label, '未签名')
  })

  it('--inspect 输出解析：JSON、manifest 字段、files 含 entry、禁止自带签名、fileHashes 与 files 对应、哈希格式', () => {
    assert.match(parseInspectText('{nope').error, /JSON/)
    assert.match(parseInspectText('[]').error, /对象/)
    assert.match(parseInspectText(JSON.stringify({ fileHashes: HASHES })).error, /缺少 manifest/)
    assert.match(parseInspectText(JSON.stringify({ manifest: { name: 'a' }, fileHashes: HASHES })).error, /缺少字段 version/)
    assert.match(parseInspectText(JSON.stringify({ manifest: { ...MANIFEST, files: [] }, fileHashes: HASHES })).error, /files 须为非空/)
    assert.match(parseInspectText(JSON.stringify({ manifest: { ...MANIFEST, files: ['lib/helper.js'] }, fileHashes: HASHES })).error, /必须包含 entry/)
    assert.match(parseInspectText(JSON.stringify({ manifest: { ...MANIFEST, signature: SIG }, fileHashes: HASHES })).error, /signature/)
    assert.match(parseInspectText(JSON.stringify({ manifest: MANIFEST })).error, /缺少 fileHashes/)
    assert.match(parseInspectText(JSON.stringify({ manifest: MANIFEST, fileHashes: { 'index.js': HASHES['index.js'] } })).error, /一一对应/)
    assert.match(parseInspectText(JSON.stringify({ manifest: MANIFEST, fileHashes: { ...HASHES, 'extra.js': SHA } })).error, /一一对应/)
    assert.match(parseInspectText(JSON.stringify({ manifest: MANIFEST, fileHashes: { ...HASHES, 'index.js': 'xyz' } })).error, /sha256/)
    // 完整的 --inspect 输出与裸 { manifest, fileHashes } 都接受
    assert.deepEqual(parseInspectText(JSON.stringify(INSPECT)), { manifest: MANIFEST, fileHashes: HASHES, hash: 'f'.repeat(64) })
    assert.deepEqual(parseInspectText(JSON.stringify({ manifest: MANIFEST, fileHashes: HASHES })), { manifest: MANIFEST, fileHashes: HASHES, hash: null })
  })

  it('登记表单校验与请求体：https、sha256 小写 64 位、备注长度', () => {
    const parsed = parseInspectText(JSON.stringify(INSPECT))
    assert.match(validateSubmission({ parsed: null, error: '' }), /粘贴/)
    assert.equal(validateSubmission({ parsed: null, error: '不是合法的 JSON：x' }), '不是合法的 JSON：x')
    assert.match(validateSubmission({ parsed, packageUrl: 'http://dl.example/a.zip', sha256: SHA }), /https/)
    assert.match(validateSubmission({ parsed, packageUrl: 'https://dl.example/a.zip', sha256: 'abc' }), /sha256/)
    assert.match(validateSubmission({ parsed, packageUrl: 'https://dl.example/a.zip', sha256: SHA, notes: 'x'.repeat(2001) }), /备注/)
    assert.equal(validateSubmission({ parsed, packageUrl: ' https://dl.example/a.zip ', sha256: SHA.toUpperCase(), notes: '' }), null)
    assert.deepEqual(submitBody({ parsed, packageUrl: ' https://dl.example/a.zip ', sha256: ` ${SHA.toUpperCase()} `, notes: undefined }), {
      manifest: MANIFEST, fileHashes: HASHES, packageUrl: 'https://dl.example/a.zip', sha256: SHA, notes: '',
    })
  })

  it('动作门禁与云端状态机一致：审核归运营以上，签名只有管理员、只签已通过、同 kid 不重签', () => {
    const op = { canReview: true, canSign: false, activeKid: null }
    const adm = { canReview: true, canSign: true, activeKid: 'plg-1' }
    const ro = { canReview: false, canSign: false, activeKid: null }
    const pending = VERSION
    const approved = { ...VERSION, reviewStatus: 'approved' }
    const rejected = { ...VERSION, reviewStatus: 'rejected' }
    const signedNow = { ...approved, signature: SIG }
    const signedOld = { ...approved, signature: { ...SIG, kid: 'plg-0' } }

    assert.deepEqual(actionGate(pending, ro), { approve: { ok: false, reason: '需要运营及以上角色' }, reject: { ok: false, reason: '需要运营及以上角色' }, sign: { ok: false, reason: '只有管理员能用官方密钥签名' } })
    assert.deepEqual([actionGate(pending, op).approve.ok, actionGate(pending, op).reject.ok, actionGate(pending, op).sign.ok], [true, true, false])
    assert.deepEqual([actionGate(approved, op).approve.ok, actionGate(approved, op).approve.reason], [false, '已通过'])
    assert.deepEqual([actionGate(rejected, op).reject.ok, actionGate(rejected, op).reject.reason], [false, '已驳回'])
    assert.equal(actionGate(rejected, op).approve.ok, true, '驳回后可再通过')
    assert.equal(actionGate(approved, adm).sign.ok, true)
    assert.match(actionGate(pending, adm).sign.reason, /已通过审核/)
    assert.match(actionGate(signedNow, adm).sign.reason, /plg-1/)
    assert.equal(actionGate(signedOld, adm).sign.ok, true, '旧密钥签过的可用当前密钥重签')
    assert.match(actionGate(signedNow, { ...adm, activeKid: null }).sign.reason, /密钥信息未加载/)
    assert.equal(actionGate(null, adm).sign.ok, false)
  })

  it('列表行、哈希行、签名清单文本与文件名、JSON 美化', () => {
    const row = versionRow({ ...VERSION, signature: SIG }, 'plg-1')
    assert.deepEqual([row.status.label, row.sign.label, row.fileCount, row.caps, row.hashShort], ['待审核', '已签名 plg-1', 2, 'llm.chat', `${'f'.repeat(16)}…`])
    assert.equal(versionRow({ id: 'x', reviewStatus: 'approved' }).caps, '—')
    assert.deepEqual(fileHashRows(HASHES), [{ path: 'index.js', sha256: HASHES['index.js'] }, { path: 'lib/helper.js', sha256: HASHES['lib/helper.js'] }])
    assert.deepEqual(fileHashRows(null), [])
    assert.equal(signedManifestText(VERSION), null)
    const signed = { ...VERSION, signature: SIG, signedManifest: { ...MANIFEST, signature: SIG } }
    const text = signedManifestText(signed)
    assert.ok(text.endsWith('\n'))
    assert.deepEqual(JSON.parse(text), { ...MANIFEST, signature: SIG })
    assert.equal(manifestFileName(signed), 'manifest.json')
    assert.equal(prettyJson({ a: 1 }), '{\n  "a": 1\n}')
    assert.equal(prettyJson(null), '')
  })

  it('密钥横幅：独立密钥 / 回退许可证密钥 / 退役 kid / 未加载', () => {
    assert.equal(keySummary(null).type, 'info')
    const ded = keySummary({ kid: 'plg-1', dedicated: true, licenceKid: 'lic-1', retiredKids: [] })
    assert.equal(ded.type, 'success')
    assert.match(ded.text, /plg-1/)
    assert.doesNotMatch(ded.text, /退役/)
    const fb = keySummary({ kid: 'lic-1', dedicated: false, licenceKid: 'lic-1', retiredKids: ['plg-0', 'plg-00'] })
    assert.equal(fb.type, 'warning')
    assert.match(fb.text, /暂用许可证密钥/)
    assert.match(fb.text, /PLUGIN_SIGNING_PRIVATE_KEY_PEM/)
    assert.match(fb.text, /退役仍可验签：plg-0、plg-00/)
    assert.equal(keySummary({ kid: 'bad kid!', dedicated: true }).type, 'error')
  })

  it('api 路径、方法与请求体', async () => {
    const { api, calls } = recorder()
    await api.listPlugins()
    await api.listPlugins({ status: 'pending', limit: 50 })
    await api.getPlugin('a/b')
    await api.submitPlugin({ manifest: MANIFEST, fileHashes: HASHES, packageUrl: 'https://x/a.zip', sha256: SHA, notes: '' })
    await api.approvePlugin('v1', '看过')
    await api.rejectPlugin('v1')
    await api.signPlugin('v1', '签')
    await api.pluginSigningKey()
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
      'GET /api/admin/plugins',
      'GET /api/admin/plugins?status=pending&limit=50',
      'GET /api/admin/plugins/a%2Fb',
      'POST /api/admin/plugins',
      'POST /api/admin/plugins/v1/approve',
      'POST /api/admin/plugins/v1/reject',
      'POST /api/admin/plugins/v1/sign',
      'GET /api/admin/plugins/signing-key',
    ])
    assert.deepEqual(calls[3].body.manifest, MANIFEST)
    assert.deepEqual(calls[4].body, { notes: '看过' })
    assert.deepEqual(calls[5].body, { notes: '' })
    assert.deepEqual(calls[6].body, { notes: '签' })
  })

  it('路由元信息、菜单可见性与审计动作文案', () => {
    assert.deepEqual(ROUTE_META.plugins, { title: '插件审核', perm: 'read' })
    const menu = [{ path: '/templates', perm: 'read' }, { path: '/plugins', perm: 'read' }, { path: '/admins', perm: 'admins:manage' }]
    assert.deepEqual(visibleMenu(menu, { permissions: ['read'] }).map((m) => m.path), ['/templates', '/plugins'], '只读角色也能看审核页（动作按钮会禁用）')
    assert.equal(auditActionLabel('POST /admin/plugins'), '登记插件版本')
    assert.equal(auditActionLabel('POST /admin/plugins/:id/approve'), '通过插件审核')
    assert.equal(auditActionLabel('POST /admin/plugins/:id/reject'), '驳回插件版本')
    assert.equal(auditActionLabel('POST /admin/plugins/:id/sign'), '官方签名插件版本')
  })
})
