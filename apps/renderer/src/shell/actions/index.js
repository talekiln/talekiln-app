// 汇总各 lane 的 action 表并注册。每个 lane 只改自己的文件，互不冲突。
import { registerAction } from './registry.js'
import script from './script.js'
import assets from './assets.js'
import storyboard from './storyboard.js'
import generate from './generate.js'
import exportActions from './export.js'
import canvas from './canvas.js'
import home from './home.js'

export { registerAction, runAction, hasAction } from './registry.js'

const TABLES = [script, assets, storyboard, generate, exportActions, canvas, home]

let installed = false
export function installActions() {
  if (installed) return
  installed = true
  for (const table of TABLES) {
    for (const [id, fn] of Object.entries(table || {})) registerAction(id, fn)
  }
}
