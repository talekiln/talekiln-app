import common from './messages/common.js'
import shell from './messages/shell.js'
import script from './messages/script.js'
import assets from './messages/assets.js'
import storyboard from './messages/storyboard.js'
import generate from './messages/generate.js'
import exportMsgs from './messages/export.js'
import canvas from './messages/canvas.js'
import home from './messages/home.js'
import backup from './messages/backup.js'
import routes from './messages/routes.js'

const all = [common, shell, script, assets, storyboard, generate, exportMsgs, canvas, home, backup, routes]
const catalog = { 'zh-CN': {}, en: {} }
for (const m of all) {
  Object.assign(catalog['zh-CN'], m['zh-CN'])
  Object.assign(catalog.en, m.en)
}
export default catalog
