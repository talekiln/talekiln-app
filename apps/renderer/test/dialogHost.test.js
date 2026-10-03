import test from 'node:test'
import assert from 'node:assert/strict'
import { openDialog, closeDialog, currentDialog, registerDialog, loaderFor, setDialogNotifier } from '../src/shell/dialogs/index.js'

const quiet = () => { const seen = []; setDialogNotifier((type, key, p) => seen.push({ type, key, p })); return seen }

test('openDialog resolves with the value the dialog closes with', async () => {
  quiet()
  registerDialog('t.ok', () => Promise.resolve({ default: {} }))
  const p = openDialog('t.ok', { a: 1 })
  assert.equal(currentDialog.value.id, 't.ok')
  assert.deepEqual(currentDialog.value.props, { a: 1 })
  closeDialog({ saved: true })
  assert.deepEqual(await p, { saved: true })
  assert.equal(currentDialog.value, null)
})

test('opening a second dialog resolves the first with undefined', async () => {
  quiet()
  registerDialog('t.a', () => Promise.resolve({ default: {} }))
  registerDialog('t.b', () => Promise.resolve({ default: {} }))
  const first = openDialog('t.a')
  const second = openDialog('t.b')
  assert.equal(await first, undefined)
  assert.equal(currentDialog.value.id, 't.b')
  closeDialog('x')
  assert.equal(await second, 'x')
})

test('unknown dialog id resolves undefined and shows shell.dialog.notReady', async () => {
  const seen = quiet()
  assert.equal(await openDialog('nope.missing'), undefined)
  assert.deepEqual(seen, [{ type: 'info', key: 'shell.dialog.notReady', p: { id: 'nope.missing' } }])
  assert.equal(currentDialog.value, null)
})

test('closeDialog with nothing open is a no-op; loaderFor exposes registered loaders', () => {
  quiet()
  closeDialog()
  const loader = () => Promise.resolve({ default: {} })
  registerDialog('t.l', loader)
  assert.equal(loaderFor('t.l'), loader)
  assert.equal(loaderFor('t.none'), null)
})

test('closing a generate.* dialog with a result notifies generation listeners; other dialogs and empty results do not', async () => {
  quiet()
  const { onGenerationSubmitted } = await import('../src/shell/dialogs/index.js')
  registerDialog('generate.t', () => Promise.resolve({ default: {} }))
  registerDialog('other.t', () => Promise.resolve({ default: {} }))
  const seen = []
  const off = onGenerationSubmitted((r) => seen.push(r))
  const a = openDialog('generate.t'); closeDialog({ submitted: true }); await a
  const b = openDialog('generate.t'); closeDialog(undefined); await b
  const c = openDialog('other.t'); closeDialog({ submitted: true }); await c
  off()
  const d = openDialog('generate.t'); closeDialog({ submitted: true }); await d
  assert.deepEqual(seen, [{ submitted: true }])
})
