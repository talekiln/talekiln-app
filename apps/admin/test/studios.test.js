import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createApi } from '../src/api.js'
import { ROUTE_META } from '../src/route-meta.js'
import { auditActionLabel } from '../src/ops.js'
import {
  MAX_SEATS, SEAT_PRICING_NOTE, STATUS_OPTIONS, inviteRow, memberRow, roleLabel, seatBody, seatTag, seatText, statusTag, studioRow, validateSeatLimit,
} from '../src/studios.js'

function recorder(body = []) {
  const calls = []
  const f = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined })
    return { ok: true, status: 200, json: async () => body }
  }
  return { api: createApi({ fetchImpl: f }), calls }
}

describe('工作室后台', () => {
  it('席位文案与标签：待处理邀请算占用；满 danger、≥80% warning', () => {
    assert.equal(seatText({ used: 2, limit: 3, pending: 0 }), '2 / 3')
    assert.equal(seatText({ used: 2, limit: 3, pending: 1 }), '2 / 3（1 份待处理邀请）')
    assert.equal(seatText(null), '0 / 0')
    assert.deepEqual(seatTag({ used: 1, limit: 3, pending: 0 }), { label: '1 / 3', type: 'success' })
    assert.equal(seatTag({ used: 4, limit: 5, pending: 0 }).type, 'warning')
    assert.equal(seatTag({ used: 2, limit: 3, pending: 1 }).type, 'danger')
    assert.equal(seatTag({ used: 0, limit: 0 }).type, 'danger')
    assert.deepEqual(statusTag('suspended'), { label: '已停用', type: 'danger' })
    assert.deepEqual(statusTag('active'), { label: '正常', type: 'success' })
    assert.equal(STATUS_OPTIONS.length, 2)
    assert.equal(roleLabel('owner'), '所有者')
    assert.match(SEAT_PRICING_NOTE, /定价待定/)
  })

  it('席位数校验与请求体：整数、上限、不低于成员数', () => {
    assert.match(validateSeatLimit('x', { used: 0 }), /整数/)
    assert.match(validateSeatLimit(-1, { used: 0 }), /整数/)
    assert.match(validateSeatLimit(MAX_SEATS + 1, { used: 0 }), /超过/)
    assert.match(validateSeatLimit(1, { used: 2 }), /不能低于当前成员数（2）/)
    assert.equal(validateSeatLimit('3', { used: 2 }), null)
    assert.equal(validateSeatLimit(0, null), null)
    assert.deepEqual(seatBody('5'), { seatLimit: 5 })
  })

  it('列表行与详情行', () => {
    const r = studioRow({ id: 's1', name: '甲', ownerId: 'o', owner_email: 'o@x.com', seatLimit: 3, status: 'active', seats: { used: 1, limit: 3, pending: 0 } })
    assert.equal(r.seatLabel, '1 / 3')
    assert.equal(r.ownerText, 'o@x.com')
    assert.equal(r.statusTag.label, '正常')
    assert.equal(studioRow({ ownerId: 'o', seats: {} }).ownerText, 'o')
    assert.deepEqual(memberRow({ role: 'admin', status: 'removed' }).statusLabel, '已移除')
    assert.deepEqual([memberRow({ role: 'member', status: 'active' }).statusLabel, memberRow({ role: 'member', status: 'active' }).removed], ['在席', false])
    assert.equal(inviteRow({ role: 'member', used_at: '2026-10-01T00:00:00Z' }).state, '已接受')
    assert.equal(inviteRow({ role: 'member', revoked_at: '2026-10-01T00:00:00Z' }).state, '已撤销')
    assert.equal(inviteRow({ role: 'member', open: false }).state, '已过期')
    assert.deepEqual([inviteRow({ role: 'admin', open: true }).state, inviteRow({ role: 'admin', open: true }).target], ['待处理', '任何人'])
    assert.equal(inviteRow({ role: 'admin', email: 'a@x.com', open: true }).target, 'a@x.com')
  })

  it('API 封装打到正确路径；路由元信息与审计文案', async () => {
    const { api, calls } = recorder()
    await api.listStudios()
    await api.getStudio('s1')
    await api.setStudioSeats('s1', { seatLimit: 4 })
    await api.setStudioStatus('s1', 'suspended')
    assert.deepEqual(calls.map((c) => [c.method, c.url.replace(/^.*\/api/, '/api'), c.body]), [
      ['GET', '/api/admin/studios', undefined],
      ['GET', '/api/admin/studios/s1', undefined],
      ['PUT', '/api/admin/studios/s1/seats', { seatLimit: 4 }],
      ['PUT', '/api/admin/studios/s1/status', { status: 'suspended' }],
    ])
    assert.deepEqual(ROUTE_META.studios, { title: '工作室', perm: 'read' })
    assert.equal(auditActionLabel('PUT /admin/studios/:id/seats'), '调整工作室席位数')
    assert.equal(auditActionLabel('POST /studios/:id/invites'), '工作室邀请成员')
  })
})
