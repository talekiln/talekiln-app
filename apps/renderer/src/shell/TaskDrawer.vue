<template>
  <el-drawer :model-value="modelValue" :title="t('shell.drawer.title')" size="380px" data-test="task-drawer" @update:model-value="$emit('update:modelValue', $event)">
    <div class="bar">
      <el-button size="small" :loading="loading" @click="load">{{ t('shell.drawer.refresh') }}</el-button>
      <el-button size="small" type="primary" plain @click="viewAll">{{ t('shell.drawer.viewAll') }}</el-button>
    </div>
    <el-empty v-if="!loading && !items.length" :description="t('shell.drawer.empty')" :image-size="64" />
    <ul v-else class="list">
      <li v-for="k in items" :key="k.id" class="task" :data-test="`task-${k.id}`">
        <div class="head">
          <span class="id">{{ t('shell.task.untitled', { id: k.id }) }}</span>
          <el-tag size="small" :type="stateTagType(k.state)">{{ stateText(k.state) }}</el-tag>
        </div>
        <div class="meta">{{ meta(k) }}</div>
        <div v-if="errorText(k)" class="err">{{ errorText(k) }}</div>
      </li>
    </ul>
  </el-drawer>
</template>

<script setup>
import { onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from '@/i18n'
import { shellApi } from './api.js'
import { errorText, stateTagType } from '@/utils/aiTaskView'

const props = defineProps({ modelValue: { type: Boolean, default: false } })
const emit = defineEmits(['update:modelValue'])

const { t } = useI18n()
const router = useRouter()
const items = ref([])
const loading = ref(false)
let timer = null

const stateText = (s) => {
  const key = `shell.task.state.${s}`
  const text = t(key)
  return text === key ? String(s) : text
}
// 对象列：只用不含文案的信息（类型 + 镜头 id）；详细说明在任务中心
function meta(k) {
  const g = k.params?._gen
  const shot = g?.storyboard_id ?? k.params?._vo?.legacy_id
  return [k.kind || k.type || g?.kind || '', shot ? `#${shot}` : ''].filter(Boolean).join(' ')
}

async function load() {
  loading.value = true
  try { items.value = await shellApi.recentTasks(20) } catch (_) { /* 静默：抽屉里保持上一次的列表 */ } finally { loading.value = false }
}
function viewAll() {
  emit('update:modelValue', false)
  router.push({ name: 'task-center' })
}

watch(() => props.modelValue, (open) => {
  clearInterval(timer)
  if (open) {
    load()
    timer = setInterval(load, 4000)
  }
}, { immediate: true })
onBeforeUnmount(() => clearInterval(timer))
</script>

<style scoped>
.bar { display: flex; gap: 8px; margin-bottom: 12px; }
.list { margin: 0; padding: 0; list-style: none; }
.task { padding: 10px 0; border-bottom: 1px solid var(--border-color); }
.head { display: flex; align-items: center; justify-content: space-between; }
.id { font-weight: 600; }
.meta { margin-top: 2px; color: var(--text-subtle); font-size: 12px; }
.err { margin-top: 4px; color: #ef4444; font-size: 12px; }
</style>
