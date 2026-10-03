<template>
  <div class="project-shell" data-test="project-shell">
    <router-view :key="viewKey" />
    <DialogHost />
  </div>
</template>

<script setup>
import { computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useShellStore } from '@/stores/shell'
import { installActions } from './actions/index.js'
import DialogHost from './DialogHost.vue'

installActions()

const route = useRoute()
const shell = useShellStore()

const dramaId = computed(() => Number(route.params.dramaId) || null)
// 切集 / 切镜头时重建子页面，避免各视图自己监听路由参数
const viewKey = computed(() => `${String(route.name)}:${route.params.episodeId || ''}:${route.params.shotId || ''}`)

watch(dramaId, (id) => { if (id) shell.loadProject(id) }, { immediate: true })
</script>

<style scoped>
.project-shell { min-height: 100vh; }
</style>
