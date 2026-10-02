import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ApiError, auth, createApi, errorText } from '../src/api.js'
import { barPercent, formatBytes, formatTime, invitesToCsv, newId, validateCatalog } from '../src/format.js'

function fakeFetch(responses) {
  const calls = []
  const f = async (url, init) => {
    calls.push({ url, init })
    const r = responses.shift()
    return {
      ok: r.status < 400,
      status: r.status,
      json: async () => r.body,
      blob: async () => r.blob,
    }
  }
  return { f, calls }
}

describe('api 客户端', () => {
  it('带上令牌与 JSON 体；204 返回 null', async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: [1] }, { status: 204 }])
    const api = createApi({ base: '/api', fetchImpl: f, getToken: () => 'tok' })
    assert.deepEqual(await api.createInvites({ count: 2 }), [1])
    assert.equal(calls[0].url, '/api/admin/invites')
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].init.headers.authorization, 'Bearer tok')
    assert.equal(JSON.parse(calls[0].init.body).count, 2)
    assert.equal(await api.revokeInvite('a/b'), null)
    assert.equal(calls[1].url, '/api/admin/invites/a%2Fb/revoke')
  })

  it('未登录时不发送 authorization；登录接口 401 不触发登出回调', async () => {
    let out = 0
    const { f, calls } = fakeFetch([{ status: 401, body: { error: 'invalid_credentials' } }])
    const api = createApi({ fetchImpl: f, onUnauthorized: () => out++ })
    await assert.rejects(api.login('a@x.com', 'bad'), (e) => e instanceof ApiError && e.code === 'invalid_credentials')
    assert.equal(calls[0].init.headers.authorization, undefined)
    assert.equal(out, 0)
  })

  it('其它接口 401 触发登出回调；网络错误映射为 network', async () => {
    let out = 0
    const { f } = fakeFetch([{ status: 401, body: { error: 'invalid_token' } }])
    const api = createApi({ fetchImpl: f, getToken: () => 't', onUnauthorized: () => out++ })
    await assert.rejects(api.listUsers())
    assert.equal(out, 1)
    const down = createApi({ fetchImpl: async () => { throw new TypeError('fetch failed') } })
    await assert.rejects(down.listUsers(), (e) => e.code === 'network')
  })

  it('启用/禁用、状态筛选走正确的路径；诊断包返回 blob', async () => {
    const blob = { size: 1 }
    const { f, calls } = fakeFetch([{ status: 204 }, { status: 204 }, { status: 200, body: [] }, { status: 200, blob }])
    const api = createApi({ fetchImpl: f })
    await api.setUserDisabled('u1', true)
    await api.setUserDisabled('u1', false)
    await api.listInvites('used')
    assert.equal(await api.downloadDiagnostic('f1'), blob)
    assert.deepEqual(calls.map((c) => c.url), [
      '/api/admin/users/u1/disable', '/api/admin/users/u1/enable', '/api/admin/invites?status=used', '/api/admin/feedback/f1/diagnostic',
    ])
  })

  it('错误文案为中文，未知错误码回退到服务端消息', () => {
    assert.equal(errorText(new ApiError(401, 'invalid_credentials')), '邮箱或密码错误')
    assert.equal(errorText(new ApiError(429, 'rate_limited')), '操作过于频繁，请稍后再试')
    assert.equal(errorText(new ApiError(400, 'bad_request', 'count 需在 1..200')), 'count 需在 1..200')
    assert.equal(errorText(new ApiError(500, 'weird', 'boom')), 'boom')
  })

  it('令牌存取在无 sessionStorage 的环境退化为内存', () => {
    auth.set('abc')
    assert.equal(auth.get(), 'abc')
    auth.clear()
    assert.equal(auth.get(), null)
  })
})

describe('format', () => {
  it('邀请码 CSV：带 BOM、转义引号、永不过期', () => {
    const csv = invitesToCsv([{ code: 'AB"C', plan: 'test', expiresAt: null }])
    assert.ok(csv.startsWith('﻿'))
    assert.match(csv, /"AB""C","test","永不过期"/)
  })

  it('时间、字节、柱宽', () => {
    assert.equal(formatTime(null), '—')
    assert.equal(formatTime('nope'), '—')
    assert.match(formatTime('2026-10-01T08:05:00Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    assert.equal(formatBytes(0), '—')
    assert.equal(formatBytes(2048), '2.0 KB')
    assert.equal(barPercent(5, 10), 50)
    assert.equal(barPercent(5, 0), 0)
    assert.equal(barPercent(50, 10), 100)
  })

  it('目录与公告的本地校验', () => {
    const ok = { id: 'a', kind: 'text', provider: 'p', name: 'n', price: 1, unit: 'u', enabled: true }
    assert.equal(validateCatalog([ok]), null)
    assert.match(validateCatalog([{ ...ok, price: -1 }]), /价格/)
    assert.match(validateCatalog([{ ...ok, name: ' ' }]), /名称/)
    assert.match(validateCatalog([ok, ok]), /重复/)
    assert.match(validateCatalog([{ ...ok, price: Number.NaN }]), /价格/)
    assert.notEqual(newId('a'), newId('a'))
  })
})
