// 传给 action 处理函数的 ctx（见 actions/registry.js）。必须在组件 setup 里调用。
import { useRoute, useRouter } from 'vue-router'
import { useShellStore } from '@/stores/shell'
import { openDialog } from './dialogs/index.js'

export function useActionContext() {
  const route = useRoute()
  const router = useRouter()
  const store = useShellStore()
  return () => ({
    router,
    route,
    dramaId: Number(route.params.dramaId) || null,
    episodeId: Number(route.params.episodeId) || null,
    openDialog,
    store,
  })
}
