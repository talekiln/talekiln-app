import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import { KINDS, assetCounts, resolveMention as resolveMentionIn, refsForShot, serializeAssetPatch } from '../utils/assets.js'
import { classifyGenerationError, generationGate, taskIdOf, waitForTask } from '../utils/assetGeneration.js'
import { lockBody } from '../utils/referenceLibrary.js'
import { useShellStore } from './shell.js'

// 项目资产（角色 / 场景 / 道具）的全局状态：资产面板、资产库页、分镜检查器、提示词编辑器共用。
// 接口访问通过可注入的 api 完成（默认 api/assets.js，懒加载），因此本文件可直接在 node --test 下运行。

let injected = null
let defaultApi = null
export function setAssetsApi(api) {
  injected = api
}
async function api() {
  if (injected) return injected
  if (!defaultApi) defaultApi = (await import('../api/assets.js')).assetsApi
  return defaultApi
}

// 后端的参考图锁定只支持角色和场景；道具没有锁定
const LOCK_TYPE = { characters: 'character', scenes: 'scene' }
const key = (kind, id) => `${kind}:${id}`

export const useAssetsStore = defineStore('assets', () => {
  const dramaId = ref(null)
  const characters = ref([])
  const scenes = ref([])
  const props = ref([])
  const locks = ref({}) // `${kind}:${id}` -> lock
  const loading = ref(false)
  const loadError = ref('')
  // 资产出图开关：null = 未知，true / false 来自 GET /episodes/:id/generation/status 的 legacy_enabled
  const legacyEnabled = ref(null)
  const generating = reactive({})
  const genErrors = reactive({})

  const byKind = computed(() => ({ characters: characters.value, scenes: scenes.value, props: props.value }))
  const counts = computed(() => assetCounts(byKind.value))
  const gate = computed(() => generationGate(legacyEnabled.value))

  let loadToken = 0

  function listRef(kind) {
    return kind === 'characters' ? characters : kind === 'scenes' ? scenes : props
  }

  function syncShell() {
    try {
      const shell = useShellStore()
      if (String(shell.dramaId) === String(dramaId.value)) shell.assetCounts = { ...counts.value }
    } catch (_) { /* 外壳状态不可用时忽略 */ }
  }

  async function fetchLocks(a, lists) {
    const out = {}
    for (const kind of Object.keys(LOCK_TYPE)) {
      const ids = (lists[kind] || []).map((x) => x.id)
      if (!ids.length || typeof a.listLocks !== 'function') continue
      try {
        const rows = await a.listLocks(LOCK_TYPE[kind], ids)
        for (const l of Array.isArray(rows) ? rows : []) out[key(kind, l.entity_id)] = l
      } catch (_) { /* 锁定状态读取失败：当作未锁定 */ }
    }
    return out
  }

  async function load(id) {
    const token = ++loadToken
    const switching = String(dramaId.value) !== String(id)
    dramaId.value = id
    if (switching) {
      characters.value = []
      scenes.value = []
      props.value = []
      locks.value = {}
      legacyEnabled.value = null
      for (const k of Object.keys(generating)) delete generating[k]
      for (const k of Object.keys(genErrors)) delete genErrors[k]
    }
    loading.value = true
    loadError.value = ''
    try {
      const a = await api()
      const all = await a.loadAll(id)
      if (token !== loadToken) return
      const lists = { characters: all?.characters || [], scenes: all?.scenes || [], props: all?.props || [] }
      const lk = await fetchLocks(a, lists)
      if (token !== loadToken) return
      characters.value = lists.characters
      scenes.value = lists.scenes
      props.value = lists.props
      locks.value = lk
      syncShell()
    } catch (e) {
      if (token === loadToken) loadError.value = (e && e.message) || String(e)
    } finally {
      if (token === loadToken) loading.value = false
    }
  }

  function reload() {
    return dramaId.value == null ? Promise.resolve() : load(dramaId.value)
  }

  function find(kind, id) {
    return listRef(kind).value.find((x) => Number(x.id) === Number(id)) || null
  }

  /** ctx.episodeId：场景 / 道具创建时关联的分集（角色不带分集，避免改动分集角色关联）。 */
  async function create(kind, data, ctx = {}) {
    const a = await api()
    let item = await a.create(kind, dramaId.value, data, ctx)
    if (item && item.id != null) {
      listRef(kind).value = [...listRef(kind).value, item]
      syncShell()
      return item
    }
    await reload()
    const wantName = data?.name ?? data?.location
    const list = listRef(kind).value
    item = [...list].reverse().find((x) => (x.name ?? x.location) === wantName) || null
    return item
  }

  async function update(kind, id, patch) {
    const a = await api()
    const body = serializeAssetPatch(patch)
    const res = await a.update(kind, id, body)
    const cur = find(kind, id)
    const next = { ...(cur || { id }), ...body, ...(res && typeof res === 'object' && res.id != null ? res : {}) }
    listRef(kind).value = cur ? listRef(kind).value.map((x) => (Number(x.id) === Number(id) ? next : x)) : [...listRef(kind).value, next]
    return next
  }

  async function remove(kind, id) {
    const a = await api()
    await a.remove(kind, id)
    listRef(kind).value = listRef(kind).value.filter((x) => Number(x.id) !== Number(id))
    const l = { ...locks.value }
    delete l[key(kind, id)]
    locks.value = l
    syncShell()
  }

  // ---- 参考图锁定（角色 / 场景）----
  const lockOf = (kind, id) => locks.value[key(kind, id)] || null
  const isLocked = (kind, id) => !!lockOf(kind, id)

  /** candidate：已完成的候选图（{ id, image_url, local_path }）。道具不支持锁定。 */
  async function lock(kind, id, candidate) {
    const type = LOCK_TYPE[kind]
    if (!type) return { ok: false, reason: 'unsupported' }
    const a = await api()
    const res = await a.lock(type, id, lockBody(candidate))
    locks.value = { ...locks.value, [key(kind, id)]: res || { entity_id: id, ...lockBody(candidate) } }
    return { ok: true, lock: locks.value[key(kind, id)] }
  }

  async function unlock(kind, id) {
    const type = LOCK_TYPE[kind]
    if (!type) return { ok: false, reason: 'unsupported' }
    const a = await api()
    await a.unlock(type, id)
    const l = { ...locks.value }
    delete l[key(kind, id)]
    locks.value = l
    return { ok: true }
  }

  // ---- 引用 ----
  const resolveMention = (token) => resolveMentionIn(token, byKind.value)
  const refs = (shot) => refsForShot(shot, byKind.value)

  // ---- 资产出图（旧同步路由，受 legacy_enabled 限制）----
  async function refreshGate(episodeId) {
    if (episodeId == null || episodeId === '') {
      legacyEnabled.value = null
      return null
    }
    try {
      const a = await api()
      const v = await a.legacyEnabled(episodeId)
      legacyEnabled.value = v === true ? true : v === false ? false : null
    } catch (_) {
      legacyEnabled.value = null
    }
    return legacyEnabled.value
  }

  const isGenerating = (kind, id) => !!generating[key(kind, id)]
  const genError = (kind, id) => genErrors[key(kind, id)] || null
  function clearGenError(kind, id) {
    delete genErrors[key(kind, id)]
  }

  async function generate(kind, id, opts = {}, pollOpts = {}) {
    const g = gate.value
    if (!g.allowed) return { ok: false, reasonKey: g.reasonKey }
    const k = key(kind, id)
    if (generating[k]) return { ok: false, reasonKey: 'assets.gen.busy' }
    const item = find(kind, id)
    if (!item) return { ok: false, reasonKey: 'assets.gen.missing' }
    delete genErrors[k]
    generating[k] = true
    try {
      const a = await api()
      const res = await a.generateImage(kind, item, opts)
      const taskId = taskIdOf(res)
      if (taskId) {
        const out = await waitForTask(() => a.getTask(taskId), pollOpts)
        if (out.status === 'failed' || out.status === 'timeout') {
          genErrors[k] = { type: 'other', messageKey: out.status === 'timeout' ? 'assets.gen.timeout' : null, message: out.error || '' }
          return { ok: false, status: out.status }
        }
      }
      await reload()
      return { ok: true }
    } catch (e) {
      genErrors[k] = classifyGenerationError(e)
      return { ok: false, status: 'error' }
    } finally {
      delete generating[k]
    }
  }

  return {
    dramaId, characters, scenes, props, locks, loading, loadError, legacyEnabled, generating, genErrors,
    byKind, counts, gate,
    load, reload, find, create, update, remove,
    lockOf, isLocked, lock, unlock,
    resolveMention, refs,
    refreshGate, isGenerating, genError, clearGenError, generate,
    KINDS,
  }
})
