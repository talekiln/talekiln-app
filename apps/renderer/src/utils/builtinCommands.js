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
import { t } from '../i18n/index.js'
import { viewLocation, shotNumbers } from './projectViews.js'

const hasEpisode = (ctx) => !!ctx.episodeId

// 标题 / 分组 / 关键词都是 getter：命令只注册一次，切换语言后下一次渲染 / 搜索就取到新语言的文案。
// 关键词是 commands.<id>.kw 里用 | 分隔的一串（中英文都带，两种语言下都能搜到）。
function def(id, groupId, extra) {
  return {
    id,
    get title() { return t(`commands.${id}.title`) },
    get group() { return groupId ? t(`commands.group.${groupId}`) : undefined },
    get keywords() { return t(`commands.${id}.kw`).split('|') },
    ...extra,
  }
}

export function createBuiltinCommands(deps) {
  const goView = (view) => (ctx) => deps.go(viewLocation(view, ctx.episodeId, ctx.dramaId))
  const page = (id, path, groupId = 'pages') => def(id, groupId, { run: () => deps.go(path) })
  return [
    page('nav.list', '/'),
    page('project.new', '/new-project', 'project'),
    page('nav.ai-config', '/ai-config'),
    page('nav.keyboard', '/settings/shortcuts'),
    page('nav.task-center', '/task-center'),
    page('nav.spend', '/spend'),
    page('nav.media-library', '/media-library'),
    def('view.script', 'views', { when: hasEpisode, run: goView('script') }),
    def('view.storyboard', 'views', { when: hasEpisode, run: goView('storyboard') }),
    def('view.timeline', 'views', { when: hasEpisode, run: goView('timeline') }),
    def('view.canvas', 'views', { when: hasEpisode, run: goView('canvas') }),
    def('edit.undo', 'edit', { hint: 'Ctrl+Z', when: hasEpisode, enabled: (c) => c.canUndo && !c.busy, run: () => deps.undo() }),
    def('edit.redo', 'edit', { hint: 'Ctrl+Shift+Z', when: hasEpisode, enabled: (c) => c.canRedo && !c.busy, run: () => deps.redo() }),
    def('history.open', 'edit', { when: hasEpisode, run: () => deps.openHistory() }),
    def('project.export', 'project', { when: hasEpisode, run: (ctx) => deps.go(ctx.dramaId ? { name: 'episode-export', params: { dramaId: ctx.dramaId, episodeId: ctx.episodeId } } : { path: `/episodes/${ctx.episodeId}/export` }) }),
    // P3-B
    def('project.batch', 'project', { when: (ctx) => !!ctx.dramaId, run: (ctx) => deps.go({ name: 'batch', params: { dramaId: ctx.dramaId } }) }),
    // P3-T
    page('nav.templates', '/templates'),
    // P3-D
    def('director.open', 'edit', { when: hasEpisode, run: (ctx) => deps.openDirector(ctx.episodeId) }),
    // P3-P
    page('nav.plugins', '/settings/plugins'),
    // P3-K
    page('nav.backup', '/settings/backup'),
    // P3-S
    page('nav.studio', '/settings/studio'),
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
        const hay = `${nums[s.id] ? t('commands.shotNo', { no: nums[s.id] }) : ''} ${title} ${s.dialogue || ''}`.toLowerCase()
        if (!roughMatch(q, hay)) continue
        out.push({
          id: `shot:${s.id}`,
          title: t('commands.shotTitle', { no: nums[s.id], text: cut(title || s.dialogue || t('commands.unnamedShot')) }),
          group: t('commands.group.shot'),
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
          title: l.speaker && !String(l.text || '').startsWith(l.speaker) ? t('commands.speakerLine', { speaker: l.speaker, text: cut(l.text) }) : cut(l.text), // 对白行文字常自带“说话人：”前缀
          group: t('commands.group.line'),
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
