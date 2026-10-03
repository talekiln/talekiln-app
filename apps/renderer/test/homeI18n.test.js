import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import messages from '../src/i18n/messages/home.js'
import { CHAPTER_PATTERNS } from '../src/utils/homeModel.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
const zh = messages['zh-CN']
const en = messages.en

function filesIn(dir, ext) {
  const abs = path.join(root, dir)
  return fs.readdirSync(abs).filter((f) => f.endsWith(ext)).map((f) => path.join(abs, f))
}

const SOURCES = [
  ...['FilmList', 'NewProject', 'MediaLibrary', 'TaskCenter'].map((n) => path.join(root, 'views', `${n}.vue`)),
  ...filesIn('components/home', '.vue'),
  ...filesIn('components/home', '.js'),
  path.join(root, 'utils/homeModel.js'),
]

// action / 对话框 id 也以 home. 开头，但不是文案 key
const IDS = new Set(['home.oneLine', 'home.importScript', 'home.newBlank', 'home.importPackage', 'home.rename', 'home.globalLibrary'])

// 静态写出的 key：'home.xxx' 或 `home.xxx`（不含 ${}）
function staticKeys() {
  const keys = new Set()
  for (const file of SOURCES) {
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(/['"`](home\.[A-Za-z0-9_.:]+)['"`]/g)) if (!IDS.has(m[1])) keys.add(m[1])
  }
  return keys
}

// 带 ${} 的 key 在代码里由固定集合展开
const DYNAMIC = [
  ...['script', 'storyboard', 'timeline', 'canvas'].map((v) => `home.view.${v}`),
  ...['16:9', '9:16', '3:4', '1:1', '4:3', '21:9'].map((a) => `home.aspect.${a}`),
  ...['media', 'character', 'scene', 'prop'].map((x) => `home.library.tab.${x}`),
  ...['character', 'scene', 'prop'].flatMap((k) => [`home.library.empty.${k}`, `home.library.edit.${k}`, `home.library.confirmDelete.${k}`]),
  ...['name', 'location', 'time', 'category', 'description', 'tags'].map((f) => `home.library.field.${f}`),
  ...['oneLine', 'importScript', 'blank', 'importPackage'].flatMap((s) => ['title', 'sub', 'then'].map((p) => `home.start.${s}.${p}`)),
  ...Object.keys(CHAPTER_PATTERNS).concat('custom').map((k) => `home.importScript.preset.${k}`),
  ...['EMPTY_TEXT', 'BAD_PATTERN', 'NO_MATCH', 'TOO_BIG', 'READ'].map((c) => `home.importScript.err.${c}`),
  ...['STORY_EMPTY', 'STORY_TOO_LONG', 'TEMPLATE', 'RATIO', 'DURATION'].map((c) => `home.newProject.err.${c}`),
  ...['all', 'running', 'failed', 'done'].map((f) => `home.tasks.filter.${f}`),
  ...['queued', 'submitting', 'submitted', 'polling', 'downloading', 'succeeded', 'failed', 'cancelled', 'unknown'].map((s) => `home.tasks.state.${s}`),
  ...['voice', 'video', 'frame'].map((s) => `home.tasks.target.${s}`),
  ...['INVALID_API_KEY', 'MODEL_NOT_ENABLED', 'INSUFFICIENT_BALANCE', 'RATE_LIMITED', 'INVALID_PARAMS', 'TASK_FAILED', 'NETWORK', 'BAD_RESPONSE', 'PROVIDER_NOT_AVAILABLE', 'CAPABILITY_NOT_SUPPORTED', 'UNCERTAIN', 'UNKNOWN']
    .map((c) => `home.tasks.err.${c}`),
  'home.delete.noSnapshotUnavailable',
  'home.delete.noSnapshotFailed',
]

test('zh-CN and en define exactly the same home.* keys', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
})

test('every key starts with home. and has a non-empty string in both languages', () => {
  for (const [k, v] of Object.entries(zh)) {
    assert.ok(k.startsWith('home.'), k)
    assert.ok(typeof v === 'string' && v.trim(), `zh ${k}`)
    assert.ok(typeof en[k] === 'string' && en[k].trim(), `en ${k}`)
  }
})

test('{placeholders} match between languages', () => {
  const names = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
  for (const k of Object.keys(zh)) assert.equal(names(en[k]), names(zh[k]), k)
})

test('every home.* key used in the home sources is defined', () => {
  const used = [...staticKeys(), ...DYNAMIC]
  const missing = used.filter((k) => !(k in zh))
  assert.deepEqual(missing, [])
})

test('every defined key is used (no dead messages)', () => {
  const used = new Set([...staticKeys(), ...DYNAMIC])
  const dead = Object.keys(zh).filter((k) => !used.has(k))
  assert.deepEqual(dead, [])
})
