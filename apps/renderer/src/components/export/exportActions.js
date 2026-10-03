// 导出菜单的 action 表（依赖注入版，便于 node --test）。shell/actions/export.js 注入真实依赖后导出。
// ctx = { router, route, dramaId, episodeId, openDialog, store }。
import { buildSrt, cuesFromTimeline } from '../../utils/exportSrt.js'
import { sheetContextFrom, sheetFilename } from '../../utils/exportStoryboardSheet.js'
import { t } from '../../i18n/index.js'
import { assetPackEntries, buildAssetPack, assetPackFilename } from './assetPack.js'

const SRT_MIME = 'application/x-subrip;charset=utf-8'

/** 当前项目 / 当前集的名字信息，用于文件名 */
function infoOf(ctx) {
  const drama = ctx.store?.drama || {}
  const ep = (ctx.store?.episodes || []).find((e) => Number(e.id) === Number(ctx.episodeId))
  return { title: drama.title || '', episodeNumber: ep?.episode_number ?? null, episodeId: ctx.episodeId }
}

function srtFilename(info) {
  const name = (info.title || 'project').replace(/[\\/:*?"<>|]/g, '_')
  const ep = info.episodeNumber != null ? t('export.sheet.fileEp', { n: info.episodeNumber }) : `ep${info.episodeId || '1'}`
  return `${name}-${ep}.srt`
}

/** 分镜表需要的数据：旧版分镜列表 + 项目的角色/场景/道具 + 每镜首尾帧提示词（并发取，单个失败只留空） */
export async function loadSheetData(api, { dramaId, episodeId, concurrency = 6 }) {
  const [list, drama] = await Promise.all([
    api.storyboards(episodeId),
    api.drama(dramaId).catch(() => null),
  ])
  const storyboards = Array.isArray(list) ? list : (list && list.storyboards) || []
  const framePrompts = {}
  let next = 0
  async function worker() {
    while (next < storyboards.length) {
      const sb = storyboards[next++]
      try {
        const res = await api.framePrompts(sb.id)
        const fps = (res && res.frame_prompts) || []
        framePrompts[sb.id] = {
          first: fps.find((r) => r.frame_type === 'first')?.prompt?.trim() || '',
          last: fps.find((r) => r.frame_type === 'last')?.prompt?.trim() || '',
        }
      } catch (_) {
        framePrompts[sb.id] = { first: '', last: '' }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, storyboards.length || 1)) }, worker))
  return {
    storyboards,
    characters: (drama && drama.characters) || [],
    scenes: (drama && drama.scenes) || [],
    props: (drama && drama.props) || [],
    framePrompts,
  }
}

export function createExportActions(deps) {
  const { notify } = deps
  const warn = (key) => notify('warning', key)

  const needEpisode = (fn) => async (ctx) => {
    if (!ctx.episodeId) return warn('export.noEpisode')
    return fn(ctx)
  }
  const dramaOf = (ctx) => ({ id: ctx.dramaId, title: ctx.store?.drama?.title || '' })

  return {
    'export.video': needEpisode((ctx) => ctx.openDialog('export.video', { dramaId: ctx.dramaId, episodeId: ctx.episodeId })),
    'export.jianying': needEpisode((ctx) => ctx.openDialog('export.media', { dramaId: ctx.dramaId, episodeId: ctx.episodeId, target: 'jianying' })),
    'export.premiere': needEpisode((ctx) => ctx.openDialog('export.media', { dramaId: ctx.dramaId, episodeId: ctx.episodeId, target: 'xmeml' })),

    'export.srt': needEpisode(async (ctx) => {
      const cues = cuesFromTimeline(await deps.loadTimeline(ctx.episodeId)).filter((c) => String(c.text ?? '').trim())
      if (!cues.length) return warn('export.srt.empty')
      await deps.saveText({ filename: srtFilename(infoOf(ctx)), mime: SRT_MIME, text: '\uFEFF' + buildSrt(cues) })
      notify('success', 'export.srt.done', { n: cues.length })
    }),

    'export.storyboardSheet': needEpisode(async (ctx) => {
      const data = await deps.loadSheetData({ dramaId: ctx.dramaId, episodeId: ctx.episodeId })
      if (!data || !(data.storyboards || []).length) return warn('export.sheet.empty')
      const r = await deps.exportSheet(sheetContextFrom(data), sheetFilename(infoOf(ctx)))
      if (!r || !r.ok) return warn('export.sheet.empty')
      notify('success', r.fallback === 'csv' ? 'export.sheet.doneCsv' : 'export.sheet.done', { n: r.count })
    }),

    'export.projectZip': async (ctx) => {
      if (!ctx.dramaId) return warn('export.noProject')
      await deps.downloadProjectZip(dramaOf(ctx))
      notify('info', 'export.zip.started')
    },

    'export.assetPack': needEpisode(async (ctx) => {
      const entries = assetPackEntries(await deps.loadAssetPackData(ctx.episodeId))
      if (!entries.length) return warn('export.assetPack.empty')
      notify('info', 'export.assetPack.start', { n: entries.length })
      const r = await buildAssetPack(entries, { fetchBytes: deps.fetchBytes })
      if (!r.bytes) return notify('error', 'export.assetPack.failed')
      await deps.saveBytes({ filename: assetPackFilename(infoOf(ctx)), mime: 'application/zip', bytes: r.bytes })
      if (r.skipped.length) notify('warning', 'export.assetPack.skipped', { n: r.skipped.length })
      notify('success', 'export.assetPack.done', { n: r.added })
    }),

    'export.fullBackup': async (ctx) => {
      if (!ctx.dramaId) return warn('export.noProject')
      try {
        await deps.downloadFullBackup(dramaOf(ctx))
      } catch (e) {
        if (e && e.reason === 'unavailable') return warn('export.backup.unavailable')
        return notify('error', 'export.backup.failed', { message: e?.message || String(e) })
      }
      notify('success', 'export.backup.done')
    },
  }
}
