// storyboard lane 的 action 表：{ 'action.id': (ctx) => void | Promise<void> }
// ctx = { router, route, dramaId, episodeId, openDialog, store }。由 actions/index.js 统一注册。
// 只有 storyboard lane 修改本文件。
import { ElMessage } from 'element-plus'
import { t } from '../../i18n/index.js'
import { runStoryboardGenerate } from '../../components/shot/storyboardGenerate.js'
import { storyboardsAPI } from '../../api/storyboards.js'
import { useProjectViewsStore } from '../../stores/projectViews.js'
import { flatShots, planAdd } from '../../components/shot/shotWrite.js'

async function goStoryboard(ctx) {
  const { router, route, dramaId, episodeId } = ctx
  if (route && route.name === 'episode-storyboard') return
  if (router && dramaId && episodeId) await router.push({ name: 'episode-storyboard', params: { dramaId, episodeId } })
}

export default {
  // 从剧本生成分镜（还没有分镜时）。会话内是一个可撤销的内核事务。
  'storyboard.generate': async (ctx) => {
    const r = await runStoryboardGenerate(ctx, { regenerate: false })
    if (r.ok) await goStoryboard(ctx)
  },
  // 重新生成：已有分镜时先确认；成功后提示“可撤销恢复上一版”。
  'storyboard.regenerate': async (ctx) => {
    const r = await runStoryboardGenerate(ctx, { regenerate: true })
    if (r.ok) await goStoryboard(ctx)
  },
  // 批量推断镜头参数（景别 / 运镜 / 角度等），不覆盖已有值。
  'storyboard.inferParams': async (ctx) => {
    if (!ctx.episodeId) return
    const res = await storyboardsAPI.batchInferParams(ctx.episodeId, false)
    const n = (res && (res.updated ?? res.count)) ?? null
    await useProjectViewsStore().refresh()
    ElMessage.success(n == null ? t('storyboard.infer.done') : t('storyboard.infer.doneCount', { n }))
  },
  // 在当前聚焦镜头之后（否则末尾）添加一个镜头，并选中它。
  'storyboard.addShot': async (ctx) => {
    const views = useProjectViewsStore()
    const groups = (views.views.shots && views.views.shots.groups) || []
    const focus = views.focusFor('shots')
    const at = planAdd(groups, focus && focus.id)
    if (!at) {
      ElMessage.warning(t('storyboard.add.noGroup'))
      return
    }
    const before = new Set(flatShots(groups))
    const res = await views.intent('shot', 'addShot', { group: at.group, index: at.index, params: { duration_ms: 3000 } })
    if (!res) return
    const fresh = flatShots((views.views.shots && views.views.shots.groups) || []).find((id) => !before.has(id))
    const id = (res.meta && res.meta.shot_id) || fresh
    if (id) views.select({ kind: 'shot', id })
  },
}
