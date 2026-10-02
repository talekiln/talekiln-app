/**
 * 命令面板的内置命令与内容搜索来源（纯逻辑：路由、store 都以依赖注入，可 node --test）。
 *
 * deps:
 *   go(location)            跳转（vue-router 的 push）
 *   undo() / redo()         内核历史
 *   openHistory()           打开版本历史抽屉
 *   openDirector(episodeId) 打开导演模式抽屉（P3-D）
 *   select(sel)             设置四视图共享选择 { kind, id }
 *   getViews()              { script, shots }（内核视图投影，可能为 null）
 * ctx（每次搜索现取）: { episodeId, dramaId, canUndo, canRedo, busy }
 */
import { viewLocation, shotNumbers } from './projectViews.js'

const hasEpisode = (ctx) => !!ctx.episodeId

export function createBuiltinCommands(deps) {
  const goView = (view) => (ctx) => deps.go(viewLocation(view, ctx.episodeId, ctx.dramaId))
  const page = (id, title, path, keywords = []) => ({ id, title, group: '页面', keywords, run: () => deps.go(path) })
  return [
    page('nav.list', '项目列表', '/', ['首页', '回到首页', 'home', 'projects']),
    { ...page('project.new', '新建项目', '/new-project', ['创建', 'new', 'create']), group: '项目' },
    page('nav.ai-config', '打开设置', '/ai-config', ['设置', 'AI 配置', '模型', 'settings', 'key', '密钥']),
    page('nav.keyboard', '打开快捷键设置', '/settings/shortcuts', ['快捷键', '键位', 'keymap', 'shortcuts', 'premiere', '剪映', '预设']),
    page('nav.task-center', '任务中心', '/task-center', ['队列', '生成任务', 'tasks']),
    page('nav.spend', '花费统计', '/spend', ['费用', '账单', '花费', 'cost']),
    page('nav.media-library', '媒体素材库', '/media-library', ['素材', 'media']),
    { id: 'view.script', title: '切换到剧本视图', group: '视图', keywords: ['剧本', 'script', '台词'], when: hasEpisode, run: goView('script') },
    { id: 'view.storyboard', title: '切换到镜头视图', group: '视图', keywords: ['镜头', '分镜', 'storyboard', 'shots'], when: hasEpisode, run: goView('storyboard') },
    { id: 'view.timeline', title: '切换到时间线视图', group: '视图', keywords: ['时间线', 'timeline', '剪辑'], when: hasEpisode, run: goView('timeline') },
    { id: 'view.canvas', title: '切换到画布视图', group: '视图', keywords: ['画布', 'canvas', '节点'], when: hasEpisode, run: goView('canvas') },
    { id: 'edit.undo', title: '撤销', group: '编辑', keywords: ['undo', '回退'], hint: 'Ctrl+Z', when: hasEpisode, enabled: (c) => c.canUndo && !c.busy, run: () => deps.undo() },
    { id: 'edit.redo', title: '重做', group: '编辑', keywords: ['redo'], hint: 'Ctrl+Shift+Z', when: hasEpisode, enabled: (c) => c.canRedo && !c.busy, run: () => deps.redo() },
    { id: 'history.open', title: '打开版本历史', group: '编辑', keywords: ['历史', '版本', 'history', 'versions', '操作记录'], when: hasEpisode, run: () => deps.openHistory() },
    { id: 'project.export', title: '导出视频', group: '项目', keywords: ['导出', 'export', '渲染', '成片'], when: hasEpisode, run: (ctx) => deps.go({ path: `/episodes/${ctx.episodeId}/export`, query: ctx.dramaId ? { drama: String(ctx.dramaId) } : {} }) },
    // P3-B
    { id: 'project.batch', title: '批量生成', group: '项目', keywords: ['批量', '多集', '批次', 'batch', '并发', '预算'], when: (ctx) => !!ctx.dramaId, run: (ctx) => deps.go(`/project/${ctx.dramaId}/batch`) },
    // P3-T
    page('nav.templates', '模板市场', '/templates', ['模板', '套用', '市场', 'template', 'templates']),
    // P3-D
    { id: 'director.open', title: '导演模式', group: '编辑', keywords: ['导演', '自然语言', '改片', '一句话', 'director', 'ai'], when: hasEpisode, run: (ctx) => deps.openDirector(ctx.episodeId) },
  ]
}

const cut = (s, n = 36) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t }

/**
 * 搜索镜头与台词行的 provider：query 为空不给结果（避免面板一打开就是几百条）。
 * 每类最多 limit 条；命中判断交给注册表的模糊评分，这里只做粗筛以控制数量。
 */
export function createContentProvider(deps, { limit = 30 } = {}) {
  return (query, ctx) => {
    const q = String(query || '').trim().toLowerCase()
    if (!q || !ctx.episodeId) return []
    const { script, shots } = deps.getViews() || {}
    const nums = shotNumbers(shots)
    const out = []
    for (const g of shots?.groups || []) {
      for (const s of g.shots) {
        const title = s.params?.title || s.params?.description || ''
        const hay = `${nums[s.id] ? `镜头 ${nums[s.id]}` : ''} ${title} ${s.dialogue || ''}`.toLowerCase()
        if (!roughMatch(q, hay)) continue
        out.push({
          id: `shot:${s.id}`,
          title: `镜头 ${nums[s.id]}：${cut(title || s.dialogue || '（未命名镜头）')}`,
          group: '镜头',
          keywords: [s.dialogue || '', `${nums[s.id]}`, g.title || ''],
          run: (c) => { deps.select({ kind: 'shot', id: s.id }); deps.go(viewLocation('storyboard', c.episodeId, c.dramaId)) },
        })
        if (out.length >= limit) break
      }
    }
    let lines = 0
    for (const g of script?.groups || []) {
      for (const l of g.lines) {
        const hay = `${l.speaker || ''} ${l.text || ''}`.toLowerCase()
        if (!roughMatch(q, hay)) continue
        out.push({
          id: `line:${l.id}`,
          title: `${l.speaker && !String(l.text || '').startsWith(l.speaker) ? `${l.speaker}：` : ''}${cut(l.text)}`, // 对白行文字常自带“说话人：”前缀
          group: '台词',
          keywords: [l.speaker || ''],
          run: (c) => { deps.select({ kind: 'line', id: l.id }); deps.go(viewLocation('script', c.episodeId, c.dramaId)) },
        })
        if (++lines >= limit) break
      }
    }
    return out
  }
}

/** 内容搜索只认子串（每个空白分隔的词都要出现）：长文本上做子序列匹配几乎什么都能命中，噪声太大。 */
function roughMatch(q, hay) {
  return q.split(/\s+/).filter(Boolean).every((t) => hay.includes(t))
}
