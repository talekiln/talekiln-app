import { computed, onBeforeUnmount, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { episodeGenerationAPI as generationAPI } from '@/api/episodeGeneration'
import { buildGenerateBody, chipForShot, pollInterval, shotStatusMap, submittedText } from '@/utils/generationView'

/**
 * 出图 / 出视频的统一流程（页面共用）：先估算（confirm=false）-> 确认弹窗 -> 提交（confirm=true）-> 轮询状态。
 * episodeId 是 ref（页面加载完才有值）。
 */
export function useGeneration(episodeId, { onChanged } = {}) {
  const status = ref(null)
  const legacyEnabled = computed(() => !!(status.value && status.value.legacy_enabled))
  const map = computed(() => shotStatusMap(status.value))
  const chip = (storyboardId) => chipForShot(map.value, storyboardId)
  const shotStatus = (storyboardId) => map.value.get(Number(storyboardId)) || null

  const dialog = ref({ visible: false, preview: null, request: null, submitting: false, loading: false })
  let timer = null
  let stopped = false

  async function refresh() {
    if (!episodeId.value) return
    try {
      status.value = await generationAPI.status(episodeId.value)
    } catch (_) { /* request.js 已提示 */ }
    clearTimeout(timer)
    if (!stopped) timer = setTimeout(refresh, pollInterval(status.value))
  }

  /** 点“生成”：先要估算，弹出确认框。shots 为 storyboard id 数组或 'all'。 */
  async function ask({ shots = 'all', kind = 'both', regenerate = false } = {}) {
    if (!episodeId.value) return
    const request = { shots, kind, regenerate }
    dialog.value = { visible: true, preview: null, request, submitting: false, loading: true }
    try {
      const preview = await generationAPI.generate(episodeId.value, buildGenerateBody({ ...request, confirm: false }))
      dialog.value = { ...dialog.value, preview, loading: false }
    } catch (_) {
      dialog.value = { visible: false, preview: null, request: null, submitting: false, loading: false }
    }
  }

  async function confirm() {
    const d = dialog.value
    if (!d.request || d.submitting) return
    dialog.value = { ...d, submitting: true }
    try {
      const result = await generationAPI.generate(episodeId.value, buildGenerateBody({ ...d.request, confirm: true }))
      ElMessage.success(submittedText(result))
      dialog.value = { visible: false, preview: null, request: null, submitting: false, loading: false }
      await refresh()
      if (onChanged) onChanged(result)
    } catch (_) {
      dialog.value = { ...dialog.value, submitting: false } // 超额度等错误已由 request.js 提示，弹窗留着让用户调整
    }
  }

  function cancel() {
    dialog.value = { visible: false, preview: null, request: null, submitting: false, loading: false }
  }

  onBeforeUnmount(() => { stopped = true; clearTimeout(timer) })

  return { status, legacyEnabled, chip, shotStatus, dialog, refresh, ask, confirm, cancel }
}
