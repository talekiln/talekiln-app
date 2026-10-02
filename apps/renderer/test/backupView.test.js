import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTO_OPTIONS, DEFAULT_FORM, checkEndpoint, formFromSettings, formatBytes, formatDate, groupSnapshots, runRow, settingsPayload,
  snapshotLabel, statusSummary, validateForm,
} from '../src/utils/backupView.js'

const settings = { endpoint: 'https://s3.example.com', region: 'cn-hangzhou', bucket: 'tk-backup', prefix: 'studio', access_key: 'AK', auto: 'daily', keep: 7, path_style: false, has_secret: true, configured: true }

describe('backupView', () => {
  it('endpoint policy mirrors the local service: https anywhere, http only loopback / RFC1918', () => {
    assert.deepEqual(checkEndpoint('https://s3.example.com'), { ok: true, insecure: false, message: '' })
    for (const ok of ['http://localhost:9000', 'http://127.0.0.1:9000', 'http://10.1.2.3:9000', 'http://172.16.0.1', 'http://172.31.9.9', 'http://192.168.1.10:9000', 'http://[::1]:9000']) {
      const r = checkEndpoint(ok)
      assert.equal(r.ok, true, ok)
      assert.equal(r.insecure, true, ok)
      assert.match(r.message, /未加密/)
    }
    for (const bad of ['http://8.8.8.8', 'http://s3.example.com', 'http://172.32.0.1', 'ftp://10.0.0.1', 'https://u:p@s3.example.com', 'https://s3.example.com/?a=1', '', 'nope']) {
      assert.equal(checkEndpoint(bad).ok, false, bad)
    }
    assert.match(checkEndpoint('http://8.8.8.8').message, /https/)
    assert.match(checkEndpoint('').message, /请填写/)
  })

  it('formFromSettings never carries the secret and falls back to defaults', () => {
    const f = formFromSettings(settings)
    assert.equal(f.secret_key, '')
    assert.equal(f.region, 'cn-hangzhou')
    assert.equal(f.path_style, false)
    assert.equal(f.keep, 7)
    assert.equal(f.auto, 'daily')
    const d = formFromSettings(null)
    assert.deepEqual(d, { ...DEFAULT_FORM })
    assert.equal(formFromSettings({ auto: 'hourly', keep: 'x' }).auto, 'off')
    assert.equal(formFromSettings({ auto: 'hourly', keep: 'x' }).keep, 10)
    assert.equal(AUTO_OPTIONS.map((o) => o.value).join(','), 'off,daily,after_export')
  })

  it('validateForm flags each field; secret may be blank only when one is saved', () => {
    const good = { ...formFromSettings(settings), secret_key: 'sk' }
    assert.deepEqual(validateForm(good), {})
    assert.deepEqual(validateForm({ ...good, secret_key: '' }), { secret_key: '请填写 Secret Key' })
    assert.deepEqual(validateForm({ ...good, secret_key: '' }, { hasSecret: true }), {})
    const bad = validateForm({ endpoint: 'http://example.com', region: 'bad region', bucket: 'B', prefix: '../x', access_key: 'a b', secret_key: '', auto: 'never', keep: 999 })
    assert.deepEqual(Object.keys(bad).sort(), ['access_key', 'auto', 'bucket', 'endpoint', 'keep', 'prefix', 'region', 'secret_key'])
    assert.equal(validateForm({ ...good, bucket: '' }).bucket, '请填写存储桶名称')
    assert.equal(validateForm({ ...good, access_key: '' }).access_key, '请填写 Access Key')
    assert.equal(validateForm({ ...good, keep: 0 }).keep, undefined)
    assert.equal(validateForm({ ...good, prefix: '' }).prefix, undefined)
  })

  it('settingsPayload trims, normalises the prefix and omits a blank secret', () => {
    const p = settingsPayload({ endpoint: ' https://s3.example.com/ ', region: '', bucket: ' tk ', prefix: '/a/b/', access_key: ' AK ', secret_key: '  ', auto: 'off', keep: '3', path_style: 'yes' })
    assert.deepEqual(p, { endpoint: 'https://s3.example.com/', region: 'us-east-1', bucket: 'tk', prefix: 'a/b', access_key: 'AK', auto: 'off', keep: 3, path_style: true })
    assert.equal('secret_key' in p, false)
    assert.equal(settingsPayload({ secret_key: ' s3cr3t ' }).secret_key, 's3cr3t')
    assert.equal(settingsPayload({ prefix: '' }).prefix, 'talekiln')
    assert.equal(settingsPayload({ path_style: false }).path_style, false)
  })

  it('formats bytes and dates', () => {
    assert.equal(formatBytes(512), '512 B')
    assert.equal(formatBytes(2048), '2.0 KB')
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
    assert.equal(formatBytes(3 * 1024 ** 3), '3.00 GB')
    assert.equal(formatBytes(null), '—')
    assert.equal(formatBytes(-1), '—')
    assert.equal(formatDate(null), '—')
    assert.equal(formatDate('garbage', '?'), '?')
    assert.match(formatDate('2026-10-02T03:04:05.000Z'), /^2026-\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it('runRow translates kind / trigger / status', () => {
    const r = runRow({ id: 3, drama_id: 9, kind: 'backup', trigger: 'after_export', title: null, size: 1500, status: 'done', started_at: '2026-10-02T03:04:05.000Z', finished_at: '2026-10-02T03:04:09.000Z', key: 'k', error: null })
    assert.deepEqual([r.kind, r.trigger, r.title, r.status_label, r.tag, r.size, r.error], ['备份', '导出后', '项目 #9', '成功', 'success', '1.5 KB', ''])
    const f = runRow({ id: 4, kind: 'restore', trigger: 'manual', title: '雨夜', status: 'failed', error: '炸了' })
    assert.deepEqual([f.kind, f.trigger, f.title, f.status_label, f.tag, f.error, f.size, f.started], ['恢复', '手动', '雨夜', '失败', 'danger', '炸了', '—', '—'])
    assert.equal(runRow({ status: 'weird', trigger: 'x' }).trigger, 'x')
    assert.equal(runRow(null).status_label, '—')
  })

  it('groupSnapshots groups by drama, newest first, marks missing projects and verifiability', () => {
    const snaps = [
      { key: 'p/dramas/1/2026-10-01T00-00-00.000Z.zip', drama_id: 1, created_at: '2026-10-01T00:00:00.000Z', size: 10, sha256: 'a'.repeat(64), manifest: true, title: '旧名' },
      { key: 'p/dramas/1/2026-10-02T00-00-00.000Z.zip', drama_id: 1, created_at: '2026-10-02T00:00:00.000Z', size: 20, sha256: 'b'.repeat(64), manifest: true },
      { key: 'p/dramas/5/2026-10-03T00-00-00.000Z.zip', drama_id: 5, created_at: '2026-10-03T00:00:00.000Z', size: 30, sha256: null, manifest: false, title: '别处来的' },
      { nope: true }, null,
    ]
    const g = groupSnapshots(snaps, [{ id: 1, title: '雨夜' }])
    assert.deepEqual(g.map((x) => [x.drama_id, x.title, x.exists, x.snapshots.length]), [[5, '别处来的', false, 1], [1, '雨夜', true, 2]])
    assert.deepEqual(g[1].snapshots.map((s) => s.size), [20, 10]) // 新的在前
    assert.equal(g[1].snapshots[0].hash, 'bbbbbbbbbbbb…')
    assert.equal(g[1].snapshots[0].verifiable, true)
    assert.equal(g[0].snapshots[0].verifiable, false)
    assert.deepEqual(groupSnapshots(null, null), [])
    assert.match(snapshotLabel(snaps[2]), /无校验信息/)
    assert.doesNotMatch(snapshotLabel(snaps[0]), /无校验信息/)
  })

  it('statusSummary covers unconfigured / running / offline / last run / auto modes', () => {
    assert.equal(statusSummary(null).tone, 'info')
    assert.match(statusSummary({ configured: false }).text, /尚未配置/)
    const running = statusSummary({ configured: true, running: true, current: { kind: 'restore', drama_id: 2, title: null } })
    assert.deepEqual([running.tone, running.text], ['warning', '正在恢复「项目 #2」…'])
    assert.match(statusSummary({ configured: true, offline_since: '2026-10-02T00:00:00.000Z' }).text, /连接对象存储失败/)
    const ok = statusSummary({ configured: true, last_run: { status: 'done', finished_at: '2026-10-02T00:00:00.000Z', title: '雨夜' }, auto: 'daily', next_daily_at: '2026-10-03T00:00:00.000Z' })
    assert.equal(ok.tone, 'success')
    assert.match(ok.text, /最近一次备份.*成功（雨夜）/)
    assert.match(ok.text, /下次每日备份不早于/)
    const bad = statusSummary({ configured: true, last_run: { status: 'failed', started_at: '2026-10-02T00:00:00.000Z' }, auto: 'after_export' })
    assert.equal(bad.tone, 'error')
    assert.match(bad.text, /导出成片后/)
    assert.match(statusSummary({ configured: true, auto: 'off' }).text, /还没有备份过/)
  })
})
