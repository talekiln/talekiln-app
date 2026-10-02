<template>
  <div v-if="visible.length" class="announcement-bar" data-test="announcement-bar">
    <el-alert
      v-for="a in visible"
      :key="a.id"
      :type="announcementAlertType(a.level)"
      :title="a.title"
      :description="a.body || undefined"
      show-icon
      closable
      :data-test="'announcement-' + a.id"
      @close="dismiss(a.id)"
    />
  </div>
</template>

<script setup>
// 首页顶部的云端公告条：内容来自主进程（见 composables/useDesktopCloud），关闭记在 localStorage（按公告 id）
import { computed, ref } from 'vue'
import { useDesktopCloud } from '@/composables/useDesktopCloud'
import { safeLocalStorage } from '@/utils/legal'
import { announcementAlertType, dismissAnnouncement, readDismissed, visibleAnnouncements } from '@/utils/updatesView'

const { status } = useDesktopCloud()
const storage = safeLocalStorage()
const dismissed = ref(readDismissed(storage))
const visible = computed(() => visibleAnnouncements(status.value.announcements, dismissed.value))

function dismiss(id) {
  dismissed.value = dismissAnnouncement(storage, id, dismissed.value)
}
</script>

<style scoped>
.announcement-bar { display: flex; flex-direction: column; gap: 6px; padding: 8px 16px 0; }
</style>
