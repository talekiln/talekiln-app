import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROVIDERS, STEPS, buildConfigBody, getKeyReferralUrl, impliedProvider, nextStep, openKeyReferral, prevStep, resumeStep,
  shouldShowOnboarding, stepsFor, validateKeyInput, visibleProviders,
} from '../src/utils/onboarding.js'
import { SAMPLE_ID, seedAndLocate, storyboardLocation } from '../src/utils/sampleRoute.js'

describe('onboarding steps', () => {
  it('walks welcome to done and clamps at both ends', () => {
    assert.deepEqual(STEPS, ['welcome', 'provider', 'key', 'test', 'done'])
    assert.equal(nextStep('welcome'), 'provider')
    assert.equal(nextStep('done'), 'done')
    assert.equal(prevStep('welcome'), 'welcome')
    assert.equal(prevStep('test'), 'key')
  })
  it('keeps profiles for every known provider, but shows only the enabled ones', () => {
    assert.deepEqual(PROVIDERS.map((p) => p.id), ['bailian', 'ark'])
    for (const p of PROVIDERS) assert.ok(p.instructions.length >= 3 && p.baseUrl.startsWith('https://'))
    assert.deepEqual(visibleProviders(null).map((p) => p.id), ['bailian'])
    assert.deepEqual(visibleProviders({ providers: [{ id: 'bailian' }] }).map((p) => p.id), ['bailian'])
    assert.deepEqual(visibleProviders({ providers: [{ id: 'bailian' }, { id: 'ark' }] }).map((p) => p.id), ['bailian', 'ark'])
    assert.deepEqual(visibleProviders({ providers: [{ id: 'unknown' }] }), [])
  })
  it('skips the provider-choice step when only one provider is enabled', () => {
    assert.deepEqual(stepsFor(null), ['welcome', 'key', 'test', 'done'])
    assert.equal(impliedProvider(null), 'bailian')
    const one = stepsFor({})
    assert.equal(nextStep('welcome', one), 'key')
    assert.equal(prevStep('key', one), 'welcome')
    const two = stepsFor({ providers: [{ id: 'bailian' }, { id: 'ark' }] })
    assert.deepEqual(two, STEPS)
    assert.equal(nextStep('welcome', two), 'provider')
    assert.equal(impliedProvider({ providers: [{ id: 'bailian' }, { id: 'ark' }] }), null)
  })
})

describe('resumeStep', () => {
  const both = [{ id: 'bailian' }, { id: 'ark' }]
  it('starts at welcome on empty status', () => {
    assert.equal(resumeStep(null), 'welcome')
    assert.equal(resumeStep({ step: 'bogus' }), 'welcome')
  })
  it('keeps a valid saved step', () => {
    assert.equal(resumeStep({ step: 'provider', providers: both }), 'provider')
    assert.equal(resumeStep({ step: 'key', provider: 'ark', providers: both }), 'key')
  })
  it('falls back when the data for a step is missing', () => {
    assert.equal(resumeStep({ step: 'key', providers: both }), 'provider')
    assert.equal(resumeStep({ step: 'test', provider: 'ark', providers: both }), 'key')
    assert.equal(resumeStep({ step: 'test', providers: both }), 'provider')
    assert.equal(resumeStep({ step: 'done', has_key: false }), 'welcome')
  })
  it('jumps to the test once a key exists', () => {
    assert.equal(resumeStep({ step: 'provider', has_key: true, provider: 'ark', config_id: 3, providers: both }), 'test')
    assert.equal(resumeStep({ step: 'done', has_key: true, config_id: 3 }), 'done')
  })
  it('with a single enabled provider the choice step never shows and the provider is implied', () => {
    assert.equal(resumeStep({ step: 'provider' }), 'key')
    assert.equal(resumeStep({ step: 'key' }), 'key')
    assert.equal(resumeStep({ step: 'test' }), 'key')
    assert.equal(resumeStep({ step: 'provider', has_key: true, config_id: 3 }), 'test')
  })
})

describe('shouldShowOnboarding', () => {
  it('follows the server flag only', () => {
    assert.equal(shouldShowOnboarding({ needed: true }), true)
    assert.equal(shouldShowOnboarding({ needed: false }), false)
    assert.equal(shouldShowOnboarding(null), false)
  })
})

describe('validateKeyInput', () => {
  const sample = 'abcd' + '-' + '1234efgh'
  it('trims and accepts a plausible key', () => {
    assert.deepEqual(validateKeyInput(`  ${sample}\n`), { ok: true, key: sample })
  })
  it('rejects empty, short, spaced, masked and non-ascii input', () => {
    assert.equal(validateKeyInput('').ok, false)
    assert.equal(validateKeyInput(null).ok, false)
    assert.equal(validateKeyInput('abc').ok, false)
    assert.equal(validateKeyInput('abcd efgh1234').ok, false)
    assert.equal(validateKeyInput('****abcd').ok, false)
    assert.equal(validateKeyInput('密钥abcdefgh1234').ok, false)
  })
})

describe('buildConfigBody', () => {
  it('maps provider presets and falls back to the default model', () => {
    const b = buildConfigBody('bailian', 'k-value-123', '')
    assert.equal(b.provider, 'dashscope')
    assert.equal(b.service_type, 'text')
    assert.deepEqual(b.model, ['qwen-plus'])
    assert.equal(b.is_default, true)
    const a = buildConfigBody('ark', 'k-value-123', ' ep-123 ')
    assert.equal(a.provider, 'volces')
    assert.deepEqual(a.model, ['ep-123'])
    assert.equal(a.default_model, 'ep-123')
  })
  it('rejects unknown providers', () => {
    assert.throws(() => buildConfigBody('openai', 'k-value-123'), /服务商/)
  })
})

describe('referral stub', () => {
  it('returns the console url today and opens it in a new window without opener', () => {
    assert.equal(getKeyReferralUrl('ark'), PROVIDERS[1].consoleUrl)
    assert.equal(getKeyReferralUrl('nope'), '')
    const calls = []
    assert.equal(openKeyReferral('bailian', (...a) => calls.push(a)), true)
    assert.deepEqual(calls[0], [PROVIDERS[0].consoleUrl, '_blank', 'noopener,noreferrer'])
    assert.equal(openKeyReferral('nope', () => assert.fail('should not open')), false)
  })
})

describe('sample route', () => {
  it('builds the storyboard location from the seed response', () => {
    assert.deepEqual(storyboardLocation({ drama_id: 4, episode_id: 9 }), { name: 'episode-storyboard', params: { dramaId: 4, episodeId: 9 } })
  })
  it('seeds through the given api and returns the location', async () => {
    let asked
    const loc = await seedAndLocate({ seedSample: async (id) => { asked = id; return { drama_id: 1, episode_id: 2 } } })
    assert.equal(asked, SAMPLE_ID)
    assert.equal(loc.params.dramaId, 1)
  })
})
