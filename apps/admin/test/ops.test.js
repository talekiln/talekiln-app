import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createApi, errorText, ApiError, qs } from '../src/api.js'
import { ROLE_OPTIONS, can, denyRedirect, roleLabel, visibleMenu } from '../src/permissions.js'
import { ROUTE_META } from '../src/route-meta.js'
import {
  ANNOUNCE_CHANNELS, announcementBody, announcementState, auditActionLabel, auditSummary, buildVersionBody, centsToYuan,
  compareSemver, describeEntitlements, formatMoney, formatPercent, funnelRows, isSemver, latestVersion, refundBlockReason,
  releaseBody, releaseState, statusTag, ORDER_STATUS, validateAnnouncement, validateGrant, validateRelease, versionToForm, yuanToCents,
} from '../src/ops.js'

function recorder(body = {}) {
  const calls = []
  const f = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined })
    return { ok: true, status: 200, json: async () => body }
  }
  return { api: createApi({ fetchImpl: f }), calls }
}

describe('金额', () => {
  it('分 -> 元文字', () => {
    assert.equal(formatMoney(3900), '¥39.00')
    assert.equal(formatMoney(5), '¥0.05')
    assert.equal(formatMoney(29900), '¥299.00')
    assert.equal(formatMoney(-250), '-¥2.50')
    assert.equal(formatMoney(null), '—')
    assert.equal(formatMoney(undefined), '—')
    assert.equal(formatMoney('x'), '—')
  })
  it('元输入 -> 整数分，不经浮点乘法', () => {
    assert.equal(yuanToCents('39'), 3900)
    assert.equal(yuanToCents('39.9'), 3990)
    assert.equal(yuanToCents('0.01'), 1)
    assert.equal(yuanToCents('1.15'), 115) // 1.15 * 100 在浮点下是 114.99999999999999
    assert.equal(yuanToCents(' 299.00 '), 29900)
    for (const bad of ['', 'abc', '-1', '1.234', '1,5', '.5', '1.', null, undefined, '99999999.99x']) assert.equal(yuanToCents(bad), null, String(bad))
    assert.equal(centsToYuan(3900), '39')
    assert.equal(centsToYuan(3990), '39.90')
    assert.equal(centsToYuan(null), '')
  })
})

describe('订单与退款', () => {
  it('状态标签有兜底', () => {
    assert.equal(statusTag(ORDER_STATUS, 'PAID').label, '已支付')
    assert.deepEqual(statusTag(ORDER_STATUS, 'WEIRD'), { label: 'WEIRD', type: 'info' })
  })
  it('退款是否可用及原因', () => {
    const ok = { order: { status: 'PAID' }, invoice: null, refundQuote: { refundCents: 2641 } }
    assert.equal(refundBlockReason(ok), null)
    assert.match(refundBlockReason({ ...ok, order: { status: 'PENDING' } }), /待支付/)
    assert.match(refundBlockReason({ ...ok, order: { status: 'REFUNDED' } }), /已退款/)
    assert.match(refundBlockReason({ ...ok, invoice: { status: 'ISSUED' } }), /先作废发票/)
    assert.equal(refundBlockReason({ ...ok, invoice: { status: 'VOID' } }), null)
    assert.match(refundBlockReason({ ...ok, refundQuote: { refundCents: 0 } }), /到期/)
    assert.match(refundBlockReason({ ...ok, refundQuote: null }), /到期/)
    assert.match(refundBlockReason(null), /不存在/)
  })
})

describe('推广漏斗', () => {
  it('百分比与行数据', () => {
    assert.equal(formatPercent(0.25), '25.0%')
    assert.equal(formatPercent(0.3333), '33.3%')
    assert.equal(formatPercent(null), '—')
    const rows = funnelRows([
      { key: 'clicks', count: 200, rateFromPrev: null, rateFromFirst: null },
      { key: 'registered', count: 50, rateFromPrev: 0.25, rateFromFirst: 0.25 },
      { key: 'activated', count: 0, rateFromPrev: 0, rateFromFirst: 0 },
      { key: 'firstExport', count: 10, rateFromPrev: null, rateFromFirst: 0.05 },
    ])
    assert.deepEqual(rows.map((r) => r.label), ['推广点击', '注册账号', '已激活（登记设备）', '首次导出'])
    assert.deepEqual(rows.map((r) => r.width), [100, 25, 0, 5])
    assert.equal(rows[0].fromPrev, '—')
    assert.equal(rows[1].fromPrev, '25.0%')
    assert.equal(rows[3].fromFirst, '5.0%')
    assert.deepEqual(funnelRows([{ key: 'clicks', count: 0, rateFromPrev: null, rateFromFirst: null }])[0].width, 0)
    assert.deepEqual(funnelRows(undefined), [])
  })
})

describe('套餐与价格版本', () => {
  const pro = { plan: { code: 'pro' }, versions: [{ version: 1 }, { version: 2, priceMonthCents: 3900 }] }
  it('取最新版本与权益描述', () => {
    assert.equal(latestVersion(pro).version, 2)
    assert.equal(latestVersion({ versions: [] }), null)
    assert.equal(latestVersion(null), null)
    assert.equal(describeEntitlements({ maxDevices: 3, exportMaxHeight: 2160, watermark: false }), '3 台设备 · 导出最高 2160p · 无水印')
  })
  it('表单 <-> 请求体', () => {
    const form = { priceMonth: '39', priceYear: '299.5', maxDevices: 3, exportMaxHeight: 2160, watermark: false, features: ['export'] }
    assert.deepEqual(buildVersionBody(form).body, {
      priceMonthCents: 3900, priceYearCents: 29950,
      entitlements: { maxDevices: 3, exportMaxHeight: 2160, watermark: false, features: ['export'] },
    })
    assert.equal(buildVersionBody({ ...form, priceMonth: '', priceYear: null }).body.priceMonthCents, null, '留空 = 不可购买')
    assert.match(buildVersionBody({ ...form, priceMonth: '0' }).error, /月付/)
    assert.match(buildVersionBody({ ...form, priceYear: '1.234' }).error, /年付/)
    assert.match(buildVersionBody({ ...form, maxDevices: 0 }).error, /设备数/)
    assert.match(buildVersionBody({ ...form, exportMaxHeight: 100 }).error, /导出/)
    const back = versionToForm({ priceMonthCents: 3900, priceYearCents: null, entitlements: { maxDevices: 3, exportMaxHeight: 2160, watermark: false, features: ['a'] } })
    assert.deepEqual(back, { priceMonth: '39', priceYear: '', maxDevices: 3, exportMaxHeight: 2160, watermark: false, features: ['a'] })
    assert.equal(versionToForm(null).watermark, true)
  })
})

describe('版本灰度', () => {
  it('语义化版本校验与比较与云端一致', () => {
    for (const ok of ['1.2.3', '0.0.1', '1.3.0-beta.1', '1.0.0+b']) assert.ok(isSemver(ok), ok)
    for (const bad of ['1.2', 'v1.2.3', '01.2.3', '', null, '1.2.3-']) assert.equal(isSemver(bad), false, String(bad))
    const order = ['0.9.9', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.10.0', '2.0.0']
    for (let i = 0; i < order.length; i++) for (let j = 0; j < order.length; j++) assert.equal(Math.sign(compareSemver(order[i], order[j])), Math.sign(i - j))
  })
  it('表单校验与请求体', () => {
    const ok = { version: '1.2.0', channel: 'stable', rolloutPercent: 10, minVersion: '1.0.0', notes: '' }
    assert.equal(validateRelease(ok), null)
    assert.match(validateRelease({ ...ok, version: '1.2' }), /语义化/)
    assert.match(validateRelease({ ...ok, channel: 'x' }), /通道/)
    assert.match(validateRelease({ ...ok, rolloutPercent: 101 }), /0–100/)
    assert.match(validateRelease({ ...ok, rolloutPercent: 1.5 }), /0–100/)
    assert.match(validateRelease({ ...ok, minVersion: '9.0.0' }), /不能高于/)
    assert.match(validateRelease({ ...ok, minVersion: 'zz' }), /最低版本/)
    assert.equal(validateRelease({ ...ok, minVersion: '' }), null)
    assert.deepEqual(releaseBody({ ...ok, minVersion: '', rolloutPercent: '25', forced: 1 }), {
      version: '1.2.0', channel: 'stable', rolloutPercent: 25, minVersion: null, forced: true, notes: '', enabled: true,
    })
  })
  it('发布状态', () => {
    assert.equal(releaseState({ enabled: false, rolloutPercent: 100 }).label, '已暂停')
    assert.equal(releaseState({ enabled: true, rolloutPercent: 0 }).label, '未开始（0%）')
    assert.equal(releaseState({ enabled: true, rolloutPercent: 30 }).label, '灰度 30%')
    assert.equal(releaseState({ enabled: true, rolloutPercent: 100 }).type, 'success')
  })
})

describe('公告', () => {
  const now = new Date('2026-10-01T12:00:00Z')
  it('状态按时间窗判断', () => {
    const a = { enabled: true, startsAt: '2026-10-01T00:00:00Z', endsAt: null }
    assert.equal(announcementState(a, now).label, '生效中')
    assert.equal(announcementState({ ...a, enabled: false }, now).label, '已停用')
    assert.equal(announcementState({ ...a, startsAt: '2026-10-02T00:00:00Z' }, now).label, '未开始')
    assert.equal(announcementState({ ...a, endsAt: '2026-10-01T12:00:00Z' }, now).label, '已结束')
    assert.equal(announcementState({ ...a, endsAt: '2026-10-01T12:00:01Z' }, now).label, '生效中')
  })
  it('校验与请求体', () => {
    const f = { title: ' 维护 ', body: '', level: 'warn', channel: 'beta', startsAt: new Date('2026-10-01T00:00:00Z'), endsAt: null, enabled: true }
    assert.equal(validateAnnouncement(f), null)
    assert.match(validateAnnouncement({ ...f, title: ' ' }), /标题/)
    assert.match(validateAnnouncement({ ...f, title: 'x'.repeat(101) }), /100/)
    assert.match(validateAnnouncement({ ...f, body: 'x'.repeat(2001) }), /2000/)
    assert.match(validateAnnouncement({ ...f, startsAt: null }), /生效时间/)
    assert.match(validateAnnouncement({ ...f, startsAt: 'bad' }), /不合法/)
    assert.match(validateAnnouncement({ ...f, endsAt: new Date('2026-09-30T00:00:00Z') }), /晚于/)
    assert.deepEqual(announcementBody(f), {
      title: '维护', body: '', level: 'warn', channel: 'beta', startsAt: '2026-10-01T00:00:00.000Z', endsAt: null, enabled: true,
    })
    assert.deepEqual(ANNOUNCE_CHANNELS.map((c) => c.value), ['all', 'stable', 'beta'])
  })
})

describe('权限显示', () => {
  const admin = { permissions: ['read', 'ops:write', 'feedback:diagnostic', 'billing:refund', 'billing:plans', 'admins:manage', 'audit:read'] }
  const op = { permissions: ['read', 'ops:write', 'feedback:diagnostic'] }
  const ro = { permissions: ['read'] }
  it('can：无 perm 要求都可见；缺权限或未登录不可见', () => {
    assert.equal(can(ro, undefined), true)
    assert.equal(can(ro, 'read'), true)
    assert.equal(can(ro, 'ops:write'), false)
    assert.equal(can(op, 'billing:refund'), false)
    assert.equal(can(admin, 'billing:refund'), true)
    assert.equal(can(null, 'read'), false)
    assert.equal(can({}, 'read'), false)
  })
  it('菜单按角色过滤', () => {
    const menu = [{ path: '/a', perm: 'read' }, { path: '/admins', perm: 'admins:manage' }, { path: '/free' }]
    assert.deepEqual(visibleMenu(menu, admin).map((m) => m.path), ['/a', '/admins', '/free'])
    assert.deepEqual(visibleMenu(menu, op).map((m) => m.path), ['/a', '/free'])
    assert.deepEqual(visibleMenu(menu, null).map((m) => m.path), ['/free'])
  })
  it('路由守卫：无权限跳回概览', () => {
    assert.equal(denyRedirect(ro, { perm: 'admins:manage' }), '/overview')
    assert.equal(denyRedirect(admin, { perm: 'admins:manage' }), null)
    assert.equal(denyRedirect(ro, {}), null)
    assert.equal(denyRedirect(ro, undefined), null)
  })
  it('路由表里“管理员与审计”需要 admins:manage，其余页面需要 read', () => {
    assert.equal(ROUTE_META.admins.perm, 'admins:manage')
    for (const n of ['overview', 'orders', 'refunds', 'plans', 'releases', 'announcements', 'invites', 'users', 'content']) assert.equal(ROUTE_META[n].perm, 'read', n)
    assert.equal(ROUTE_META.login.public, true)
    assert.ok(Object.values(ROUTE_META).filter((m) => !m.public).every((m) => m.title && m.perm), '每个后台页面都有标题和权限声明')
  })
  it('角色名与选项', () => {
    assert.equal(roleLabel('OPERATOR'), '运营')
    assert.equal(roleLabel('X'), 'X')
    assert.equal(roleLabel(null), '—')
    assert.deepEqual(ROLE_OPTIONS.map((r) => r.value), ['ADMIN', 'OPERATOR', 'READONLY'])
  })
  it('授予表单校验', () => {
    assert.equal(validateGrant({ email: 'a@x.com', role: 'OPERATOR', password: '' }), null)
    assert.equal(validateGrant({ email: 'a@x.com', role: 'OPERATOR', password: 'x'.repeat(12) }), null)
    assert.match(validateGrant({ email: 'bad', role: 'OPERATOR' }), /邮箱/)
    assert.match(validateGrant({ email: 'a@x.com', role: '' }), /角色/)
    assert.match(validateGrant({ email: 'a@x.com', role: 'OPERATOR', password: 'short' }), /12/)
  })
})

describe('审计显示', () => {
  it('动作中文名与回退', () => {
    assert.equal(auditActionLabel('POST /admin/orders/:id/refund'), '订单退款')
    assert.equal(auditActionLabel('POST /admin/auth/login'), '登录后台')
    assert.equal(auditActionLabel('POST /admin/unknown'), 'POST /admin/unknown')
    assert.equal(auditActionLabel(''), '—')
  })
  it('摘要：对象缩写 + 请求字段，复杂值省略，过长标注', () => {
    assert.equal(auditSummary({ targetType: 'orders', targetId: '12345678-aaaa', detail: { body: { reason: '用户申请', nested: { a: 1 }, long: 'x'.repeat(50) } } }),
      'orders/12345678  reason=用户申请 nested=… long=' + 'x'.repeat(24))
    assert.equal(auditSummary({ targetType: 'invites', targetId: null, detail: null }), 'invites')
    assert.equal(auditSummary({ detail: { truncated: true } }), '（内容过长已省略）')
    assert.equal(auditSummary({}), '—')
  })
})

describe('api 新接口', () => {
  it('qs 跳过空值并转义', () => {
    assert.equal(qs({ a: 1, b: '', c: undefined, d: null, e: 'x y' }), '?a=1&e=x%20y')
    assert.equal(qs({}), '')
    assert.equal(qs(undefined), '')
  })
  it('路径、方法与请求体', async () => {
    const { api, calls } = recorder()
    await api.funnel(30)
    await api.listOrders({ status: 'PAID', limit: 200 })
    await api.getOrder('a/b')
    await api.refundOrder('o1', '用户申请')
    await api.refundOrder('o1')
    await api.issueInvoice('i1', 'FP001')
    await api.voidInvoice('i1')
    await api.addPlanVersion('pro', { priceMonthCents: 4900 })
    await api.setPlanEnabled('pro', false)
    await api.createRelease({ version: '1.0.0' })
    await api.updateRelease('r1', { rolloutPercent: 50 })
    await api.createAnnouncement({ title: 't' })
    await api.updateAnnouncement('a1', { enabled: false })
    await api.deleteAnnouncement('a1')
    await api.grantAdmin({ email: 'a@x.com', role: 'OPERATOR' })
    await api.setAdminRole('u1', 'READONLY')
    await api.removeAdmin('u1')
    await api.listAudit({ action: 'POST /admin/admins', limit: 50 })
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
      'GET /api/admin/stats/funnel?days=30',
      'GET /api/admin/orders?status=PAID&limit=200',
      'GET /api/admin/orders/a%2Fb',
      'POST /api/admin/orders/o1/refund',
      'POST /api/admin/orders/o1/refund',
      'POST /api/admin/invoices/i1/issue',
      'POST /api/admin/invoices/i1/void',
      'POST /api/admin/plans/pro/versions',
      'PUT /api/admin/plans/pro/enabled',
      'POST /api/admin/releases',
      'PUT /api/admin/releases/r1',
      'POST /api/admin/announcements',
      'PUT /api/admin/announcements/a1',
      'DELETE /api/admin/announcements/a1',
      'POST /api/admin/admins',
      'PUT /api/admin/admins/u1/role',
      'DELETE /api/admin/admins/u1',
      'GET /api/admin/audit?action=POST%20%2Fadmin%2Fadmins&limit=50',
    ])
    assert.deepEqual(calls[3].body, { reason: '用户申请' })
    assert.deepEqual(calls[4].body, {})
    assert.deepEqual(calls[5].body, { invoiceNo: 'FP001' })
    assert.deepEqual(calls[8].body, { enabled: false })
    assert.deepEqual(calls[15].body, { role: 'READONLY' })
  })
  it('冲突与授权错误的文案', () => {
    assert.equal(errorText(new ApiError(409, 'conflict', '必须至少保留一个可用的 ADMIN')), '必须至少保留一个可用的 ADMIN')
    assert.equal(errorText(new ApiError(409, 'conflict')), '操作与当前状态冲突')
    assert.equal(errorText(new ApiError(403, 'forbidden', '需要权限 billing:refund')), '没有权限执行该操作')
  })
})
