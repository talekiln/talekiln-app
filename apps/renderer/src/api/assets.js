import request from '@/utils/request'
import { dramaAPI } from '@/api/drama'
import { characterAPI } from '@/api/characters'
import { sceneAPI } from '@/api/scenes'
import { propAPI } from '@/api/props'
import { referenceLocksAPI } from '@/api/referenceLocks'
import { buildAssetImageRequest } from '@/utils/assetGeneration'

// 资产 store 的默认接口实现（测试里用 setAssetsApi 注入替身）。
// 出图与任务轮询用 silentError：失败由资产卡片内联展示，不弹全局错误（尤其是 402 花费上限）。

const IMAGE_FIELDS = ['local_path', 'image_url', 'extra_images', 'ref_image']

function pick(obj, keys) {
  const out = {}
  for (const k of keys) if (k in obj) out[k] = obj[k]
  return out
}

export const assetsApi = {
  async loadAll(dramaId) {
    const [characters, scenes, props] = await Promise.all([
      request.get(`/dramas/${dramaId}/characters`),
      sceneAPI.list(dramaId),
      propAPI.list(dramaId),
    ])
    const arr = (v, k) => (Array.isArray(v) ? v : Array.isArray(v?.[k]) ? v[k] : [])
    return { characters: arr(characters, 'characters'), scenes: arr(scenes, 'scenes'), props: arr(props, 'props') }
  },

  async create(kind, dramaId, data, ctx = {}) {
    if (kind === 'characters') {
      // 只提交新角色：不带 episode_id，所以不会改动任何分集的角色关联
      await dramaAPI.saveCharacters(dramaId, { characters: [data] })
      return null // store 会重新加载并按名字找到它
    }
    const res = kind === 'scenes'
      ? await sceneAPI.create({ ...data, drama_id: Number(dramaId) })
      : await propAPI.create({ ...data, drama_id: Number(dramaId) })
    return res?.scene || res?.prop || res
  },

  async update(kind, id, patch) {
    if (kind === 'characters') {
      const image = pick(patch, IMAGE_FIELDS)
      const text = { ...patch }
      for (const k of IMAGE_FIELDS) delete text[k]
      if (Object.keys(text).length) await characterAPI.update(id, text)
      if (Object.keys(image).length) await characterAPI.putImage(id, image)
      return null
    }
    return kind === 'scenes' ? sceneAPI.update(id, patch) : propAPI.update(id, patch)
  },

  async remove(kind, id) {
    if (kind === 'characters') return characterAPI.delete(id)
    return kind === 'scenes' ? sceneAPI.delete(id) : propAPI.delete(id)
  },

  async listLocks(type, ids) {
    const res = await referenceLocksAPI.list(type, ids)
    return Array.isArray(res) ? res : res?.locks || res?.items || []
  },
  lock: (type, id, body) => referenceLocksAPI.lock(type, id, body),
  unlock: (type, id) => referenceLocksAPI.unlock(type, id),

  /** GET /episodes/:id/generation/status -> legacy_enabled；失败返回 null（未知，按禁用处理）。 */
  async legacyEnabled(episodeId) {
    try {
      const s = await request.get(`/episodes/${episodeId}/generation/status`, { silentError: true })
      return typeof s?.legacy_enabled === 'boolean' ? s.legacy_enabled : null
    } catch (_) {
      return null
    }
  },

  generateImage(kind, item, opts = {}) {
    const r = buildAssetImageRequest(kind, item, opts)
    return request.post(r.url, r.body, { silentError: true })
  },

  getTask(taskId) {
    return request.get(`/tasks/${taskId}`, { silentError: true })
  },

  /** 候选参考图（POST /images，旧同步路径，受花费上限约束）：失败由调用方内联展示。 */
  createCandidate(body) {
    return request.post('/images', body, { silentError: true })
  },
  getCandidate(id) {
    return request.get(`/images/${id}`, { silentError: true })
  },
}
