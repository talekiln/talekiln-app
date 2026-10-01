// 版本历史界面的浏览器端到端检查（不在 `pnpm test` 里：需要 Chromium，缺失时直接跳过）。
//   node apps/renderer/test/e2e/versionHistory.e2e.mjs [--shots <目录>]
// 流程：用 API 造几步操作和一个节点的两个生成版本 -> 顶栏“历史”打开抽屉 -> 节点版本：采用另一个版本（走 POST /tx 的
//      adoptVersion）-> 操作历史：回到较早一步（连续撤销）-> 恢复到较晚一步（连续重做）。
import { createRequire } from 'node:module'
import path from 'node:path'
import {
  root, parseArgs, skipUnlessBrowser, ensureDist, startServer, trackErrors, makeChecker, shooter,
} from './_harness.mjs'

const { shotsDir } = parseArgs()
const { pw, exe } = skipUnlessBrowser('version-history e2e')
const dist = await ensureDist()
const kernel = createRequire(import.meta.url)(path.join(root, 'packages/kernel'))
const { check, state } = makeChecker()
const srv = await startServer(dist)
const { base, api, ep, drama } = srv
let browser = null

try {
  const post = (p, body) => api(`/episodes/${ep}${p}`, { method: 'POST', body: JSON.stringify(body) })
  const graph = () => api(`/episodes/${ep}/graph`)
  const versions = () => api(`/episodes/${ep}/versions`)

  // ---- 造数据：改台词、改镜头标题、给第 2 个镜头的首帧图加两个版本（A 与当前输入一致并采用，B 是旧输入的）----
  const g0 = (await graph()).graph
  const shots = kernel.shotOrder(g0)
  const shotNo = 2
  const shotId = shots[shotNo - 1]
  const imageNode = kernel.partsOfShot(g0, shotId).image
  const line = kernel.spokenLines(g0, shots[0])[0]
  const baseline = (await versions()).nodes.find((n) => n.node === imageNode)
  await post('/intent', { view: 'script', name: 'rewriteLine', args: { line_id: line, patch: { text: '老周：历史界面测试。' } }, tx_id: 'e2e-h1' })
  await post('/intent', { view: 'shot', name: 'setShotField', args: { shot_id: shotId, patch: { title: '历史镜头' } }, tx_id: 'e2e-h2' })
  const key = kernel.cacheKeys((await graph()).graph)[imageNode]
  const asset = (ref) => ({ ref, kind: 'image', hash: 'f'.repeat(64) })
  await post('/tx', {
    tx_id: 'e2e-h3', label: 'recordGeneration',
    ops: [
      { op: 'addVersion', node: imageNode, version: { id: 'vB', cache_key: 'old-input-key', asset: asset('images/b.png'), metadata: { inputs: { model: 'm-old' } }, source: 'ai-task:1' } },
      { op: 'addVersion', node: imageNode, version: { id: 'vA', cache_key: key, asset: asset('images/a.png'), metadata: { inputs: { model: 'm-new' } }, source: 'ai-task:2' } },
      { op: 'adoptVersion', node: imageNode, version_id: 'vA' },
    ],
  })

  browser = await pw.chromium.launch({ executablePath: exe, args: ['--no-sandbox'] })
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage()
  const errors = trackErrors(page, base)
  const shot = shooter(page, shotsDir)
  const card = (id) => page.locator(`[data-test="version-card"][data-version="${id}"]`)
  const op = (tx) => page.locator(`[data-test="history-op"][data-tx="${tx}"]`)

  await page.goto(`${base}/episodes/${ep}/script?drama=${drama}`)
  await page.locator('[data-test="script-line"]').first().waitFor()
  await page.waitForFunction(() => !document.querySelector('[data-test="view-bar"]') || true)
  await page.locator('[data-test="open-history"]').click()
  await page.locator('[data-test="history-tabs"]').waitFor()
  check(true, '顶栏“历史”打开版本历史抽屉')

  // 1. 节点版本
  await page.locator('[data-test="history-node"]').click()
  await page.locator('.el-select-dropdown__item', { hasText: `镜头 ${shotNo} · 首帧图` }).click()
  await card('vA').waitFor()
  check(await card('vA').locator('[data-test="version-adopted"]').count() === 1, '版本 vA 标为“采用中”')
  check(await card('vB').locator('[data-test="version-adopted"]').count() === 0, '版本 vB 未采用')
  check((await card('vB').innerText()).includes('输入已变'), '输入与现在不符的版本有“输入已变”提示')
  check((await card('vA').innerText()).includes('AI 生成') && (await card('vA').innerText()).includes('m-new'), '版本卡片显示来源与模型')
  check(/\d\d-\d\d \d\d:\d\d/.test(await card('vA').innerText()), '版本卡片显示产生时间')
  const order = await page.locator('[data-test="version-card"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-version')))
  check(order.indexOf('vA') < order.indexOf('vB') && order.length === baseline.versions.length + 2, `新版本在前（共 ${order.length} 个版本，含导入的 ${baseline.versions.length} 个）`)
  check(await page.locator('[data-test="history-node-state"]').innerText() === '最新', '节点状态“最新”')
  await page.waitForTimeout(500) // 标签入场动画
  await shot('history-versions')

  // 2. 采用 vB：走 POST /tx adoptVersion；节点变过期；一步可撤销
  const seq0 = (await graph()).seq
  await card('vB').locator('[data-test="adopt-version"]').click()
  await page.waitForFunction(() => document.querySelector('[data-version="vB"] [data-test="version-adopted"]'))
  const g1 = await graph()
  check(g1.graph.adopted[imageNode] === 'vB' && g1.seq === seq0 + 1, '采用 vB：内核记录了一个 adoptVersion 事务')
  check(g1.stale.includes(imageNode), '采用与当前输入不符的版本后，节点显示已过期')
  check(await page.locator('[data-test="history-node-state"]').innerText() === '已过期', '抽屉里的节点状态同步为“已过期”')
  // 标签有离场动画，等它真正离开 DOM
  await page.waitForFunction(() => !document.querySelector('[data-version="vA"] [data-test="version-adopted"]'))
  check(true, 'vA 不再是采用中')
  check((await versions()).nodes.find((n) => n.node === imageNode).versions.length === baseline.versions.length + 2, '采用不新增版本（零成本切换）')

  // 3. 操作历史
  await page.getByRole('tab', { name: '操作历史' }).click()
  await op('e2e-h3').waitFor()
  const states = await page.locator('[data-test="history-op"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-state')))
  check(states.every((s) => s === 'applied'), '所有记录都是“已生效”')
  check((await op('e2e-h3').innerText()).includes('记录生成结果'), '记录显示中文标签')
  check((await op('e2e-h1').innerText()).includes('改写台词'), '改台词记录显示“改写台词”')
  check(await page.locator('[data-test="history-op"].head').count() === 1, '最新生效的一步标为“当前”')
  await page.waitForTimeout(500)
  await shot('history-ops')

  // 4. 回到 e2e-h2：撤销 e2e-h3 与采用 vB 两步
  await op('e2e-h2').locator('[data-test="history-jump"]').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-test="history-op"][data-state="undone"]').length === 2)
  const g2 = await graph()
  check(g2.graph.nodes[shotId].params.title === '历史镜头', '回到 h2：镜头标题改动还在')
  check(!(g2.graph.versions[imageNode] || []).some((v) => v.id === 'vA' || v.id === 'vB'), '回到 h2：后面生成的版本已撤销')
  check((g2.graph.nodes[line].params.text) === '老周：历史界面测试。', '回到 h2：更早的台词改动还在')
  check(await op('e2e-h3').getAttribute('data-state') === 'undone', 'h3 变为“已撤销”')
  check(await op('e2e-h3').locator('[data-test="history-jump"]').count() === 1, '已撤销的步骤提供“恢复到此步”')
  await page.waitForTimeout(500)
  await shot('history-ops-undone')

  // 5. 恢复到 h3：重做
  await op('e2e-h3').locator('[data-test="history-jump"]').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-test="history-op"][data-state="undone"]').length === 1)
  const g3 = await graph()
  check(g3.graph.adopted[imageNode] === 'vA', '恢复到 h3：vA 重新被采用')
  // 恢复到更晚（被采用 vB 的那一步）
  const adoptTx = await page.locator('[data-test="history-op"][data-state="undone"]').getAttribute('data-tx')
  await page.locator(`[data-test="history-op"][data-tx="${adoptTx}"] [data-test="history-jump"]`).click()
  await page.waitForFunction(() => document.querySelectorAll('[data-test="history-op"][data-state="undone"]').length === 0)
  check((await graph()).graph.adopted[imageNode] === 'vB', '恢复到最后一步：vB 回到采用状态')

  // 6. 新操作顶掉重做栈：被覆盖的记录不能再跳
  await op('e2e-h2').locator('[data-test="history-jump"]').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-test="history-op"][data-state="undone"]').length === 2)
  await post('/intent', { view: 'shot', name: 'setShotField', args: { shot_id: shotId, patch: { title: '历史镜头 2' } }, tx_id: 'e2e-h4' })
  await page.waitForFunction(() => document.querySelectorAll('[data-test="history-op"][data-state="discarded"]').length === 2)
  check(await page.locator('[data-test="history-op"][data-state="discarded"] [data-test="history-jump"]').count() === 0, '被新操作覆盖的记录标为“已被覆盖”且不可跳转')

  const real = errors.filter((e) => !/favicon/i.test(e) && !/Failed to load resource/.test(e) && !/\/static\/images\//.test(e))
  check(real.length === 0, `控制台没有错误${real.length ? `：${real.slice(0, 3).join(' | ')}` : ''}`)
} catch (e) {
  state.failed++
  console.log(`FAIL e2e crashed: ${e.stack || e.message}`)
} finally {
  try { await browser?.close() } catch (_) { /* ignore */ }
  srv.stop()
}
console.log(state.failed ? `\n${state.failed} check(s) failed` : '\nall checks passed')
process.exit(state.failed ? 1 : 0)
