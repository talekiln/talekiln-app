// Does the active video model take several reference images? Universal-segment mode is only offered when it does.
// Read once from the video AI configs and shared (module-level), see supportsMultiRef for the rule.
import { ref } from 'vue'
import { aiAPI } from '@/api/ai'
import { pickVideoConfig, supportsMultiRef } from './shotInspectorModel.js'

const multiRef = ref(false)
const loaded = ref(false)
let pending = null

export function loadMultiRef(force = false) {
  if (force) pending = null
  if (!pending) {
    pending = aiAPI.list('video')
      .then((list) => {
        multiRef.value = supportsMultiRef(pickVideoConfig(list))
        loaded.value = true
      })
      .catch(() => {
        pending = null // retry next time; unknown means "not supported"
      })
  }
  return pending
}

export function useMultiRef() {
  loadMultiRef()
  return { multiRef, loaded, reload: () => loadMultiRef(true) }
}
