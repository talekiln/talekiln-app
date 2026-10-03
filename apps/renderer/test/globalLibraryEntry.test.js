import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import homeActions from '../src/shell/actions/home.js'
import assetActions from '../src/shell/actions/assets.js'
import dialogs from '../src/shell/dialogs/assets.js'
import messages from '../src/i18n/messages/assets.js'

const read = (rel) => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')

test('home top bar and the in-project import share one dialog: assets.globalLibrary', async () => {
  const calls = []
  const ctx = { openDialog: (id, props) => { calls.push([id, props]) } }
  await homeActions['home.globalLibrary'](ctx)
  await assetActions['assets.importFromGlobal'](ctx)
  assert.deepEqual(calls[0], ['assets.globalLibrary', { kind: 'characters', scope: 'global', browseOnly: true }])
  assert.deepEqual(calls[1], ['assets.globalLibrary', {}])
  assert.equal(typeof dialogs['assets.globalLibrary'], 'function')
})

test('HomeTopBar no longer links straight to the media-library page; it runs home.globalLibrary', () => {
  const bar = read('components/home/HomeTopBar.vue')
  assert.match(bar, /runAction\('home\.globalLibrary'/)
  assert.match(bar, /data-test="bar-library" @click="openLibrary"/)
  assert.equal(bar.includes("name: 'media-library'"), false)
})

test('the dialog has a browse-only mode and a way to the edit / delete tabs', () => {
  const dlg = read('components/assets/GlobalLibraryDialog.vue')
  assert.match(dlg, /browseOnly: \{ type: Boolean/)
  assert.match(dlg, /v-if="!browseOnly"[^\n]*data-test="lib-import"/)
  assert.match(dlg, /name: 'media-library'/)
  for (const loc of ['zh-CN', 'en']) assert.ok(messages[loc]['assets.global.manage'], loc)
})
