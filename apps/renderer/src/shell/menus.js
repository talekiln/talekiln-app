// 顶栏“生成▾ / 导出▾”菜单的数据表。文案全部走 shell.menu.* 翻译 key；
// 各 lane 用与菜单项同名的 action id 通过 registerAction 注册处理函数。
//
// requires（可为字符串或数组）：
//   'episode'    需要当前有一集
//   'shots'      当前集至少有一个镜头
//   'timeline'   当前集已有时间线
//   'renderCore' 渲染核心可用（GET /export/options 不是 CORE_UNAVAILABLE）
//   'draft'      当前集存在“草稿档”产物（plan 之外新增的取值，供 generate.rerunDraft 使用）
// 不写 requires（null）表示项目级操作，不依赖当前集。

const item = (id, group, requires = null) => ({
  id,
  group,
  labelKey: `shell.menu.${id}`,
  descKey: `shell.menu.${id}.desc`,
  action: id,
  requires,
})

export const GENERATE_MENU = [
  item('generate.pipeline', 'run', 'shots'),
  item('generate.missing', 'run', 'shots'),
  item('generate.allFirstFrames', 'batch', 'shots'),
  item('generate.allVideos', 'batch', 'shots'),
  item('generate.allVoice', 'batch', 'shots'),
  item('generate.director', 'batch', 'episode'),
  item('generate.batchEpisodes', 'project'),
  item('generate.rerunDraft', 'quality', 'draft'),
]

export const EXPORT_MENU = [
  item('export.video', 'video', 'renderCore'),
  item('export.jianying', 'editor', 'timeline'),
  item('export.premiere', 'editor', 'timeline'),
  item('export.srt', 'editor', 'timeline'),
  item('export.storyboardSheet', 'sheet', 'shots'),
  item('export.projectZip', 'project'),
  item('export.assetPack', 'project'),
  item('export.fullBackup', 'project'),
]

export const MENU_GROUP_KEY = (menu, group) => `shell.menu.group.${menu}.${group}`

const REASON = {
  episode: 'shell.menu.reason.episode',
  shots: 'shell.menu.reason.shots',
  timeline: 'shell.menu.reason.timeline',
  renderCore: 'shell.menu.reason.renderCore',
  draft: 'shell.menu.reason.draft',
}

const CHECKS = {
  episode: (c) => !!c.episodeId,
  shots: (c) => !!c.episodeId && Number(c.shotCount) > 0,
  timeline: (c) => !!c.episodeId && !!c.hasTimeline,
  renderCore: (c) => !!c.episodeId && !!c.renderCoreOk,
  draft: (c) => !!c.episodeId && Number(c.draftCount) > 0,
}

/**
 * @param {{requires?: string|string[]|null}} entry
 * @param {{episodeId?, shotCount?, hasTimeline?, renderCoreOk?, draftCount?}} ctx
 * @returns {{enabled: boolean, reasonKey?: string}}
 */
export function menuState(entry, ctx) {
  const c = ctx || {}
  const list = [].concat(entry?.requires || [])
  // 先判“有没有集”：所有依赖当前集的项在没有集时给出同一个最直白的原因
  if (list.length && !c.episodeId) return { enabled: false, reasonKey: REASON.episode }
  for (const need of list) {
    const ok = CHECKS[need]
    if (ok && !ok(c)) return { enabled: false, reasonKey: REASON[need] }
  }
  return { enabled: true }
}
