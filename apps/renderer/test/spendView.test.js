import test from 'node:test'
import assert from 'node:assert/strict'
import { rangeFor, formatMoney, monthProgress, parseCapInput, withBarPercent, csvFileName } from '../src/utils/spendView.js'

test('rangeFor presets use local dates', () => {
  const now = new Date(2026, 2, 5)
  assert.deepEqual(rangeFor('month', now), { from: '2026-03-01', to: '2026-03-05' })
  assert.deepEqual(rangeFor('last30', now), { from: '2026-02-04', to: '2026-03-05' })
  assert.deepEqual(rangeFor('lastMonth', now), { from: '2026-02-01', to: '2026-02-28' })
  assert.deepEqual(rangeFor('lastMonth', new Date(2026, 0, 10)), { from: '2025-12-01', to: '2025-12-31' })
  assert.deepEqual(rangeFor('all', now), { from: undefined, to: undefined })
})

test('formatMoney keeps small amounts visible', () => {
  assert.equal(formatMoney(6), '¥6.00')
  assert.equal(formatMoney(0.0008), '¥0.0008')
  assert.equal(formatMoney(0), '¥0.00')
  assert.equal(formatMoney('x'), '-')
  assert.equal(formatMoney(1, 'USD'), 'USD 1.00')
})

test('monthProgress levels', () => {
  assert.equal(monthProgress({ monthly_cap: null }).level, 'none')
  assert.equal(monthProgress({ monthly_cap: 100, spent: 10, in_flight_max: 0 }).level, 'ok')
  assert.equal(monthProgress({ monthly_cap: 100, spent: 70, in_flight_max: 15 }).level, 'warn')
  assert.deepEqual(monthProgress({ monthly_cap: 100, spent: 90, in_flight_max: 20 }), { percent: 100, level: 'danger', text: '已用及在途 100%' })
  assert.equal(monthProgress({ monthly_cap: 0, spent: 0 }).level, 'danger')
})

test('parseCapInput', () => {
  assert.deepEqual(parseCapInput(''), { value: null })
  assert.deepEqual(parseCapInput(' 50.5 '), { value: 50.5 })
  assert.deepEqual(parseCapInput('0'), { value: 0 })
  assert.ok(parseCapInput('-1').error)
  assert.ok(parseCapInput('abc').error)
})

test('withBarPercent scales to the max', () => {
  assert.deepEqual(withBarPercent([{ cost: 2 }, { cost: 1 }, { cost: 0 }]).map((r) => r.bar), [100, 50, 0])
  assert.deepEqual(withBarPercent([{ cost: 0 }]).map((r) => r.bar), [0])
})

test('csvFileName mirrors the server name', () => {
  assert.equal(csvFileName({ from: '2026-10-01', to: undefined }), 'spend-2026-10-01_now.csv')
  assert.equal(csvFileName({}), 'spend-all_now.csv')
})
