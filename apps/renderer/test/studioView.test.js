import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ROLE_OPTIONS, STATE_LABEL, canPublish, characterOption, formatBytes, formatDate, identitySummary, invitePayload, itemActions, memberRow,
  normalizeInviteCode, roleLabel, seatSummary, sharedRow, studioOption, validateInvite,
} from '../src/utils/studioView.js'

// P3-S 工作室页纯函数：席位文案、状态条、成员行权限、邀请表单、共享条目按钮状态。
describe('studioView', () => {
  it('seatSummary counts pending invites as occupied and picks a tone', () => {
    assert.deepEqual(seatSummary({ limit: 3, used: 1, pending: 0 }), { text: '1 / 3 席', percent: 33, tone: 'success', available: 2, full: false })
    assert.deepEqual(seatSummary({ limit: 3, used: 2, pending: 1 }), { text: '2 / 3 席（1 份邀请待处理）', percent: 100, tone: 'danger', available: 0, full: true })
    assert.equal(seatSummary({ limit: 5, used: 4, pending: 0 }).tone, 'warning')
    assert.deepEqual(seatSummary(null), { text: '0 / 0 席', percent: 100, tone: 'danger', available: 0, full: true })
  })

  it('identitySummary: login, empty, offline, current studio', () => {
    assert.equal(identitySummary(null, { loggedIn: false }).tone, 'warning')
    assert.equal(identitySummary(null).tone, 'info')
    assert.match(identitySummary({ studios: [] }).text, /没有加入/)
    const id = { studios: [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }], current_studio_id: 'b', online: true }
    assert.deepEqual(identitySummary(id), { tone: 'success', text: '已加入 2 个工作室，当前：乙' })
    const off = identitySummary({ ...id, online: false })
    assert.equal(off.tone, 'warning')
    assert.match(off.text, /离线/)
    assert.equal(studioOption({ id: 'a', name: '甲', my_role: 'owner', seats: { limit: 3, used: 1, pending: 0 }, status: 'suspended' }).label, '甲 · 所有者 · 1 / 3 席 · 已停用')
    assert.equal(roleLabel('admin'), '管理员')
    assert.equal(roleLabel('zzz'), 'zzz')
    assert.equal(canPublish('admin'), true)
    assert.equal(canPublish('member'), false)
    assert.equal(canPublish('owner', 'suspended'), false)
  })

  it('memberRow: owner can remove / re-role anyone but self and owner; admin only members; member only self', () => {
    const owner = { account_id: 'o', email: 'o@x.com', role: 'owner', joined_at: '2026-10-01T00:00:00Z' }
    const admin = { account_id: 'a', email: 'A@x.com', role: 'admin' }
    const member = { account_id: 'm', email: 'm@x.com', role: 'member' }
    const asOwner = (m) => memberRow(m, { myRole: 'owner', myEmail: 'o@x.com' })
    assert.deepEqual([asOwner(owner).canRemove, asOwner(owner).canChangeRole, asOwner(owner).self], [false, false, true])
    assert.deepEqual([asOwner(admin).canRemove, asOwner(admin).canChangeRole], [true, true])
    assert.deepEqual([asOwner(member).canRemove, asOwner(member).canChangeRole], [true, true])
    const asAdmin = (m) => memberRow(m, { myRole: 'admin', myEmail: 'a@x.com' })
    assert.deepEqual([asAdmin(owner).canRemove, asAdmin(admin).canRemove, asAdmin(admin).self, asAdmin(admin).removeLabel, asAdmin(member).canRemove, asAdmin(member).canChangeRole], [false, true, true, '退出', true, false])
    const asMember = (m) => memberRow(m, { myRole: 'member', myEmail: 'm@x.com' })
    assert.deepEqual([asMember(admin).canRemove, asMember(member).canRemove, asMember(member).removeLabel], [false, true, '退出'])
    assert.equal(asOwner(owner).joinedText, formatDate('2026-10-01T00:00:00Z'))
    assert.equal(asOwner(member).joinedText, '—')
  })

  it('invite form validation and payload; invite code normalisation', () => {
    assert.deepEqual(validateInvite({ email: '', role: 'member', expiresInDays: 7 }), {})
    assert.deepEqual(Object.keys(validateInvite({ email: 'nope', role: 'owner', expiresInDays: 0 })).sort(), ['email', 'expiresInDays', 'role'])
    assert.ok(validateInvite({ role: 'member', expiresInDays: 91 }).expiresInDays)
    assert.deepEqual(invitePayload({ email: ' Bob@X.com ', role: 'admin', expiresInDays: '3' }), { email: 'bob@x.com', role: 'admin', expiresInDays: 3 })
    assert.deepEqual(invitePayload({ email: '', role: 'member', expiresInDays: 7 }), { role: 'member', expiresInDays: 7 })
    assert.equal(normalizeInviteCode(' ab-cd 23 '), 'ABCD23')
    assert.equal(ROLE_OPTIONS.length, 2)
  })

  it('itemActions / sharedRow: pull needs a drama for characters; update, republish, nothing for members', () => {
    const base = { shared_id: 'c-1', kind: 'character', name: '甲', version: 2, author: { email: 'me@x.com' }, updated_at: '2026-10-02T01:02:00Z', file_count: 3, total_size: 2048, fields: { role: '女主', description: '咖啡师' } }
    const np = itemActions({ ...base, state: 'not_pulled' })
    assert.deepEqual([np.label, np.needsDrama, np.actions.map((a) => a.key)], ['未拉取', true, ['pull']])
    assert.equal(itemActions({ ...base, kind: 'template', state: 'not_pulled' }).needsDrama, false)
    assert.equal(itemActions({ ...base, kind: 'template', state: 'not_pulled' }).actions[0].label, '安装到本机')
    assert.deepEqual(itemActions({ ...base, state: 'update_available' }).actions.map((a) => a.key), ['update'])
    assert.deepEqual(itemActions({ ...base, state: 'pulled' }).actions, [])
    assert.deepEqual(itemActions({ ...base, state: 'mine', published_local_id: '7' }).actions, [], '非写者没有重新发布')
    assert.deepEqual(itemActions({ ...base, state: 'mine', published_local_id: '7' }, { canPublish: true }).actions.map((a) => a.key), ['republish'])
    assert.equal(itemActions({ ...base, state: 'mine_outdated', published_local_id: '7' }, { canPublish: true }).actions[0].label, '覆盖远端')
    assert.equal(itemActions({ ...base, state: 'weird' }).label, STATE_LABEL.not_pulled.label)
    const row = sharedRow({ ...base, state: 'update_available' })
    assert.equal(row.stateLabel, '有更新')
    assert.equal(row.subtitle, '女主 · 咖啡师')
    assert.deepEqual(row.meta, ['v2', 'me@x.com', formatDate('2026-10-02T01:02:00Z'), '3 张图 · 2.0 KB'])
    const tpl = sharedRow({ ...base, kind: 'template', state: 'pulled', fields: { template_version: '1.0.0', genre: 'guofeng' }, author: null })
    assert.equal(tpl.subtitle, '模板版本 1.0.0 · guofeng')
    assert.equal(tpl.meta[1], '匿名')
  })

  it('characterOption flags characters without a local image; formatting helpers', () => {
    assert.deepEqual(characterOption({ id: 1, name: '甲', role: '女主', local_path: 'x.png' }), { value: 1, label: '甲 · 女主', hasImage: true })
    assert.deepEqual(characterOption({ id: 2, name: '', image_url: 'https://remote/x.png' }), { value: 2, label: '（未命名）（无本机图片）', hasImage: false })
    assert.equal(characterOption({ id: 3, name: '乙', image_url: '/static/a.png' }).hasImage, true)
    assert.equal(formatBytes(0), '0 B')
    assert.equal(formatBytes(1536), '1.5 KB')
    assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB')
    assert.equal(formatBytes(-1), '—')
    assert.equal(formatDate(''), '—')
    assert.equal(formatDate('garbage'), 'garbage')
    assert.match(formatDate('2026-10-02T01:02:00Z'), /^2026-10-0\d \d\d:\d\d$/)
  })
})
