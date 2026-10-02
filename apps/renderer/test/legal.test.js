import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONSENT_STORAGE_KEY, LEGAL_VERSION, buildConsentRecord, hasCurrentConsent, normalizeLegalUrl, readConsent,
  recordConsent, resolveLegalLinks, writeConsent,
} from '../src/utils/legal.js'

const memStorage = () => {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), raw: m }
}

describe('legal links', () => {
  it('shows pending when nothing is configured', () => {
    const links = resolveLegalLinks({})
    assert.deepEqual(links.map((l) => l.id), ['privacy', 'terms', 'report'])
    assert.ok(links.every((l) => l.pending && l.url === null))
    assert.ok(resolveLegalLinks(undefined).every((l) => l.pending))
  })
  it('accepts only https urls without credentials', () => {
    assert.equal(normalizeLegalUrl('https://example.test/privacy'), 'https://example.test/privacy')
    assert.equal(normalizeLegalUrl('http://example.test/p'), null)
    assert.equal(normalizeLegalUrl('javascript:alert(1)'), null)
    assert.equal(normalizeLegalUrl('https://u:p@example.test/'), null)
    assert.equal(normalizeLegalUrl('  '), null)
    assert.equal(normalizeLegalUrl(null), null)
  })
  it('resolves configured links individually', () => {
    const links = resolveLegalLinks({ VITE_LEGAL_PRIVACY_URL: 'https://example.test/privacy', VITE_LEGAL_TERMS_URL: 'ftp://x' })
    assert.equal(links[0].pending, false)
    assert.equal(links[0].url, 'https://example.test/privacy')
    assert.equal(links[1].pending, true)
    assert.equal(links[2].pending, true)
  })
})

describe('consent record', () => {
  it('has no consent by default and after corrupt data', () => {
    const s = memStorage()
    assert.equal(readConsent(s), null)
    assert.equal(hasCurrentConsent(s), false)
    s.setItem(CONSENT_STORAGE_KEY, '{not json')
    assert.equal(readConsent(s), null)
    s.setItem(CONSENT_STORAGE_KEY, JSON.stringify({ version: LEGAL_VERSION, acceptedAt: 'nope' }))
    assert.equal(readConsent(s), null)
    assert.equal(readConsent(null), null)
  })
  it('records version and time only', () => {
    const s = memStorage()
    const r = recordConsent(s, new Date('2026-10-02T03:04:05.000Z'))
    assert.equal(r.ok, true)
    assert.deepEqual(Object.keys(JSON.parse(s.raw.get(CONSENT_STORAGE_KEY))).sort(), ['acceptedAt', 'version'])
    assert.deepEqual(readConsent(s), { version: LEGAL_VERSION, acceptedAt: '2026-10-02T03:04:05.000Z' })
    assert.equal(hasCurrentConsent(s), true)
  })
  it('invalidates consent when the text version changes', () => {
    const s = memStorage()
    writeConsent(s, buildConsentRecord(new Date(), 'v1'))
    assert.equal(hasCurrentConsent(s, 'v1'), true)
    assert.equal(hasCurrentConsent(s, 'v2'), false)
  })
  it('reports failure when storage throws', () => {
    const bad = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
    assert.equal(recordConsent(bad).ok, false)
    assert.equal(hasCurrentConsent(bad), false)
    assert.equal(recordConsent(null).ok, false)
  })
})
