// 分集读写（PUT /dramas/:id/episodes 的安全封装），无 @ 别名依赖，便于 node --test。
// 后端 saveEpisodes 按 episode_number upsert，并软删除“提交里没有的集号”，所以：
//  - 每次操作都先重新取一遍完整列表再改，绝不拿页面上缓存的旧列表去覆盖；
//  - 集号不重排（id 钉在集号上）；
//  - 报错带 .code，界面据此给出可读提示。
import {
  affectedEpisodeIds,
  episodesPayload,
  reorderRows,
  withAppended,
  withContent,
  withRenamed,
  withoutEpisode,
} from '../utils/scriptTools.js'

const fail = (code, message) => Object.assign(new Error(message || code), { code })
const byNumber = (list) => [...(list || [])].sort((a, b) => (a.episode_number || 0) - (b.episode_number || 0))

// countShots(episodeId) 可选：除了旧表 storyboards，再问内核图有没有镜头（返回数字；未知返回 0）。
export function createEpisodesApi({ getDrama, saveEpisodes, countShots = null }) {
  async function fresh(dramaId) {
    const d = await getDrama(dramaId)
    return byNumber(d?.episodes)
  }

  async function commit(dramaId, rows) {
    await saveEpisodes(dramaId, rows)
    return fresh(dramaId)
  }

  const find = (list, id) => list.find((e) => String(e.id) === String(id)) || null

  return {
    list: fresh,

    async add(dramaId, { title = '', script_content = '' } = {}) {
      const before = await fresh(dramaId)
      const episodes = await commit(dramaId, withAppended(before, [{ title, script_content }]))
      const known = new Set(before.map((e) => e.episode_number))
      return { episodes, episode: episodes.find((e) => !known.has(e.episode_number)) || null }
    },

    async append(dramaId, items) {
      const before = await fresh(dramaId)
      if (!items || !items.length) return { episodes: before, added: [] }
      const episodes = await commit(dramaId, withAppended(before, items))
      const known = new Set(before.map((e) => e.episode_number))
      return { episodes, added: episodes.filter((e) => !known.has(e.episode_number)) }
    },

    async rename(dramaId, episodeId, title) {
      const before = await fresh(dramaId)
      const rows = withRenamed(before, episodeId, title)
      if (!rows) throw fail('EPISODE_NOT_FOUND')
      const episodes = await commit(dramaId, rows)
      return { episodes, episode: find(episodes, episodeId) }
    },

    async remove(dramaId, episodeId) {
      const before = await fresh(dramaId)
      if (!find(before, episodeId)) throw fail('EPISODE_NOT_FOUND')
      if (before.length <= 1) throw fail('LAST_EPISODE')
      const episodes = await commit(dramaId, withoutEpisode(before, episodeId))
      return { episodes }
    },

    async setContent(dramaId, episodeId, patch) {
      const before = await fresh(dramaId)
      const rows = withContent(before, episodeId, patch)
      if (!rows) throw fail('EPISODE_NOT_FOUND')
      const episodes = await commit(dramaId, rows)
      return { episodes, episode: find(episodes, episodeId) }
    },

    /**
     * 按新的 id 顺序重排。集号槽位不动、内容换位，所以已有镜头（挂在 episode id 上）的集不能动。
     * 返回 changed：内容真的换了位置的集（调用方据此同步内核剧本行）。
     */
    async reorder(dramaId, orderIds) {
      const before = await fresh(dramaId)
      const rows = reorderRows(before, orderIds)
      if (!rows) throw fail('BAD_ORDER')
      const slotIds = before.map((e) => e.id)
      const moved = before.filter((e, i) => String(orderIds[i]) !== String(slotIds[i]))
      if (moved.some((e) => (e.storyboards || []).length > 0)) throw fail('EPISODE_HAS_SHOTS')
      if (countShots) {
        for (const e of moved) if ((await countShots(e.id)) > 0) throw fail('EPISODE_HAS_SHOTS')
      }
      const episodes = await commit(dramaId, rows)
      const changed = episodes.filter((e) => moved.some((m) => String(m.id) === String(e.id)))
      return { episodes, changed }
    },

    affectedEpisodeIds,
    episodesPayload,
  }
}
