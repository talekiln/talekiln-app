// generate lane 的 action 表：生成菜单 8 项。逻辑在 components/generate/generateActions.js（依赖注入，有单测），
// 这里只接真实依赖。会花钱的动作只是打开对话框，由对话框里的确认按钮提交。
import { createGenerateActions } from '../../components/generate/generateActions.js'

async function notify(type, key, params) {
  const [{ ElMessage }, { t }] = await Promise.all([import('element-plus'), import('../../i18n/index.js')])
  ElMessage({ type, message: t(key, params) })
}

export default createGenerateActions({
  notify,
  openDirector: async (episodeId) => (await import('../../composables/useDirectorPanel.js')).openDirector(episodeId),
})
