<template>
  <el-dialog
    :model-value="state.visible"
    :title="summary.title"
    width="460px"
    :close-on-click-modal="false"
    data-test="generate-dialog"
    @update:model-value="(v) => !v && $emit('cancel')"
  >
    <div v-loading="state.loading" class="body">
      <template v-if="state.preview">
        <ul class="lines">
          <li v-for="l in summary.lines" :key="l">{{ l }}</li>
        </ul>
        <el-alert v-if="summary.blocked" type="error" :closable="false" show-icon :title="summary.blockedText" data-test="cap-blocked" />
        <el-alert v-for="w in summary.warnings" :key="w" type="warning" :closable="false" show-icon :title="w" class="warn" />
        <p class="hint">
          任务在后台队列里执行，关闭窗口或应用也不会丢；进度见
          <router-link to="/task-center" target="_blank">任务中心</router-link>。
        </p>
      </template>
      <div v-else-if="!state.loading" class="empty">无法估算</div>
    </div>
    <template #footer>
      <el-button @click="$emit('cancel')">取消</el-button>
      <el-button type="primary" :loading="state.submitting" :disabled="!summary.canConfirm" data-test="generate-confirm" @click="$emit('confirm')">
        {{ summary.free ? '确定' : '确认并生成' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed } from 'vue'
import { confirmSummary } from '@/utils/generationView'

const props = defineProps({ state: { type: Object, required: true } })
defineEmits(['confirm', 'cancel'])
const summary = computed(() => confirmSummary(props.state.preview))
</script>

<style scoped>
.body { min-height: 80px; }
.lines { margin: 0 0 12px; padding-left: 20px; line-height: 1.8; }
.warn { margin-top: 8px; }
.hint { margin: 12px 0 0; font-size: 12px; color: var(--el-text-color-secondary); }
.empty { color: var(--el-text-color-secondary); }
</style>
