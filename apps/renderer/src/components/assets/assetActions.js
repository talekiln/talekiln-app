import { reactive } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { t } from '@/i18n'
import { uploadAPI } from '@/api/upload'
import { characterAPI } from '@/api/characters'
import { sceneAPI } from '@/api/scenes'
import { propAPI } from '@/api/props'
import { useAssetScope } from './assetContext'
import {
  addExtraImagePatch, assetName, hasAssetImage, removeExtraPatch, setPrimaryPatch,
} from '@/utils/assets'

// 资产的通用操作（上传 / 设主图 / 删除 / 入库 / AI 提示词 / SD2），资产面板、资产库页、弹窗共用。
// 所有提示文案走 i18n；失败只弹本次操作的错误，不抛出。

const API = { characters: characterAPI, scenes: sceneAPI, props: propAPI }

function errMsg(e, fallbackKey) {
  return (e && e.message) || t(fallbackKey)
}

/** 上传接口返回 { url, local_path }（拦截器已解包）。 */
export function uploadedPath(res) {
  const d = res && res.data && !res.local_path && !res.url ? res.data : res
  return (d && (d.local_path || '')) || ''
}

export function useAssetActions() {
  const { dramaId, episodeId, assets } = useAssetScope()
  const busy = reactive({})
  const k = (op, kind, id) => `${op}:${kind}:${id}`
  const isBusy = (op, kind, id) => !!busy[k(op, kind, id)]

  async function run(op, kind, id, fn) {
    const key = k(op, kind, id)
    if (busy[key]) return undefined
    busy[key] = true
    try {
      return await fn()
    } finally {
      delete busy[key]
    }
  }

  async function create(kind, data) {
    try {
      const item = await assets.create(kind, data, { episodeId: episodeId.value })
      ElMessage.success(t('assets.toast.created'))
      return item
    } catch (e) {
      ElMessage.error(errMsg(e, 'assets.toast.createFailed'))
      return null
    }
  }

  async function update(kind, id, patch, okKey = 'assets.toast.saved') {
    try {
      const item = await assets.update(kind, id, patch)
      if (okKey) ElMessage.success(t(okKey))
      return item
    } catch (e) {
      ElMessage.error(errMsg(e, 'assets.toast.saveFailed'))
      return null
    }
  }

  /** 二次确认后删除；返回是否已删除。 */
  async function remove(kind, item) {
    const name = (assetName(kind, item) || t('assets.unnamed')).slice(0, 20)
    try {
      await ElMessageBox.confirm(t(`assets.confirm.remove.${kind}`, { name }), t('assets.confirm.removeTitle'), {
        type: 'warning',
        confirmButtonText: t('common.delete'),
        cancelButtonText: t('common.cancel'),
      })
    } catch (_) {
      return false
    }
    try {
      await assets.remove(kind, item.id)
      ElMessage.success(t('assets.toast.removed'))
      return true
    } catch (e) {
      ElMessage.error(errMsg(e, 'assets.toast.removeFailed'))
      return false
    }
  }

  /** 上传一组图片：没有主图时第一张成为主图，其余追加为额外图。 */
  async function uploadImages(kind, id, files) {
    const list = Array.from(files || []).filter((f) => f && /^image\//.test(f.type || 'image/'))
    if (!list.length) {
      ElMessage.warning(t('assets.upload.notImage'))
      return 0
    }
    return (await run('upload', kind, id, async () => {
      let done = 0
      for (const file of list) {
        try {
          const path = uploadedPath(await uploadAPI.uploadImage(file, { dramaId: dramaId.value }))
          if (!path) throw new Error(t('assets.upload.noPath'))
          const cur = assets.find(kind, id)
          await assets.update(kind, id, addExtraImagePatch(cur, path))
          done++
        } catch (e) {
          ElMessage.error(errMsg(e, 'assets.upload.failed'))
        }
      }
      if (done) ElMessage.success(t('assets.upload.done', { n: done }))
      return done
    })) || 0
  }

  /** 上传一张用作参考的图，返回本地路径（用于表单的 ref_image）；失败返回空串。 */
  async function uploadRef(file) {
    if (!file || !/^image\//.test(file.type || 'image/')) {
      ElMessage.warning(t('assets.upload.notImage'))
      return ''
    }
    try {
      const path = uploadedPath(await uploadAPI.uploadImage(file, { dramaId: dramaId.value }))
      if (!path) throw new Error(t('assets.upload.noPath'))
      return path
    } catch (e) {
      ElMessage.error(errMsg(e, 'assets.upload.failed'))
      return ''
    }
  }

  async function setPrimary(kind, id, path) {
    const patch = setPrimaryPatch(assets.find(kind, id), path)
    if (!Object.keys(patch).length) return
    await update(kind, id, patch, 'assets.toast.primarySet')
  }

  async function removeExtra(kind, id, path) {
    await update(kind, id, removeExtraPatch(assets.find(kind, id), path), 'assets.toast.extraRemoved')
  }

  // ---- 入库 ----
  /** scope: 'project' = 本剧资料库；'global' = 全局素材库。 */
  async function saveToLibrary(kind, item, scope) {
    if (!hasAssetImage(item)) {
      ElMessage.warning(t('assets.library.needImage'))
      return false
    }
    const api = API[kind]
    return (await run(`lib-${scope}`, kind, item.id, async () => {
      try {
        if (scope === 'global') await api.addToMaterialLibrary(item.id)
        else await api.addToLibrary(item.id, {})
        ElMessage.success(t(scope === 'global' ? 'assets.library.savedGlobal' : 'assets.library.savedProject'))
        return true
      } catch (e) {
        ElMessage.error(errMsg(e, 'assets.library.saveFailed'))
        return false
      }
    })) || false
  }

  // ---- AI 文本（不受出图开关限制）----
  /** 生成提示词。mode='single' 仅场景有（单图提示词）。返回后端结果字段（polished_prompt / prompt / polished_prompt_single）。 */
  async function generatePrompt(kind, item, mode) {
    return run('prompt', kind, item.id, async () => {
      try {
        const res = kind === 'characters'
          ? await characterAPI.generatePrompt(item.id)
          : kind === 'scenes'
            ? await sceneAPI.generatePrompt(item.id, undefined, undefined, mode)
            : await propAPI.generatePrompt(item.id)
        const got = res && (res.polished_prompt_single || res.polished_prompt || res.prompt)
        if (!got) {
          ElMessage.warning(t('assets.prompt.empty'))
          return null
        }
        await assets.reload()
        ElMessage.success(t('assets.prompt.done'))
        return res
      } catch (e) {
        ElMessage.error(errMsg(e, 'assets.prompt.failed'))
        return null
      }
    })
  }

  /** 从图片提取描述。返回后端结果（characters: appearance；scenes: prompt；props: description / prompt）。 */
  async function extractFromImage(kind, item) {
    if (!hasAssetImage(item) && !item.ref_image) {
      ElMessage.warning(t('assets.extractImage.needImage'))
      return null
    }
    return run('extractImage', kind, item.id, async () => {
      try {
        const res = await API[kind].extractFromImage(item.id)
        ElMessage.success(t('assets.extractImage.done'))
        return res || null
      } catch (e) {
        ElMessage.error(errMsg(e, 'assets.extractImage.failed'))
        return null
      }
    })
  }

  /** 提炼角色视觉锚点：启动后每 3 秒读一次角色，最多 60 秒；返回锚点文本或空串。 */
  async function extractAnchors(item, { intervalMs = 3000, maxMs = 60000 } = {}) {
    if (!item?.appearance) {
      ElMessage.warning(t('assets.anchors.needAppearance'))
      return ''
    }
    return (await run('anchors', 'characters', item.id, async () => {
      try {
        await characterAPI.extractAnchors(item.id)
        ElMessage.info(t('assets.anchors.started'))
        for (let waited = 0; waited < maxMs; waited += intervalMs) {
          await new Promise((r) => setTimeout(r, intervalMs))
          const res = await characterAPI.get(item.id)
          const anchors = res?.character?.identity_anchors || res?.identity_anchors
          if (anchors) {
            await assets.reload()
            return anchors
          }
        }
        ElMessage.warning(t('assets.anchors.timeout'))
        return ''
      } catch (e) {
        ElMessage.error(errMsg(e, 'assets.anchors.failed'))
        return ''
      }
    })) || ''
  }

  // ---- Seedance 2.0 认证 / 音色（仅角色）----
  const sd2Status = (c) => String(c?.seedance2_asset?.status || '').toLowerCase()
  const sd2VoiceStatus = (c) => String(c?.seedance2_voice_asset?.status || '').toLowerCase()

  function sd2LabelKey(c) {
    const s = sd2Status(c)
    return s === 'active' ? 'assets.sd2.view' : s === 'processing' ? 'assets.sd2.refresh' : s === 'failed' ? 'assets.sd2.retry' : 'assets.sd2.certify'
  }
  function sd2VoiceLabelKey(c) {
    const s = sd2VoiceStatus(c)
    return s === 'active' ? 'assets.sd2.voiceSet' : s === 'processing' || s === 'stale' ? 'assets.sd2.voiceRefresh' : s === 'failed' ? 'assets.sd2.voiceRetry' : 'assets.sd2.voiceUpload'
  }

  async function sd2Refresh(c) {
    return run('sd2', 'characters', c.id, async () => {
      try {
        await characterAPI.sd2CertifyRefresh(c.id)
        await assets.reload()
        ElMessage.success(t('assets.sd2.refreshed'))
        return true
      } catch (e) {
        ElMessage.error(errMsg(e, 'assets.sd2.refreshFailed'))
        return false
      }
    })
  }

  /** 认证主按钮：已认证 -> 返回 'view'（由调用方弹详情）；处理中 -> 刷新；否则提交认证。 */
  async function sd2Primary(c) {
    if (!hasAssetImage(c)) {
      ElMessage.warning(t('assets.library.needImage'))
      return null
    }
    const s = sd2Status(c)
    if (s === 'active') return 'view'
    if (s === 'processing') return (await sd2Refresh(c)) ? 'refreshed' : null
    return run('sd2', 'characters', c.id, async () => {
      try {
        await characterAPI.sd2Certify(c.id)
        await assets.reload()
        ElMessage.success(t('assets.sd2.submitted'))
        return 'submitted'
      } catch (e) {
        const msg = (e && e.message) || ''
        if (/已存在|已认证|already/i.test(msg)) {
          try {
            await characterAPI.sd2CertifyRefresh(c.id)
            await assets.reload()
            ElMessage.success(t('assets.sd2.refreshed'))
            return 'refreshed'
          } catch (_) { /* 落到下面的错误提示 */ }
        }
        ElMessage.error(msg || t('assets.sd2.failed'))
        return null
      }
    })
  }

  async function sd2VoiceUpload(c, file) {
    if (!file) return false
    return (await run('sd2voice', 'characters', c.id, async () => {
      try {
        await characterAPI.sd2VoiceUpload(c.id, file)
        await assets.reload()
        ElMessage.success(t('assets.sd2.voiceUploaded'))
        return true
      } catch (e) {
        ElMessage.error(errMsg(e, 'assets.sd2.voiceUploadFailed'))
        return false
      }
    })) || false
  }

  async function sd2VoiceRefresh(c) {
    return run('sd2voice', 'characters', c.id, async () => {
      try {
        await characterAPI.sd2VoiceRefresh(c.id)
        await assets.reload()
        ElMessage.success(t('assets.sd2.voiceRefreshed'))
        return true
      } catch (e) {
        ElMessage.error(errMsg(e, 'assets.sd2.refreshFailed'))
        return false
      }
    })
  }

  function playVoice(c) {
    const url = c?.seedance2_voice_asset?.url
    if (!url) {
      ElMessage.warning(t('assets.sd2.noVoice'))
      return
    }
    try {
      const audio = new Audio(url)
      audio.onerror = () => ElMessage.error(t('assets.sd2.playFailed'))
      audio.play().catch(() => ElMessage.error(t('assets.sd2.playFailed')))
    } catch (_) {
      ElMessage.error(t('assets.sd2.playFailed'))
    }
  }

  return {
    dramaId, episodeId, assets, busy, isBusy,
    create, update, remove, uploadImages, uploadRef, setPrimary, removeExtra,
    saveToLibrary, generatePrompt, extractFromImage, extractAnchors,
    sd2Status, sd2VoiceStatus, sd2LabelKey, sd2VoiceLabelKey, sd2Primary, sd2VoiceUpload, sd2VoiceRefresh, playVoice,
  }
}
