<!-- 旧导出页已由 ExportDialog 取代（shell 的 export.video 对话框）。
     仅作兜底：当旧路由没被 resolveLegacyRoute 改写时，跳到时间线并打开导出对话框。 -->
<template>
  <div class="export-shim" />
</template>

<script setup>
import { onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const route = useRoute()
const router = useRouter()

onMounted(async () => {
  const dramaId = Number(route.params.dramaId) || undefined
  const episodeId = Number(route.params.episodeId || route.params.id)
  await router.replace(dramaId ? { name: 'episode-timeline', params: { dramaId, episodeId } } : '/')
  if (!dramaId || !episodeId) return
  const { openDialog } = await import('@/shell/dialogs')
  openDialog('export.video', { dramaId, episodeId })
})
</script>
