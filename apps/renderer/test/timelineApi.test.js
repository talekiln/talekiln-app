import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/api/timelines.js', import.meta.url), 'utf8')
/** 取出 timelinesAPI 里某个方法的源码（方法体到两空格缩进的 `}` 为止） */
const method = (name) => {
  const m = src.match(new RegExp(name + String.raw`\([^)]*\)\s*\{[\s\S]*?\r?\n  \}`))
  assert.ok(m, `${name} 存在`)
  return m[0]
}

test('getByEpisode 关闭全局错误弹窗：404 是“尚未组装”的正常状态，由时间线页自己展示空态和非 404 错误', () => {
  assert.match(method('getByEpisode'), /silentError:\s*true/)
})

test('其余时间线接口仍走全局错误弹窗', () => {
  for (const name of ['assemble', 'save', 'addClip', 'patchClip']) assert.doesNotMatch(method(name), /silentError/)
})
