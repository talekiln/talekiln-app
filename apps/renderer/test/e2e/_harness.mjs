// 无头浏览器 e2e 的公共准备（不是测试入口）：Playwright / Chromium 探测、必要时重建 dist、
// 起临时本地服务（独立数据目录 + 种子示例项目）。与 fourViews.e2e.mjs 同一套环境变量：
//   PLAYWRIGHT_BROWSERS_PATH（默认 /opt/pw-browsers）、PLAYWRIGHT_MODULE（playwright 包目录）。
// dist 比 src 旧（或不存在）时自动 `vite build`：e2e 跑的是构建产物，忘了重建会测到旧界面。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const root = path.resolve(here, '../../../..')
export const rendererDir = path.join(root, 'apps/renderer')

export function parseArgs() {
  const args = process.argv.slice(2)
  return { shotsDir: args.includes('--shots') ? path.resolve(args[args.indexOf('--shots') + 1]) : null }
}

export function skipUnlessBrowser(label) {
  const skip = (why) => { console.log(`SKIP ${label}: ${why}`); process.exit(0) }
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/opt/pw-browsers'
  const require = createRequire(import.meta.url)
  let pw = null
  for (const c of [process.env.PLAYWRIGHT_MODULE, '/opt/node-tools/node_modules/playwright', 'playwright'].filter(Boolean)) {
    try { pw = require(c); break } catch (_) { /* next */ }
  }
  if (!pw) skip('playwright module not found (set PLAYWRIGHT_MODULE)')
  let exe = null
  try { exe = pw.chromium.executablePath() } catch (_) { /* none */ }
  if (!exe || !fs.existsSync(exe)) skip('Chromium not installed under PLAYWRIGHT_BROWSERS_PATH')
  return { pw, exe }
}

const newestMtime = (dir) => {
  let m = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    m = Math.max(m, e.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs)
  }
  return m
}

export async function ensureDist() {
  const dist = path.join(rendererDir, 'dist')
  const index = path.join(dist, 'index.html')
  const stale = !fs.existsSync(index) || newestMtime(path.join(rendererDir, 'src')) > fs.statSync(index).mtimeMs
  if (stale) {
    console.log('building renderer (vite build)…')
    await new Promise((resolve, reject) => {
      const p = spawn('npx', ['vite', 'build'], { cwd: rendererDir, stdio: 'ignore' })
      p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`vite build exit ${c}`))))
    })
  }
  return dist
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer()
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  s.on('error', reject)
})

/** 起临时服务并种入示例项目（导入内核图、装配时间线）。返回 { base, api, ep, drama, stop }。 */
export async function startServer(dist) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'talekiln-e2e-'))
  fs.mkdirSync(path.join(tmp, 'configs'))
  for (const f of ['config.yaml', 'prices.json']) fs.copyFileSync(path.join(root, 'packages/local/configs', f), path.join(tmp, 'configs', f))
  const port = await freePort()
  const server = spawn(process.execPath, [path.join(root, 'packages/local/src/server.js')], {
    cwd: tmp, env: { ...process.env, PORT: String(port), WEB_DIST_PATH: dist }, stdio: 'ignore',
  })
  const base = `http://127.0.0.1:${port}`
  const api = async (p, init) => {
    const r = await fetch(`${base}/api/v1${p}`, { headers: { 'Content-Type': 'application/json' }, ...init })
    const j = await r.json()
    if (!r.ok) throw new Error(`${p}: ${r.status} ${JSON.stringify(j.error || j)}`)
    return j.data
  }
  const stop = () => { server.kill(); fs.rmSync(tmp, { recursive: true, force: true }) }
  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${base}/health`)).ok) break } catch (_) { /* wait */ }
      await new Promise((r) => setTimeout(r, 250))
    }
    const seeded = await api('/samples/talekiln-sample-v1/seed', { method: 'POST', body: '{}' })
    const ep = seeded.episode_id
    await api(`/episodes/${ep}/import-legacy`, { method: 'POST', body: '{}' })
    try { await api(`/timelines/episode/${ep}/assemble`, { method: 'POST', body: '{}' }) } catch (_) { /* 已存在 */ }
    return { base, api, ep, drama: seeded.drama_id, stop }
  } catch (e) {
    stop()
    throw e
  }
}

/** 记录页面错误（pageerror / console.error / HTTP >= 400）。 */
export function trackErrors(page, base) {
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`http ${r.status()} ${r.request().method()} ${r.url().replace(base, '')}`) })
  return errors
}

export function makeChecker() {
  const state = { failed: 0 }
  const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) state.failed++ }
  return { check, state }
}

export function shooter(page, shotsDir) {
  return async (name) => {
    if (!shotsDir) return
    fs.mkdirSync(shotsDir, { recursive: true })
    await page.screenshot({ path: path.join(shotsDir, `${name}.png`) })
  }
}
