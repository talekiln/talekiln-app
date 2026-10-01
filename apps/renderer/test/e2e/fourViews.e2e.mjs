// 四视图无缝切换的浏览器端到端检查（不在 `pnpm test` 里：需要 Chromium，缺失时直接跳过）。
//   node apps/renderer/test/e2e/fourViews.e2e.mjs [--shots <目录>]
// 环境：PLAYWRIGHT_BROWSERS_PATH（默认 /opt/pw-browsers）、PLAYWRIGHT_MODULE（playwright 包目录，默认依次找 /opt/node-tools、本地依赖）。
// 流程：起一个临时本地服务（独立数据目录 + 种子示例项目）-> 剧本视图改一行 -> 分镜 / 时间线 / 画布都能看到 ->
//      画布拖动节点：过期集合不变 -> 在画布里撤销（拖动、再改台词）-> 回到剧本视图文字已还原。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../../..')
const rendererDir = path.join(root, 'apps/renderer')
const args = process.argv.slice(2)
const shotsDir = args.includes('--shots') ? path.resolve(args[args.indexOf('--shots') + 1]) : null

const skip = (why) => { console.log(`SKIP four-views e2e: ${why}`); process.exit(0) }

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

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer()
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  s.on('error', reject)
})

const dist = path.join(rendererDir, 'dist')
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.log('building renderer (vite build)…')
  await new Promise((resolve, reject) => {
    const p = spawn('npx', ['vite', 'build'], { cwd: rendererDir, stdio: 'ignore' })
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`vite build exit ${c}`))))
  })
}

// ---- 临时本地服务 ----
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
let browser = null
const cleanup = async () => { try { await browser?.close() } catch (_) { /* ignore */ } server.kill(); fs.rmSync(tmp, { recursive: true, force: true }) }
let failed = 0
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failed++ }

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/health`)).ok) break } catch (_) { /* wait */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  const seeded = await api('/samples/talekiln-sample-v1/seed', { method: 'POST', body: '{}' })
  const ep = seeded.episode_id
  const drama = seeded.drama_id
  await api(`/episodes/${ep}/import-legacy`, { method: 'POST', body: '{}' })
  // 种子样例只有旧表数据：先组装一次时间线（经内核，旧页面读得到）
  try { await api(`/timelines/episode/${ep}/assemble`, { method: 'POST', body: '{}' }) } catch (_) { /* 已存在 */ }

  const script0 = await api(`/episodes/${ep}/views/script`)
  const target = script0.data.groups.flatMap((g) => g.lines).find((l) => l.kind === 'dialogue' && l.shot_ids.length)
  if (!target) throw new Error('no spoken line with a shot in the sample')
  const originalText = target.text
  const newText = `${originalText}（E2E 改）`
  const shotOf = target.shot_ids[0]

  browser = await pw.chromium.launch({ executablePath: exe, args: ['--no-sandbox'] })
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 760 } })).newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`http ${r.status()} ${r.request().method()} ${r.url().replace(base, '')}`) })
  const shot = async (name) => { if (shotsDir) { fs.mkdirSync(shotsDir, { recursive: true }); await page.screenshot({ path: path.join(shotsDir, `${name}.png`) }) } }
  const graph = () => api(`/episodes/${ep}/graph`)
  const tab = (k) => page.locator(`[data-test="view-tab-${k}"]`)

  // 1. 剧本视图改一行
  await page.goto(`${base}/episodes/${ep}/script?drama=${drama}`)
  const lineBox = page.locator(`[data-line-id="${target.id}"]`)
  await lineBox.waitFor()
  check(await page.locator('[data-test="view-bar"]').isVisible(), '剧本视图显示顶部视图切换栏')
  await lineBox.click()
  await shot('script')
  const ta = lineBox.locator('textarea')
  await ta.fill(newText)
  await ta.blur()
  await page.waitForFunction(([id, t]) => document.querySelector(`[data-line-id="${id}"] textarea`)?.value === t, [target.id, newText])
  await page.waitForTimeout(400)
  const afterEdit = await api(`/episodes/${ep}/views/script`)
  check(afterEdit.data.groups.flatMap((g) => g.lines).find((l) => l.id === target.id).text === newText, '内核里该行文字已改（经 POST /intent）')
  const seqEdit = (await graph()).seq
  check(await lineBox.locator('[data-test="shot-chip"]').count() > 0, '行显示它喂给的镜头')

  // 2. 分镜表
  await tab('storyboard').click()
  await page.waitForURL(new RegExp(`/project/${drama}/storyboard`))
  await page.waitForSelector('.el-table textarea')
  check((await page.locator('textarea').evaluateAll((els) => els.map((e) => e.value))).some((v) => v.includes(newText)), '分镜表的台词里出现改动')
  await page.waitForSelector('.el-table .is-focus', { timeout: 5000 }).catch(() => {})
  check(await page.locator('.el-table .is-focus').count() === 1, '分镜表高亮了与所选行对应的镜头')
  await shot('storyboard')

  // 3. 时间线
  await tab('timeline').click()
  await page.waitForURL(new RegExp(`/episodes/${ep}/timeline`))
  await page.waitForSelector('.te-clip')
  check((await page.locator('.te-clip-text').allTextContents()).some((t) => t.includes(newText)), '时间线字幕里出现改动')
  await page.waitForSelector('.te-clip.selected', { timeout: 5000 }).catch(() => {})
  check(await page.locator('.te-clip.selected').count() >= 1, '时间线选中了与所选行对应的片段')
  await shot('timeline')

  // 4. 画布
  await tab('canvas').click()
  await page.waitForURL(new RegExp(`/episodes/${ep}/canvas`))
  await page.waitForSelector(`[data-node-id="${target.id}"]`)
  check((await page.locator(`[data-node-id="${target.id}"]`).innerText()).includes(newText.slice(0, 20)), '画布节点卡片里出现改动')
  check(await page.locator(`[data-node-id="${shotOf}"]`).count() === 1, '画布里有该行对应的镜头节点')
  check(await page.locator('[data-test="scene-group"]').count() >= 1, '画布画出了场景分组框')
  await page.waitForTimeout(500)
  await page.locator(`[data-node-id="${shotOf}"]`).click()
  await page.waitForSelector('[data-test="canvas-panel"] [data-test="apply-params"]')
  await shot('canvas')

  // 5. 画布拖动：只改 layout，过期集合不变
  const g0 = await graph()
  const box = await page.locator(`[data-node-id="${shotOf}"]`).boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + 14)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + 14 + 50, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(800)
  const g1 = await graph()
  check(g1.seq === g0.seq + 1, '拖动产生了一个内核事务')
  check(JSON.stringify(g1.graph.layout[shotOf]) !== JSON.stringify(g0.graph.layout[shotOf]) && g1.graph.layout[shotOf], '节点位置（layout）已写入')
  check(JSON.stringify(g1.stale) === JSON.stringify(g0.stale), '拖动不改变过期集合')
  check(await page.locator('[data-test="stale-badge"]').innerText() === (g0.stale.length ? `待生成 / 已过期 ${g0.stale.length}` : '全部最新'), '顶栏过期徽标与内核一致')

  // 6. 画布连线：把剧本行连到合成节点（端口类型不匹配）-> 内核拒绝，画布上给出内核的文案，图不变
  await page.locator('.vue-flow__controls-fitview').click()
  await page.waitForTimeout(400)
  const composeNode = page.locator('[data-test="node-compose"]')
  if (await composeNode.count()) {
    const seqBefore = (await graph()).seq
    const src = await page.locator(`[data-node-id="${target.id}"] .vue-flow__handle.source`).boundingBox()
    const dst = await composeNode.locator('.vue-flow__handle.target').first().boundingBox()
    await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2)
    await page.mouse.down()
    await page.mouse.move(dst.x + dst.width / 2, dst.y + dst.height / 2, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(800)
    check((await graph()).seq === seqBefore, '非法连线（剧本行 -> 合成）没有改变图')
    const msg = await page.locator('[data-test="canvas-error"]').allTextContents()
    check(msg.length === 1 && msg[0].length > 0, `内核的校验文案显示在画布上：${msg[0] || ''}`)
    check(await page.locator('.vue-flow__edge').count() === g0.graph.edges.length, '画布上没有残留非法的边')
  } else check(false, '画布上找不到合成节点')

  // 7. 在画布里撤销：先撤销拖动，再撤销改台词；回剧本视图文字已还原
  await page.locator('[data-test="undo"]').click()
  await page.waitForTimeout(600)
  const g2 = await graph()
  check(JSON.stringify(g2.graph.layout[shotOf] ?? null) === JSON.stringify(g0.graph.layout[shotOf] ?? null), '撤销后节点位置还原')
  check(g2.seq > g1.seq && g2.can_redo === true, '撤销推进了内核历史，可重做')
  await page.locator('[data-test="undo"]').click()
  await page.waitForTimeout(600)
  await tab('script').click()
  await page.waitForURL(new RegExp(`/episodes/${ep}/script`))
  await page.waitForSelector(`[data-line-id="${target.id}"] textarea`)
  check(await page.locator(`[data-line-id="${target.id}"] textarea`).inputValue() === originalText, '从画布撤销后，剧本视图里的文字已还原')
  // 重做（Ctrl+Shift+Z）
  await page.locator('body').click({ position: { x: 5, y: 400 } })
  await page.keyboard.press('Control+Shift+Z')
  await page.waitForFunction(([id, t]) => document.querySelector(`[data-line-id="${id}"] textarea`)?.value === t, [target.id, newText])
  check(true, 'Ctrl+Shift+Z 重做后文字回来')
  check((await graph()).seq >= seqEdit, '重做后历史前进')

  // 8. 镜头点选 -> 其它视图聚焦
  await page.locator(`[data-line-id="${target.id}"] [data-test="shot-chip"]`).first().click()
  await tab('canvas').click()
  await page.waitForSelector(`[data-node-id="${shotOf}"]`)
  await page.waitForTimeout(400)
  check(await page.locator(`[data-node-id="${shotOf}"].sel`).count() === 1, '在剧本里点镜头后，画布聚焦同一镜头')

  // 9. 剧本视图：插入 / 拆分 / 合并 / 删除（都经 POST /intent）
  await tab('script').click()
  await page.waitForSelector(`[data-line-id="${target.id}"]`)
  const count = () => page.locator('[data-test="script-line"]').count()
  const n0 = await count()
  await page.locator(`[data-line-id="${target.id}"] [data-test="insert-line"]`).click()
  await page.waitForFunction((n) => document.querySelectorAll('[data-test="script-line"]').length === n + 1, n0)
  check(true, '插入一行')
  const taT = page.locator(`[data-line-id="${target.id}"] textarea`)
  await taT.evaluate((el) => { el.focus(); el.setSelectionRange(3, 3); el.dispatchEvent(new Event('select')) })
  await page.locator(`[data-line-id="${target.id}"] [data-test="split-line"]`).click()
  await page.waitForFunction((n) => document.querySelectorAll('[data-test="script-line"]').length === n + 2, n0)
  check(true, '在光标处拆分一行')
  await page.locator(`[data-line-id="${target.id}"] [data-test="merge-line"]`).click()
  await page.waitForFunction((n) => document.querySelectorAll('[data-test="script-line"]').length === n + 1, n0)
  check((await taT.inputValue()) === newText, '合并下一行后文字还原（拆分 / 合并互逆）')
  const added = (await api(`/episodes/${ep}/views/script`)).data.groups.flatMap((g) => g.lines).find((l) => l.text === '新的一行')
  await page.locator(`[data-line-id="${added.id}"] [data-test="delete-line"]`).click()
  await page.waitForFunction((n) => document.querySelectorAll('[data-test="script-line"]').length === n, n0)
  check(true, '删除一行')

  const real = errors.filter((e) => !/favicon/i.test(e) && !/Failed to load resource/.test(e) && !(/^http 4\d\d/.test(e) && /connectNodes|intent/.test(e)))
  check(real.length === 0, `控制台没有错误${real.length ? `：${real.slice(0, 3).join(' | ')}` : ''}`)
} catch (e) {
  failed++
  console.log(`FAIL e2e crashed: ${e.stack || e.message}`)
} finally {
  await cleanup()
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exit(failed ? 1 : 0)
