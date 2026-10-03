import { computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useAssetsStore } from '@/stores/assets'
import { useShellStore } from '@/stores/shell'
import { pickEpisodeId } from '@/utils/assets'

// 资产面板 / 资产库 / 弹窗共用的上下文：当前项目、用来创建场景和道具的分集、资产加载。

/** 只读上下文（不触发加载）：弹窗和子组件用。 */
export function useAssetScope() {
  const route = useRoute()
  const shell = useShellStore()
  const assets = useAssetsStore()

  const dramaId = computed(() => {
    const n = Number(route.params.dramaId || shell.dramaId)
    return Number.isFinite(n) && n > 0 ? n : null
  })
  const episodeId = computed(() =>
    pickEpisodeId({
      routeEpisodeId: route.params.episodeId,
      lastEpisodeId: dramaId.value ? shell.lastView(dramaId.value)?.episodeId : null,
      episodes: shell.episodes,
    }),
  )
  return { route, dramaId, episodeId, assets, shell }
}

/** 面板 / 资产库页的上下文：另外负责在挂载和项目切换时加载资产与出图开关。 */
export function useAssetContext() {
  const scope = useAssetScope()
  const { dramaId, episodeId, assets } = scope

  async function ensureLoaded() {
    if (!dramaId.value) return
    if (String(assets.dramaId) !== String(dramaId.value) || (!assets.loading && assets.loadError)) {
      await assets.load(dramaId.value)
    }
    await assets.refreshGate(episodeId.value)
  }

  onMounted(ensureLoaded)
  watch(dramaId, ensureLoaded)
  // 外壳的分集列表稍后才到：补刷一次出图开关
  watch(episodeId, (v, old) => {
    if (v && v !== old) assets.refreshGate(v)
  })

  return { ...scope, ensureLoaded }
}
