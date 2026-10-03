// One shot as the inspector sees it: the kernel view (params, states) joined with the legacy storyboard row
// (media and extra columns) and the shot's image records. Writes go through saveShotPatch.
import { computed, ref, toValue, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { t } from '@/i18n'
import { storyboardsAPI } from '@/api/storyboards'
import { imagesAPI } from '@/api/images'
import { useProjectViewsStore } from '@/stores/projectViews'
import { mergeShot, splitPatch } from './shotInspectorModel.js'
import { historyItems, pickSlotImages } from './frameSlots.js'
import { saveShotPatch } from './shotWrite.js'

/** @param {string|import('vue').Ref<string>|(() => string)} shotIdRef kernel shot node id */
export function useShotRecord(shotIdRef) {
  const views = useProjectViewsStore()
  const view = computed(() => views.index.shotById[toValue(shotIdRef)] || null)
  const legacyId = computed(() => (view.value ? view.value.legacy_id ?? null : null))
  const row = ref(null)
  const images = ref([])
  const loading = ref(false)
  const saving = ref(false)
  const shot = computed(() => (view.value ? mergeShot(view.value, row.value) : null))
  const bound = computed(() => pickSlotImages(images.value, row.value))
  const history = computed(() => historyItems(images.value, bound.value))

  let token = 0
  async function reload() {
    const id = legacyId.value
    if (id == null) {
      row.value = null
      images.value = []
      return
    }
    const mine = ++token
    loading.value = true
    try {
      const [r, imgs] = await Promise.all([
        storyboardsAPI.get(id),
        imagesAPI.list({ storyboard_id: id, page: 1, page_size: 100 }),
      ])
      if (mine !== token) return
      row.value = r || null
      images.value = (imgs && imgs.items) || []
    } catch (_) {
      /* request.js already reports */
    } finally {
      if (mine === token) loading.value = false
    }
  }

  /** Save a UI patch (duration in seconds). Resolves { ok }. Failures are toasted here. */
  async function save(patch) {
    const s = shot.value
    if (!s || !patch || !Object.keys(patch).length) return { ok: true }
    saving.value = true
    try {
      const deps = {
        intent: (v, n, a) => views.intent(v, n, a),
        updateLegacy: (id, data) => storyboardsAPI.update(id, data),
      }
      const r = await saveShotPatch(deps, s, patch)
      if (!r.ok) {
        if (r.error !== 'intent') ElMessage.error(t('storyboard.msg.saveFailed', { message: r.error || '' }))
        return r
      }
      await reload()
      // Plain-column writes do not pass through the kernel intent; refresh so the other views see them.
      if (Object.keys(splitPatch(patch).legacy).length) await views.refresh()
      return r
    } finally {
      saving.value = false
    }
  }

  watch(legacyId, reload, { immediate: true })
  watch(() => views.revision, reload)
  // The queue writes results back through the kernel: a changed state means new image / video rows.
  watch(() => [view.value && view.value.image, view.value && view.value.video, views.seq], reload)

  return { view, shot, row, images, bound, history, loading, saving, legacyId, reload, save }
}
