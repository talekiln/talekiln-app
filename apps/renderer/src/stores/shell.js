import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

// 项目外壳（ProjectShell）的共享状态：当前项目、分集、资产计数、质量档、任务数、渲染核心状态。
// 接口访问通过可注入的 api 完成（默认 shell/api.js，懒加载），因此本文件可直接在 node --test 下运行。

let injected = null
let defaultApi = null
export function setShellApi(api) {
  injected = api
}
async function api() {
  if (injected) return injected
  if (!defaultApi) defaultApi = (await import('../shell/api.js')).shellApi
  return defaultApi
}

export const VIEWS = ['script', 'storyboard', 'timeline', 'canvas']
const LAST_KEY = (dramaId) => `talekiln.shell.last.${dramaId}`
const QUALITY_KEY = (dramaId) => `talekiln.quality.${dramaId}`

function lsGet(key) {
  try { return globalThis.localStorage?.getItem(key) ?? null } catch (_) { return null }
}
function lsSet(key, value) {
  try { globalThis.localStorage?.setItem(key, value) } catch (_) { /* 隐私模式 / 被禁用：忽略 */ }
}

export const useShellStore = defineStore('shell', () => {
  const dramaId = ref(null)
  const drama = ref(null)
  const episodes = ref([])
  const assetCounts = ref({ characters: 0, scenes: 0, props: 0 })
  const quality = ref('final')
  const tasksRunning = ref(0)
  const renderCoreOk = ref(true)
  const loading = ref(false)
  const loadError = ref('')
  // 视图间共享的 UI 开关：待生成徽标 -> 各视图只看过期；左栏资产 -> 打开资产面板
  const staleOnly = ref(false)
  const assetsPanelOpen = ref(false)

  const aspectRatio = computed(() => drama.value?.metadata?.aspect_ratio || '')
  const style = computed(() => drama.value?.style || '')

  let loadToken = 0

  async function loadProject(id) {
    const token = ++loadToken
    const switching = String(dramaId.value) !== String(id)
    dramaId.value = id
    if (switching) {
      drama.value = null
      episodes.value = []
      assetCounts.value = { characters: 0, scenes: 0, props: 0 }
      staleOnly.value = false
      assetsPanelOpen.value = false
    }
    loading.value = true
    loadError.value = ''
    try {
      const a = await api()
      const d = await a.getDrama(id)
      if (token !== loadToken) return
      drama.value = d
      episodes.value = [...(d?.episodes || [])].sort((x, y) => (x.episode_number || 0) - (y.episode_number || 0))
      assetCounts.value = {
        characters: (d?.characters || []).length,
        scenes: (d?.scenes || []).length,
        props: (d?.props || []).length,
      }
      const local = lsGet(QUALITY_KEY(id))
      quality.value = d?.quality === 'draft' || d?.quality === 'final' ? d.quality : local === 'draft' ? 'draft' : 'final'
      const first = episodes.value[0]
      if (first) {
        try {
          const ok = await a.renderCoreOk(first.id)
          if (token === loadToken) renderCoreOk.value = ok !== false
        } catch (_) { /* 未知：保持乐观 */ }
      }
    } catch (e) {
      if (token !== loadToken) return
      loadError.value = e?.message || String(e)
    } finally {
      if (token === loadToken) loading.value = false
    }
  }

  /** 返回 true=已应用。404（接口还没有）时只在本地保存。 */
  async function setQuality(q) {
    if (q !== 'draft' && q !== 'final') return false
    const prev = quality.value
    quality.value = q
    try {
      await (await api()).putQuality(dramaId.value, q)
      lsSet(QUALITY_KEY(dramaId.value), q)
      return true
    } catch (e) {
      if (e?.response?.status === 404) {
        lsSet(QUALITY_KEY(dramaId.value), q)
        return true
      }
      quality.value = prev
      return false
    }
  }

  function rememberView(id, episodeId, view) {
    if (!id || !episodeId || !VIEWS.includes(view)) return
    lsSet(LAST_KEY(id), JSON.stringify({ episodeId: Number(episodeId), view }))
  }

  /** { episodeId, view } | null */
  function lastView(id) {
    const raw = lsGet(LAST_KEY(id))
    if (!raw) return null
    try {
      const v = JSON.parse(raw)
      if (v && Number.isInteger(v.episodeId) && VIEWS.includes(v.view)) return { episodeId: v.episodeId, view: v.view }
    } catch (_) { /* 损坏的记录 */ }
    return null
  }

  /** `/p/:dramaId` 的落点：记住的集和视图（集仍存在）-> 第 1 集剧本 -> 没有剧集时的资产页。需先 loadProject。 */
  function landingPath(id) {
    const eps = String(dramaId.value) === String(id) ? episodes.value : []
    const last = lastView(id)
    if (last && eps.some((e) => e.id === last.episodeId)) return `/p/${id}/e/${last.episodeId}/${last.view}`
    if (eps.length) return `/p/${id}/e/${eps[0].id}/script`
    return `/p/${id}/assets`
  }

  async function refreshTasks() {
    try {
      tasksRunning.value = Number(await (await api()).runningTaskCount()) || 0
    } catch (_) { /* 保持上一次的数字 */ }
  }

  const setStaleOnly = (v) => { staleOnly.value = !!v }
  const openAssetsPanel = () => { assetsPanelOpen.value = true }
  const closeAssetsPanel = () => { assetsPanelOpen.value = false }

  return {
    dramaId, drama, episodes, assetCounts, quality, tasksRunning, renderCoreOk, loading, loadError,
    staleOnly, assetsPanelOpen, aspectRatio, style,
    loadProject, setQuality, rememberView, lastView, landingPath, refreshTasks,
    setStaleOnly, openAssetsPanel, closeAssetsPanel,
  }
})
