// 命令面板 + 键位预设的浏览器端到端检查（不在 `pnpm test` 里：需要 Chromium，缺失时直接跳过）。
//   node apps/renderer/test/e2e/commandPalette.e2e.mjs [--shots <目录>]
// 流程：Ctrl+K 打开 -> 搜“画布”回车跳转 -> 最近使用置顶 -> 搜台词 / 镜头 -> 面板里撤销 -> 打开版本历史 ->
//      快捷键设置切到 Premiere 预设（Ctrl+K 不再开面板，Ctrl+Shift+P 开）-> 导出 / 导入 JSON -> 恢复。
import fs from 'node:fs'
import path from 'node:path'
import {
  parseArgs, skipUnlessBrowser, ensureDist, startServer, trackErrors, makeChecker, shooter,
} from './_harness.mjs'

const { shotsDir } = parseArgs()
const { pw, exe } = skipUnlessBrowser('command-palette e2e')
const dist = await ensureDist()
const { check, state } = makeChecker()
const srv = await startServer(dist)
const { base, api, ep, drama } = srv
let browser = null

try {
  const script0 = await api(`/episodes/${ep}/views/script`)
  const target = script0.data.groups.flatMap((g) => g.lines).find((l) => l.kind === 'dialogue' && l.shot_ids.length)
  const snippet = target.text.replace(/^[^：:]*[：:]/, '').slice(0, 4) // 台词正文前几个字
  const edited = `${target.text}（面板撤销测试）`
  await api(`/episodes/${ep}/intent`, { method: 'POST', body: JSON.stringify({ view: 'script', name: 'rewriteLine', args: { line_id: target.id, patch: { text: edited } }, tx_id: 'e2e-pal-1' }) })

  browser = await pw.chromium.launch({ executablePath: exe, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 760 }, acceptDownloads: true })
  const page = await ctx.newPage()
  const errors = trackErrors(page, base)
  const shot = shooter(page, shotsDir)
  const palette = page.locator('[data-test="palette"]')
  const input = page.locator('[data-test="palette-input"]')
  const items = page.locator('[data-test="palette-item"]')
  const graph = () => api(`/episodes/${ep}/graph`)
  const itemIds = () => items.evaluateAll((els) => els.map((e) => e.getAttribute('data-cmd')))

  await page.goto(`${base}/episodes/${ep}/script?drama=${drama}`)
  await page.locator(`[data-line-id="${target.id}"]`).waitFor()
  await page.waitForFunction((t) => document.querySelector(`[data-line-id="${t}"] textarea`)?.value.includes('面板撤销测试'), target.id)

  // 1. Ctrl+K 打开，输入框已聚焦，Escape 关闭，再开 / 同键关闭
  check(await palette.count() === 0, '面板默认不显示')
  await page.keyboard.press('Control+k')
  await palette.waitFor()
  check(await input.evaluate((el) => el === document.activeElement), 'Ctrl+K 打开后输入框已聚焦')
  const all = await itemIds()
  check(all.includes('view.canvas') && all.includes('nav.keyboard') && all.includes('history.open'), `空查询列出命令（${all.length} 条，含视图切换与历史）`)
  await shot('palette-open')
  await page.keyboard.press('Escape')
  await palette.waitFor({ state: 'detached' })
  check(true, 'Escape 关闭面板')
  await page.keyboard.press('Control+k')
  await palette.waitFor()
  await page.keyboard.press('Control+k')
  await palette.waitFor({ state: 'detached' })
  check(true, '面板打开时再按 Ctrl+K 关闭')

  // 2. 模糊搜索 + 回车执行：画布
  await page.keyboard.press('Control+k')
  await input.fill('画布')
  check((await itemIds())[0] === 'view.canvas', '搜“画布”，第一条是“切换到画布视图”')
  await page.keyboard.press('Enter')
  await page.waitForURL(new RegExp(`/episodes/${ep}/canvas`))
  await palette.waitFor({ state: 'detached' })
  check(true, '回车执行：跳到画布视图并关闭面板')

  // 3. 最近使用置顶；方向键移动并循环
  await page.keyboard.press('Control+k')
  await input.waitFor()
  check((await itemIds())[0] === 'view.canvas', '空查询时最近使用的命令排第一')
  check(await page.locator('.cp-group').first().innerText() === '最近使用', '最近使用有分组标题')
  const total = (await itemIds()).length
  await page.keyboard.press('ArrowUp')
  check(await items.nth(total - 1).evaluate((el) => el.classList.contains('active')), '↑ 从第一项循环到最后一项')
  await page.keyboard.press('ArrowDown')
  check(await items.nth(0).evaluate((el) => el.classList.contains('active')), '↓ 回到第一项')
  await page.keyboard.press('Escape')

  // 4. 搜索台词：命中台词行和对应镜头，回车跳到剧本视图并选中该行
  await page.keyboard.press('Control+k')
  await input.fill(snippet)
  await page.waitForFunction(() => document.querySelectorAll('[data-test="palette-item"]').length > 0)
  const found = await itemIds()
  check(found.includes(`line:${target.id}`), `搜台词“${snippet}”命中该台词行`)
  check(found.some((i) => i.startsWith('shot:')), '同时命中含该台词的镜头')
  await shot('palette-search')
  await page.locator(`[data-cmd="line:${target.id}"]`).click()
  await page.waitForURL(new RegExp(`/episodes/${ep}/script`))
  await page.locator(`[data-line-id="${target.id}"]`).waitFor()
  await page.waitForTimeout(300)
  check(await page.locator(`[data-line-id="${target.id}"].focus`).count() === 1, '点台词结果：跳到剧本视图并聚焦该行')

  // 5. 面板里撤销：台词回到改之前
  await page.keyboard.press('Control+k')
  await input.fill('撤销')
  check((await itemIds())[0] === 'edit.undo', '搜“撤销”第一条是撤销')
  const seq0 = (await graph()).seq
  await page.keyboard.press('Enter')
  await page.waitForFunction((t) => !document.querySelector(`[data-line-id="${t}"] textarea`)?.value.includes('面板撤销测试'), target.id)
  const g1 = await graph()
  check(g1.seq > seq0 && g1.can_redo === true, '命令“撤销”走内核历史（可重做）')
  check((await api(`/episodes/${ep}/views/script`)).data.groups.flatMap((g) => g.lines).find((l) => l.id === target.id).text === target.text, '台词已还原')
  // 撤销已空（把剩下的历史经 API 撤完再刷新页面）：命令置灰，不可执行
  for (let i = 0; i < 50 && (await graph()).can_undo; i++) await api(`/episodes/${ep}/undo`, { method: 'POST', body: '{}' })
  await page.reload()
  await page.locator(`[data-line-id="${target.id}"]`).waitFor()
  await page.waitForFunction(() => document.querySelector('[data-test="undo"]')?.disabled)
  await page.keyboard.press('Control+k')
  await input.fill('撤销')
  check(await items.first().evaluate((el) => el.classList.contains('disabled')), '没有可撤销的步骤时“撤销”置灰')
  await page.keyboard.press('Escape')

  // 6. 打开版本历史
  await page.keyboard.press('Control+k')
  await input.fill('版本历史')
  await page.keyboard.press('Enter')
  await page.locator('[data-test="history-tabs"]').waitFor()
  check(true, '命令“打开版本历史”打开历史抽屉')
  await page.keyboard.press('Escape')
  await page.locator('[data-test="history-tabs"]').waitFor({ state: 'hidden' })

  // 7. 快捷键设置：切到 Premiere 预设
  await page.goto(`${base}/settings/shortcuts`)
  await page.locator('[data-test="ks-preset"]').waitFor()
  const keysOf = (id) => page.locator('.ks-row', { hasText: id }).locator('.el-tag').allTextContents()
  check((await keysOf('打开命令面板')).join('').includes('Ctrl+K'), '默认预设：命令面板 Ctrl+K')
  await page.locator('[data-test="ks-preset"]').click()
  await page.locator('.el-select-dropdown__item', { hasText: 'Premiere' }).click()
  await page.waitForFunction(() => localStorage.getItem('talekiln.keymap.preset.v1') === 'premiere')
  check((await keysOf('打开命令面板')).join('').includes('Ctrl+Shift+P'), 'Premiere 预设：命令面板改为 Ctrl+Shift+P')
  check((await keysOf('切分片段')).join('').includes('Ctrl+K'), 'Premiere 预设：切分是 Ctrl+K')
  check(await page.locator('.el-alert').count() === 0, 'Premiere 预设没有冲突提示')
  await shot('keymap-premiere')
  await page.keyboard.press('Control+k')
  await page.waitForTimeout(250)
  check(await palette.count() === 0, 'Premiere 预设下 Ctrl+K 不再打开面板')
  await page.keyboard.press('Control+Shift+P')
  await palette.waitFor()
  check(true, 'Ctrl+Shift+P 打开面板')
  await page.keyboard.press('Escape')

  // 8. 自定义键位的冲突检测：给“静音轨道”添加 Ctrl+K（与切分同键）
  await page.locator('.ks-row', { hasText: '静音 / 取消静音当前轨道' }).getByText('+ 添加').click()
  await page.keyboard.press('Control+k')
  await page.waitForTimeout(250)
  check(await page.locator('.el-alert').count() === 1, '自定义出现同键 -> 冲突提示')
  check(await palette.count() === 0, '录制键位时不会触发命令面板')
  await shot('keymap-conflict')

  // 9. 导出 / 导入 JSON
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('[data-test="ks-export"]').click()])
  const file = await dl.path()
  const exported = JSON.parse(fs.readFileSync(file, 'utf8'))
  check(exported.format === 'talekiln-keymap' && exported.preset === 'premiere' && Array.isArray(exported.overrides['track.mute']), '导出的 JSON 含预设与自定义项')
  await page.locator('.ks-row', { hasText: '静音 / 取消静音当前轨道' }).getByRole('button', { name: '恢复预设' }).click()
  check(await page.locator('.el-alert').count() === 0, '恢复预设后冲突消失')
  const tmpFile = path.join(path.dirname(file), 'import-keymap.json')
  fs.writeFileSync(tmpFile, JSON.stringify({ format: 'talekiln-keymap', version: 1, preset: 'jianying', overrides: { 'clip.split': ['B'] } }))
  await page.locator('[data-test="ks-import-file"]').setInputFiles(tmpFile)
  await page.waitForFunction(() => localStorage.getItem('talekiln.keymap.preset.v1') === null)
  check((await keysOf('切分片段')).join('').includes('B'), '导入 JSON：预设与自定义键位生效')
  await page.locator('[data-test="ks-reset-all"]').click()
  check((await keysOf('切分片段')).join('').includes('S'), '全部恢复预设')

  const real = errors.filter((e) => !/favicon/i.test(e) && !/Failed to load resource/.test(e))
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
