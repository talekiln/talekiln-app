import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DISMISS_KEY, announcementAlertType, desktopBridge, dismissAnnouncement, downloadResultText, normalizeStatus, readDismissed,
  updateNotice, visibleAnnouncements,
} from '../src/utils/updatesView.js'

function memStorage(init = {}) {
  const m = new Map(Object.entries(init))
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m }
}

describe('updatesView', () => {
  it('desktopBridge only exists when preload exposed it', () => {
    assert.equal(desktopBridge(null), null)
    assert.equal(desktopBridge({}), null)
    assert.equal(desktopBridge({ talekilnDesktop: {} }), null)
    const b = { getCloudStatus() {} }
    assert.equal(desktopBridge({ talekilnDesktop: b }), b)
  })

  it('normalizeStatus tolerates junk and keeps only well-formed updates / announcements', () => {
    assert.deepEqual(normalizeStatus(null), { currentVersion: '', channel: 'stable', update: { available: false }, announcements: [], checkedAt: null, error: null })
    const s = normalizeStatus({
      currentVersion: '1.2.8', channel: 'beta', checkedAt: '2026-10-02T10:00:00Z', error: null,
      update: { available: true, version: '1.3.0', forced: 'yes', notes: 7, minVersion: '1.0.0' },
      announcements: [{ id: 1, title: 'a' }, { id: 2 }, null, { title: 'no id' }],
    })
    assert.deepEqual(s.update, { available: true, version: '1.3.0', forced: false, notes: '', minVersion: '1.0.0' })
    assert.deepEqual(s.announcements, [{ id: 1, title: 'a' }])
    assert.equal(s.channel, 'beta')
    assert.deepEqual(normalizeStatus({ update: { available: true } }).update, { available: false })
  })

  it('updateNotice: new version -> 去下载; checked -> latest; errors / not yet -> unknown; browser -> none', () => {
    const upd = updateNotice({ currentVersion: '1.2.8', checkedAt: 'x', update: { available: true, version: '1.3.0', notes: 'n' } })
    assert.deepEqual([upd.kind, upd.text, upd.button, upd.version, upd.notes], ['update', '有新版本 1.3.0', '去下载', '1.3.0', 'n'])
    assert.match(updateNotice({ update: { available: true, version: '2.0.0', forced: true } }).text, /必要更新/)
    const latest = updateNotice({ currentVersion: '1.2.8', checkedAt: '2026-10-02T10:00:00Z', update: { available: false } })
    assert.deepEqual([latest.kind, latest.text, latest.button], ['latest', '当前已是最新版本（1.2.8）', '重新检查'])
    const offline = updateNotice({ checkedAt: '2026-10-02T10:00:00Z', error: 'network' })
    assert.equal(offline.kind, 'unknown')
    assert.match(offline.text, /离线|不可达/)
    const unconf = updateNotice({ error: 'cloud_not_configured' })
    assert.deepEqual([unconf.kind, unconf.button], ['unknown', ''])
    const fresh = updateNotice(null)
    assert.deepEqual([fresh.kind, fresh.button], ['unknown', '立即检查'])
    assert.deepEqual(updateNotice({ update: { available: true, version: '9.9.9' } }, { desktop: false }), { kind: 'none', text: '', button: '' })
  })

  it('downloadResultText', () => {
    assert.equal(downloadResultText({ ok: true, mode: 'updater' }), '')
    assert.match(downloadResultText({ ok: true, mode: 'browser' }), /浏览器/)
    assert.match(downloadResultText({ ok: false, reason: '更新地址仍是占位值' }), /无法下载：更新地址仍是占位值/)
    assert.match(downloadResultText(null), /无法下载/)
  })

  it('dismissals live in localStorage by announcement id, capped, and survive bad storage', () => {
    const st = memStorage()
    assert.deepEqual(readDismissed(st), [])
    let d = dismissAnnouncement(st, 'a1')
    d = dismissAnnouncement(st, 7, d)
    d = dismissAnnouncement(st, 'a1', d) // 重复：挪到末尾，不重复
    assert.deepEqual(d, ['7', 'a1'])
    assert.deepEqual(JSON.parse(st.getItem(DISMISS_KEY)), ['7', 'a1'])
    assert.deepEqual(readDismissed(st), ['7', 'a1'])
    assert.deepEqual(dismissAnnouncement(st, '', d), d)
    const list = [{ id: 'a1', title: 'x' }, { id: 7, title: 'y' }, { id: 'new', title: 'z' }, { id: 'bad' }]
    assert.deepEqual(visibleAnnouncements(list, d).map((a) => a.id), ['new'])
    assert.deepEqual(visibleAnnouncements(list, []).map((a) => a.id), ['a1', 7, 'new'])
    assert.deepEqual(visibleAnnouncements(null, d), [])
    // 上限 200
    let many = []
    for (let i = 0; i < 230; i++) many = dismissAnnouncement(st, `n${i}`, many)
    assert.equal(many.length, 200)
    assert.equal(many[0], 'n30')
    // 坏的 storage：读回空，写不抛
    assert.deepEqual(readDismissed({ getItem: () => '{not json' }), [])
    assert.deepEqual(readDismissed(null), [])
    assert.deepEqual(dismissAnnouncement({ getItem: () => null, setItem() { throw new Error('quota') } }, 'q'), ['q'])
  })

  it('announcementAlertType maps levels to el-alert types', () => {
    assert.equal(announcementAlertType('critical'), 'error')
    assert.equal(announcementAlertType('warn'), 'warning')
    assert.equal(announcementAlertType('info'), 'info')
    assert.equal(announcementAlertType(undefined), 'info')
  })
})
