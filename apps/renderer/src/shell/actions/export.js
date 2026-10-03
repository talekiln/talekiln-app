// export lane 的 action 表：导出菜单 8 项。逻辑在 components/export/exportActions.js（依赖注入，有单测），
// 这里只接真实依赖。所有 @/ 引用都延迟加载，保证本文件可在 node --test 下被加载。
import { createExportActions, loadSheetData } from '../../components/export/exportActions.js'
import { exportStoryboardSheet } from '../../utils/exportStoryboardSheet.js'

async function notify(type, key, params) {
  const [{ ElMessage }, { t }] = await Promise.all([import('element-plus'), import('../../i18n/index.js')])
  ElMessage({ type, message: t(key, params) })
}

const lazy = (loader, pick) => async (...args) => pick(await loader())(...args)

const kernel = () => import('@/api/kernel')
const dramaMod = () => import('@/api/drama')
const sbMod = () => import('@/api/storyboards')
const home = () => import('@/components/home/homeApi')
const files = () => import('../../components/export/saveFile.js')

export default createExportActions({
  notify,
  loadTimeline: lazy(kernel, (m) => async (ep) => { const r = await m.kernelAPI.view(ep, 'timeline'); return (r && r.data) || r }), // 视图内容在 .data 里
  async loadSheetData({ dramaId, episodeId }) {
    const [{ dramaAPI }, { storyboardsAPI }] = await Promise.all([dramaMod(), sbMod()])
    return loadSheetData(
      {
        storyboards: (ep) => dramaAPI.getStoryboards(ep),
        drama: (id) => dramaAPI.get(id),
        framePrompts: (id) => storyboardsAPI.getFramePrompts(id),
      },
      { dramaId, episodeId },
    )
  },
  exportSheet: exportStoryboardSheet,
  async loadAssetPackData(episodeId) {
    const { dramaAPI } = await dramaMod()
    const res = await dramaAPI.getStoryboards(episodeId)
    return Array.isArray(res) ? res : (res && res.storyboards) || []
  },
  fetchBytes: lazy(files, (m) => m.fetchBytes),
  saveText: lazy(files, (m) => m.saveText),
  saveBytes: lazy(files, (m) => m.saveBytes),
  downloadProjectZip: lazy(home, (m) => m.downloadProjectZip),
  downloadFullBackup: lazy(home, (m) => m.downloadFullBackup),
})
