import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { kernelAPI } from '@/api/kernel'
import { dramaAPI } from '@/api/drama'
import { t } from '@/i18n'
import {
  buildIndex, focusIn, newTxId, normalizeSelection, playheadFor, reduceGraph, reduceSummary, reduceViews, sameSelection, staleCount,
} from '@/utils/projectViews'

// 四视图（剧本 / 分镜 / 时间线 / 画布）共享的项目图状态。
// 数据只来自内核 REST；所有编辑都走 POST /intent（或 /tx、/undo、/redo），完成后以服务端为准整体刷新，
// 视图自己不保存项目数据副本。共享的纯 UI 状态：选择与播放头。
export const useProjectViewsStore = defineStore('projectViews', () => {
  const episodeId = ref(null)
  const dramaId = ref(null)
  const graph = ref(null)
  const stale = ref([])
  const seq = ref(0)
  const canUndo = ref(false)
  const canRedo = ref(false)
  const views = ref({ script: null, shots: null, timeline: null, canvas: null })
  const loading = ref(false)
  const busy = ref(false)
  const error = ref('')
  /** 因撤销 / 重做而变化的次数：旧页面据此重新读取自己的旧表数据 */
  const revision = ref(0)

  // 共享 UI 状态
  const selection = ref(null)
  const playhead = ref(0)

  let queue = Promise.resolve()
  let refreshToken = 0

  const index = computed(() => buildIndex({ script: views.value.script, shots: views.value.shots, timeline: views.value.timeline, canvas: views.value.canvas }))
  const staleSet = computed(() => new Set(stale.value))
  const staleTotal = computed(() => staleCount(stale.value))
  const ready = computed(() => !!graph.value)

  /** 与当前选择对应的、某个视图里的焦点对象。 */
  function focusFor(view) {
    return focusIn(view, selection.value, index.value)
  }

  function apply(patch) {
    graph.value = patch.graph
    stale.value = patch.stale
    seq.value = patch.seq
    canUndo.value = patch.canUndo
    canRedo.value = patch.canRedo
    if (patch.views) views.value = patch.views
  }
  const snapshot = () => ({ graph: graph.value, stale: stale.value, seq: seq.value, canUndo: canUndo.value, canRedo: canRedo.value, views: views.value })

  function setError(e) {
    error.value = e?.message || t('request.opFailed')
    ElMessage.warning(error.value)
  }

  /** 把操作串行化，避免连续拖动 / 编辑时响应乱序。 */
  function serial(fn) {
    const run = queue.then(fn, fn)
    queue = run.catch(() => {})
    return run
  }

  async function fetchAll() {
    const ep = episodeId.value
    const token = ++refreshToken
    const get = async () => {
      try {
        return await kernelAPI.graph(ep)
      } catch (e) {
        if (e?.code !== 'GRAPH_NOT_FOUND' && e?.response?.status !== 404) throw e
        await kernelAPI.importLegacy(ep) // 旧剧集第一次打开：旧表 -> 项目图（幂等）
        return kernelAPI.graph(ep)
      }
    }
    const g = await get()
    const [script, shots, timeline, canvas] = await Promise.all(['script', 'shots', 'timeline', 'canvas'].map((v) => kernelAPI.view(ep, v)))
    if (token !== refreshToken || ep !== episodeId.value) return false
    const next = reduceViews(reduceGraph(snapshot(), g), { script: script.data, shots: shots.data, timeline: timeline.data, canvas: canvas.data })
    apply(next)
    const norm = normalizeSelection(selection.value, index.value)
    if (!sameSelection(norm, selection.value)) selection.value = norm
    return true
  }

  /** 重新从服务端读取图与四个视图。 */
  function refresh() {
    if (!episodeId.value) return Promise.resolve(false)
    return serial(async () => {
      try {
        error.value = ''
        return await fetchAll()
      } catch (e) {
        error.value = e?.message || t('request.loadFailed')
        return false
      }
    })
  }

  /** 进入某个剧集的任意视图时调用；剧集不变则只刷新。 */
  async function load(ep, { drama } = {}) {
    const id = Number(ep)
    if (!Number.isInteger(id) || id <= 0) return false
    if (episodeId.value !== id) {
      episodeId.value = id
      dramaId.value = null
      graph.value = null
      views.value = { script: null, shots: null, timeline: null, canvas: null }
      selection.value = null
      playhead.value = 0
      stale.value = []
      error.value = ''
    }
    if (drama) dramaId.value = Number(drama) || null
    loading.value = true
    try {
      const ok = await refresh()
      if (!ok && error.value) ElMessage.error(error.value)
      return ok
    } finally {
      loading.value = false
    }
  }

  /** 分镜页 / 路由需要 dramaId：没有时从项目列表里按剧集查。 */
  async function resolveDrama(ep = episodeId.value) {
    if (dramaId.value && episodeId.value === Number(ep)) return dramaId.value
    try {
      const res = await dramaAPI.list({ page: 1, page_size: 200 })
      const items = Array.isArray(res) ? res : res?.items || res?.dramas || []
      const hit = items.find((d) => (d.episodes || []).some((e) => Number(e.id) === Number(ep)))
      if (hit && episodeId.value === Number(ep)) dramaId.value = hit.id
      return hit ? hit.id : null
    } catch (_) {
      return null
    }
  }

  async function mutate(call) {
    return serial(async () => {
      busy.value = true
      try {
        error.value = ''
        const sum = await call()
        apply({ ...reduceSummary(snapshot(), sum), views: views.value })
        await fetchAll()
        return sum
      } catch (e) {
        setError(e)
        try { await fetchAll() } catch (_) { /* 保持旧状态 */ }
        return null
      } finally {
        busy.value = false
      }
    })
  }

  /** 视图意图：POST /intent。成功返回内核摘要（meta 里带新建节点 id），失败返回 null（已提示）。 */
  function intent(view, name, args) {
    const ep = episodeId.value
    return mutate(() => kernelAPI.intent(ep, view, name, args, newTxId(`${view}.${name}`)))
  }

  /** 原始 op 事务（画布属性面板里内核未提供意图的字段）。 */
  function tx(label, ops) {
    const ep = episodeId.value
    return mutate(() => kernelAPI.tx(ep, newTxId('tx'), label, ops))
  }

  function setParam(nodeId, patch) {
    return tx('改节点参数', // i18n-ignore: 事务名是存进内核 / 版本历史的标识，history.tx.* 按它查译文
      Object.entries(patch).map(([k, v]) => ({ op: 'setParam', node: nodeId, path: [k], value: v })))
  }

  async function undo() {
    if (!canUndo.value) return null
    const ep = episodeId.value
    const r = await mutate(() => kernelAPI.undo(ep))
    if (r) revision.value += 1
    return r
  }
  async function redo() {
    if (!canRedo.value) return null
    const ep = episodeId.value
    const r = await mutate(() => kernelAPI.redo(ep))
    if (r) revision.value += 1
    return r
  }

  /** 选择：{kind,id} | null。选到有时间的镜头 / 片段时同步播放头。 */
  function select(sel, { playhead: follow = true } = {}) {
    selection.value = sel || null
    if (sel && follow) {
      const p = playheadFor(sel, index.value)
      if (p != null) playhead.value = p
    }
  }
  function setPlayhead(ms) {
    playhead.value = Math.max(0, Math.round(Number(ms) || 0))
  }

  return {
    episodeId, dramaId, graph, stale, seq, canUndo, canRedo, views, loading, busy, error, revision, selection, playhead,
    index, staleSet, staleTotal, ready,
    focusFor, load, refresh, resolveDrama, intent, tx, setParam, undo, redo, select, setPlayhead,
  }
})
