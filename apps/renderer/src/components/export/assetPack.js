// 素材包：把一集的镜头素材按镜头整理成 ZIP（首帧图 / 视频 / 配音），不需要后端新接口。
// 文件由前端用现有媒体 URL 逐个下载后写入（store-only ZIP，见 zipStore.js）；
// 下载失败的文件跳过并在结果里列出，不会让整包失败。整包在浏览器内存里组装，超大项目建议改用“完整项目备份”。
import { t } from '../../i18n/index.js'
import { createZipWriter } from './zipStore.js'

const FALLBACK_EXT = { image: 'png', video: 'mp4', voice: 'mp3' }
const BASENAME = { image: 'first-frame', video: 'video', voice: 'voice' }

const staticUrl = (localPath) => '/static/' + String(localPath).trim().replace(/^\//, '')
const clean = (v) => (v == null ? '' : String(v).trim())

function extOf(url, kind) {
  const path = String(url).split(/[?#]/)[0]
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(path)
  return m ? m[1].toLowerCase() : FALLBACK_EXT[kind]
}

/**
 * 旧版分镜列表（GET /episodes/:id/storyboards 的 storyboards）-> 要打包的文件清单
 * [{ name: 'shot-001/first-frame.png', url, kind: 'image'|'video'|'voice', shot }]
 */
export function assetPackEntries(storyboards) {
  const out = []
  ;(storyboards || []).forEach((sb, i) => {
    const num = Number.isFinite(Number(sb.storyboard_number)) && Number(sb.storyboard_number) > 0 ? Number(sb.storyboard_number) : i + 1
    const dir = `shot-${String(num).padStart(3, '0')}`
    const sources = [
      ['image', clean(sb.local_path) ? staticUrl(sb.local_path) : clean(sb.image_url)],
      ['video', clean(sb.video_local_path) ? staticUrl(sb.video_local_path) : clean(sb.video_url)],
      ['voice', clean(sb.narration_audio_local_path) ? staticUrl(sb.narration_audio_local_path) : ''],
    ]
    for (const [kind, url] of sources) {
      if (!url) continue
      out.push({ name: `${dir}/${BASENAME[kind]}.${extOf(url, kind)}`, url, kind, shot: sb.id })
    }
  })
  return out
}

/**
 * 逐个下载并打包。fetchBytes(url) -> Uint8Array；同一 URL 只下载一次。
 * 返回 { bytes: Uint8Array | null, added, skipped: [{ name, reason }], cancelled }
 */
export async function buildAssetPack(entries, { fetchBytes, onProgress, isCancelled } = {}) {
  const zip = createZipWriter()
  const cache = new Map()
  const skipped = []
  let added = 0
  let done = 0
  let cancelled = false
  const total = entries.length
  for (const e of entries) {
    if (isCancelled && isCancelled()) { cancelled = true; break }
    try {
      let bytes = cache.get(e.url)
      if (!bytes) {
        bytes = await fetchBytes(e.url)
        cache.set(e.url, bytes)
      }
      zip.add(e.name, bytes)
      added += 1
    } catch (err) {
      skipped.push({ name: e.name, reason: err?.message || String(err) })
    }
    done += 1
    if (onProgress) onProgress(done, total)
  }
  return { bytes: added > 0 ? zip.finish() : null, added, skipped, cancelled }
}

export function assetPackFilename({ title, episodeNumber, episodeId } = {}) {
  const name = (title || 'project').replace(/[\\/:*?"<>|]/g, '_')
  const ep = episodeNumber != null ? t('export.sheet.fileEp', { n: episodeNumber }) : `ep${episodeId || '1'}`
  return `${name}-${ep}-${t('export.assetPack.fileSuffix')}.zip`
}
