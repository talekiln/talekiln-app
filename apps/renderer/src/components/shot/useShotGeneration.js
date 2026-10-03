// Queue-only generation flow for the storyboard (estimate -> confirm -> submit -> poll), with localized messages.
// Same protocol as composables/useGeneration.js, but every text goes through i18n (the confirm summary and the
// submitted message come from the generate lane's generateConfirm.js). Never calls POST /images or /videos.
import { computed, onBeforeUnmount, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { episodeGenerationAPI as generationAPI } from '@/api/episodeGeneration'
import { buildGenerateBody, pollInterval, shotStatusMap } from '@/utils/generationView'
import { previewSummary, submittedText } from '@/components/generate/generateConfirm'

const IDLE = () => ({ visible: false, preview: null, request: null, submitting: false, loading: false })

/**
 * @param {import('vue').Ref<number|null>} episodeId
 * @param {{ onChanged?: (result: object) => void }} [opts]
 */
export function useShotGeneration(episodeId, { onChanged } = {}) {
  const status = ref(null)
  const map = computed(() => shotStatusMap(status.value))
  /** Queue status of one shot by legacy storyboard id: { state, image, video } | null. */
  const shotStatus = (legacyId) => map.value.get(Number(legacyId)) || null
  const dialog = ref(IDLE())
  const summary = computed(() => previewSummary(dialog.value.preview))
  let timer = null
  let stopped = false

  async function refresh() {
    if (!episodeId.value) return
    try {
      status.value = await generationAPI.status(episodeId.value)
    } catch (_) { /* request.js already reports */ }
    clearTimeout(timer)
    if (!stopped) timer = setTimeout(refresh, pollInterval(status.value))
  }

  /** Open the estimate. shots: array of legacy storyboard ids or 'all'. kind: image | video | both. */
  async function ask({ shots = 'all', kind = 'both', regenerate = false } = {}) {
    if (!episodeId.value) return
    const request = { shots, kind, regenerate }
    dialog.value = { ...IDLE(), visible: true, request, loading: true }
    try {
      const preview = await generationAPI.generate(episodeId.value, buildGenerateBody({ ...request, confirm: false }))
      dialog.value = { ...dialog.value, preview, loading: false }
    } catch (_) {
      dialog.value = IDLE()
    }
  }

  async function confirm() {
    const d = dialog.value
    if (!d.request || d.submitting) return
    dialog.value = { ...d, submitting: true }
    try {
      const result = await generationAPI.generate(episodeId.value, buildGenerateBody({ ...d.request, confirm: true }))
      ElMessage.success(submittedText(result))
      dialog.value = IDLE()
      await refresh()
      if (onChanged) onChanged(result)
    } catch (_) {
      dialog.value = { ...dialog.value, submitting: false } // quota errors are shown by request.js; keep the dialog open
    }
  }

  function cancel() {
    dialog.value = IDLE()
  }

  onBeforeUnmount(() => { stopped = true; clearTimeout(timer) })

  return { status, shotStatus, dialog, summary, refresh, ask, confirm, cancel }
}
