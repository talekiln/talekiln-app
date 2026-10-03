// 剧本 lane 的接口封装：分集增删改排、剧本行同步、AI 写剧本（同步）、小说导入、剧本库。
import request from '@/utils/request'
import { dramaAPI } from './drama'
import { kernelAPI } from './kernel'
import { createEpisodesApi } from './episodesCore.js'
import { scriptReplaceOps, scriptTextOfView, shotCountOfView } from '@/utils/scriptTools'

async function kernelShotCount(episodeId) {
  try {
    const r = await kernelAPI.view(episodeId, 'shots')
    return shotCountOfView(r?.data || r)
  } catch (_) {
    return 0 // 还没有图（旧剧集第一次打开前）：没有镜头
  }
}

export const episodesAPI = createEpisodesApi({
  getDrama: (id) => dramaAPI.get(id),
  saveEpisodes: (id, rows) => dramaAPI.saveEpisodes(id, rows),
  countShots: kernelShotCount,
})

export { kernelShotCount }

const newTxId = (label) => `script.${label}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

/** 内核图不存在（旧项目还没导入）时返回 null，不算错误。 */
async function graphOrNull(episodeId) {
  try {
    const r = await kernelAPI.graph(episodeId)
    return r?.graph || r || null
  } catch (e) {
    const status = e?.response?.status
    const code = e?.response?.data?.error?.code || e?.code
    if (status === 404 || code === 'GRAPH_NOT_FOUND') return null
    throw e
  }
}

export const scriptSync = {
  /**
   * 把正文写进内核剧本行（整体替换，可撤销）。没有图 -> 'no_graph'；已有镜头 -> 'has_shots'（不动）；否则 'replaced'。
   */
  async replaceGraphLines(episodeId, text, label = 'replace script') {
    const graph = await graphOrNull(episodeId)
    if (!graph) return 'no_graph'
    const r = scriptReplaceOps(graph, text)
    if (!r.ok) return r.error
    await kernelAPI.tx(episodeId, newTxId('replace'), label, r.ops)
    return 'replaced'
  },

  /** 把内核剧本行序列化回文字（用于写回 episodes.script_content，分镜生成读的是这份正文）。 */
  async textFromGraph(episodeId) {
    const r = await kernelAPI.view(episodeId, 'script')
    const view = r?.data || r
    return view?.groups ? scriptTextOfView(view) : null
  },

  /** 行 -> 正文：返回 false 表示没有图可同步。 */
  async pushContent(dramaId, episodeId) {
    let text
    try { text = await scriptSync.textFromGraph(episodeId) } catch (_) { return false }
    if (text === null) return false
    await episodesAPI.setContent(dramaId, episodeId, { script_content: text })
    return true
  },
}

export const scriptAPI = {
  /** 同步写故事：不带 drama_id（带了就会异步覆盖并软删除其余分集）。signal 用于取消。 */
  generateStory(body, { signal } = {}) {
    const { drama_id: _ignored, ...rest } = body || {}
    return request.post('/generation/story', rest, { signal })
  },

  /** 小说导入：服务端按规则识别章节，可选 AI 摘要。返回章节数组 [{title, content, script?}]。 */
  async importNovel({ text, fileBlob, fileName, title, maxChapters = 10, aiSummarize = false }) {
    const form = new FormData()
    if (fileBlob) form.append('file', fileBlob, fileName || 'novel.txt')
    else form.append('text', text)
    form.append('title', title || '')
    form.append('max_chapters', String(Math.min(20, Math.max(1, Math.floor(Number(maxChapters)) || 10))))
    form.append('ai_summarize', String(!!aiSummarize))
    const { default: axios } = await import('axios')
    const baseURL = request.defaults.baseURL || '/api/v1'
    const res = await axios.post(`${baseURL}/dramas/import-novel`, form, { headers: { 'Content-Type': 'multipart/form-data' } })
    return res.data?.data?.chapters || res.data?.chapters || []
  },

  /** 剧本库：metadata.script_template === true 的项目。 */
  async listTemplates() {
    const res = await dramaAPI.list({ page: 1, page_size: 100 })
    const items = Array.isArray(res) ? res : res?.items || []
    return items.filter((d) => d?.metadata?.script_template === true)
  },
}
