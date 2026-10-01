<template>
  <div class="task-center">
    <header class="header">
      <div class="header-inner">
        <h1 class="logo" @click="goList">任务中心</h1>
        <el-radio-group v-model="filter" size="small" @change="onFilter">
          <el-radio-button v-for="f in FILTERS" :key="f.key" :value="f.key">{{ f.label }}</el-radio-button>
        </el-radio-group>
        <el-button class="btn-back" @click="goList">返回</el-button>
      </div>
    </header>

    <main class="main">
      <el-table :data="tasks" v-loading="loading" empty-text="暂无 AI 任务" row-key="id">
        <el-table-column label="服务商" width="130">
          <template #default="{ row }">{{ row.provider_name || row.provider }}</template>
        </el-table-column>
        <el-table-column prop="kind" label="类型" width="90" />
        <el-table-column label="对象" width="150">
          <template #default="{ row }">{{ taskTarget(row) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="stateTagType(row.state)" size="small">{{ stateLabel(row.state) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="失败原因" min-width="260">
          <template #default="{ row }">
            <span v-if="errorText(row)" class="err">{{ errorText(row) }}</span>
            <el-link
              v-if="showConsoleLink(row)"
              type="primary"
              :underline="false"
              class="console-link"
              @click="openConsole(row)"
            >打开 {{ row.provider_name || row.provider }} 控制台</el-link>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="170">
          <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button v-if="canRetry(row)" size="small" type="primary" @click="retry(row)">重试</el-button>
            <el-button v-if="canCancel(row)" size="small" @click="cancel(row)">取消</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination
        v-if="total > pageSize"
        class="pager"
        layout="prev, pager, next"
        :page-size="pageSize"
        :total="total"
        :current-page="page"
        @current-change="(p) => { page = p; load() }"
      />
    </main>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { aiTasksAPI } from '@/api/aiTasks'
import {
  FILTERS, filterStates, stateLabel, stateTagType, errorText, canRetry, canCancel,
  showConsoleLink, consoleUrl, formatTime, retryRequest, refreshInterval
} from '@/utils/aiTaskView'
import { taskTarget } from '@/utils/generationView'

const router = useRouter()
const tasks = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = 50
const filter = ref('all')
const loading = ref(false)
let timer = null

async function load(silent = false) {
  if (!silent) loading.value = true
  try {
    const data = await aiTasksAPI.list({ page: page.value, page_size: pageSize, state: filterStates(filter.value) })
    tasks.value = data.items || []
    total.value = data.pagination ? data.pagination.total : tasks.value.length
  } catch (_) {
    /* request.js already showed the error */
  } finally {
    loading.value = false
    clearTimeout(timer)
    timer = setTimeout(() => load(true), refreshInterval(tasks.value))
  }
}

function onFilter() {
  page.value = 1
  load()
}

async function retry(row) {
  const req = retryRequest(row)
  if (req.needsConfirm) {
    try {
      await ElMessageBox.confirm('提交结果不确定，重试可能在服务商处重复生成并扣费。请确认已在服务商控制台核对过。', '确认重试', {
        confirmButtonText: '仍然重试', cancelButtonText: '取消', type: 'warning'
      })
    } catch (_) { return }
  }
  try {
    await aiTasksAPI.retry(req.id, req.body)
    ElMessage.success('已重新加入队列')
    load()
  } catch (_) { /* shown by interceptor */ }
}

async function cancel(row) {
  try {
    await aiTasksAPI.cancel(row.id)
    ElMessage.success('已取消')
    load()
  } catch (_) { /* shown by interceptor */ }
}

// https links are handed to the system browser by the desktop shell (window open handler).
function openConsole(row) {
  const url = consoleUrl(row)
  if (url) window.open(url, '_blank', 'noopener')
}

function goList() {
  router.push({ name: 'list' })
}

onMounted(load)
onBeforeUnmount(() => clearTimeout(timer))
</script>

<style scoped>
.task-center { min-height: 100vh; background: var(--bg-page); color: var(--text-primary); }
.header-inner { display: flex; align-items: center; gap: 16px; padding: 12px 24px; }
.logo { margin: 0; font-size: 18px; cursor: pointer; }
.btn-back { margin-left: auto; }
.main { padding: 16px 24px; }
.err { color: var(--el-color-danger); margin-right: 8px; }
.console-link { vertical-align: baseline; }
.pager { margin-top: 12px; justify-content: center; }
</style>
