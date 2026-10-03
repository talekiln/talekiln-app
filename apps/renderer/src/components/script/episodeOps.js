// 分集管理的界面级操作：弹确认 / 提示、写接口、刷新外壳。action、管理对话框、剧本视图共用。
import { ElMessage, ElMessageBox } from 'element-plus'
import { t } from '@/i18n'
import { useShellStore } from '@/stores/shell'
import { useProjectViewsStore } from '@/stores/projectViews'
import { episodesAPI, scriptSync } from '@/api/episodes'

const ERROR_KEY = {
  EPISODE_NOT_FOUND: 'script.episode.err.notFound',
  LAST_EPISODE: 'script.episode.err.last',
  EPISODE_HAS_SHOTS: 'script.episode.err.hasShots',
  BAD_ORDER: 'script.episode.err.badOrder',
}

export function errorText(e) {
  const key = ERROR_KEY[e?.code]
  return key ? t(key) : e?.message || String(e)
}

export const episodeLabel = (e) => t('shell.episode.label', { n: e?.episode_number ?? '' })
export const episodeName = (e) => (e?.title ? t('shell.episode.labelTitled', { n: e.episode_number, title: e.title }) : episodeLabel(e))

/** 写完分集后刷新外壳（左栏 / 顶栏 / 分集下拉）。 */
export const reloadShell = (dramaId) => useShellStore().loadProject(dramaId)

export function gotoEpisode(router, dramaId, episodeId, view = 'script', replace = false) {
  const to = { name: `episode-${view}`, params: { dramaId, episodeId } }
  return replace ? router.replace(to) : router.push(to)
}

export async function addEpisode({ dramaId, router = null, title = '' }) {
  const next = (await episodesAPI.list(dramaId)).reduce((m, e) => Math.max(m, Number(e.episode_number) || 0), 0) + 1
  const r = await episodesAPI.add(dramaId, { title: title || t('script.episode.defaultTitle', { n: next }) })
  await reloadShell(dramaId)
  ElMessage.success(t('script.episode.added', { n: r.episode?.episode_number ?? next }))
  if (router && r.episode) await gotoEpisode(router, dramaId, r.episode.id)
  return r
}

/** 返回新标题；取消返回 null。 */
export async function renameEpisode({ dramaId, episode }) {
  let value
  try {
    const r = await ElMessageBox.prompt(t('script.episode.renamePrompt', { name: episodeLabel(episode) }), t('script.episode.rename'), {
      inputValue: episode.title || '',
      inputPlaceholder: t('script.episode.titlePh'),
      confirmButtonText: t('common.save'),
      cancelButtonText: t('common.cancel'),
      inputValidator: (v) => String(v ?? '').length <= 100 || t('script.episode.titleTooLong'),
    })
    value = String(r.value ?? '').trim()
  } catch (_) {
    return null
  }
  await episodesAPI.rename(dramaId, episode.id, value)
  await reloadShell(dramaId)
  ElMessage.success(t('script.episode.renamed'))
  return value
}

/** 确认后删除；返回 { deleted, next }，取消返回 null。next 是应当跳转到的相邻集（可能为 null）。 */
export async function deleteEpisode({ dramaId, episode }) {
  try {
    await ElMessageBox.confirm(t('script.episode.deleteConfirm', { name: episodeName(episode) }), t('script.episode.delete'), {
      type: 'warning',
      confirmButtonText: t('common.delete'),
      cancelButtonText: t('common.cancel'),
    })
  } catch (_) {
    return null
  }
  const before = await episodesAPI.list(dramaId)
  const idx = before.findIndex((e) => String(e.id) === String(episode.id))
  const r = await episodesAPI.remove(dramaId, episode.id)
  await reloadShell(dramaId)
  ElMessage.success(t('script.episode.deleted'))
  const next = r.episodes[Math.min(Math.max(idx, 0), r.episodes.length - 1)] || null
  return { deleted: episode, next }
}

/**
 * 把第 from 集挪到第 to 的位置（按集号顺序的下标）。已有镜头的集不能动（后端 id 钉在集号上，镜头会跟错集）。
 * 内容换位后，受影响各集的内核剧本行同步重建。
 */
export async function moveEpisode({ dramaId, orderIds }) {
  const r = await episodesAPI.reorder(dramaId, orderIds)
  const views = useProjectViewsStore()
  for (const e of r.changed) {
    try { await scriptSync.replaceGraphLines(e.id, e.script_content || '', 'reorder episodes') } catch (_) { /* 行同步失败不影响分集顺序 */ }
  }
  if (r.changed.some((e) => e.id === views.episodeId)) await views.refresh()
  await reloadShell(dramaId)
  return r
}
