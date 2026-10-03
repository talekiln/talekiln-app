import test from 'node:test'
import assert from 'node:assert/strict'
import { registerAction, runAction, hasAction, setActionNotifier, unregisterAction } from '../src/shell/actions/registry.js'

function capture() {
  const seen = []
  setActionNotifier((type, key, params) => seen.push({ type, key, params }))
  return seen
}

test('unregistered id does not throw and shows shell.action.notReady', async () => {
  const seen = capture()
  assert.equal(hasAction('nope.nothing'), false)
  await runAction('nope.nothing', { episodeId: 1 })
  assert.deepEqual(seen, [{ type: 'info', key: 'shell.action.notReady', params: { id: 'nope.nothing' } }])
})

test('registered handler is awaited and receives the ctx', async () => {
  capture()
  const calls = []
  registerAction('t.one', async (ctx) => { calls.push(ctx); await Promise.resolve() })
  const ctx = { dramaId: 1, episodeId: 2 }
  assert.equal(hasAction('t.one'), true)
  await runAction('t.one', ctx)
  assert.deepEqual(calls, [ctx])
  unregisterAction('t.one')
  assert.equal(hasAction('t.one'), false)
})

test('registering the same id again replaces the handler (HMR friendly)', async () => {
  capture()
  const calls = []
  registerAction('t.two', () => calls.push('a'))
  registerAction('t.two', () => calls.push('b'))
  await runAction('t.two', {})
  assert.deepEqual(calls, ['b'])
  unregisterAction('t.two')
})

test('a throwing handler is reported, not rethrown', async () => {
  const seen = capture()
  registerAction('t.boom', () => { throw new Error('kaput') })
  await runAction('t.boom', {})
  assert.deepEqual(seen, [{ type: 'error', key: 'shell.action.failed', params: { id: 't.boom', message: 'kaput' } }])
  unregisterAction('t.boom')
})

test('registerAction validates its arguments', () => {
  assert.throws(() => registerAction('', () => {}), /id/)
  assert.throws(() => registerAction('t.x', null), /function/)
})
