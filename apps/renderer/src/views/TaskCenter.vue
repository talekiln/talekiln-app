<template>
  <div class="task-center">
    <header class="header">
      <div class="header-inner">
        <h1 class="logo" role="link" tabindex="0" @click="goList" @keydown.enter="goList">{{ t('home.tasks.title') }}</h1>
        <el-radio-group v-model="filter" size="small" @change="onFilter">
          <el-radio-button v-for="key in FILTER_KEYS" :key="key" :value="key">{{ t(`home.tasks.filter.${key}`) }}</el-radio-button>
        </el-radio-group>
        <el-button class="btn-back" data-test="tasks-back" @click="goList">{{ t('home.back') }}</el-button>
      </div>
    </header>

    <main class="main">
      <el-table v-loading="loading" :data="tasks" :empty-text="t('home.tasks.empty')" row-key="id">
        <el-table-column :label="t('home.tasks.col.provider')" width="130">
          <template #default="{ row }">{{ row.provider_name || row.provider }}</template>
        </el-table-column>
        <el-table-column prop="kind" :label="t('home.tasks.col.kind')" width="90" />
        <el-table-column :label="t('home.tasks.col.target')" width="170">
          <template #default="{ row }">{{ targetText(row) }}</template>
        </el-table-column>
        <el-table-column :label="t('home.tasks.col.state')" width="110">
          <template #default="{ row }">
            <el-tag :type="stateTagType(row.state)" size="small">{{ t(taskStateKey(row.state)) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column :label="t('home.tasks.col.error')" min-width="260">
          <template #default="{ row }">
            <span v-if="errorText(row)" class="err">{{ errorText(row) }}</span>
            <el-link
              v-if="showConsoleLink(row)"
              type="primary"
              :underline="false"
              class="console-link"
              @click="openConsole(row)"
            >{{ t('home.tasks.openConsole', { name: row.provider_name || row.provider }) }}</el-link>
          </template>
        </el-table-column>
        <el-table-column :label="t('home.tasks.col.created')" width="170">
          <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
        </el-table-column>
        <el-table-column :label="t('home.tasks.col.actions')" width="150" fixed="right">
          <template #default="{ row }">
            <el-button v-if="canRetry(row)" size="small" type="primary" @click="retry(row)">{{ t('home.tasks.retry') }}</el-button>
            <el-button v-if="canCancel(row)" size="small" @click="cancel(row)">{{ t('common.cancel') }}</el-button>
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
import { useI18n } from '@/i18n'
import { aiTasksAPI } from '@/api/aiTasks'
import {
  filterStates, stateTagType, canRetry, canCancel,
  showConsoleLink, consoleUrl, formatTime, retryRequest, refreshInterval
} from '@/utils/aiTaskView'
import { taskErrorKey, taskStateKey, taskTargetInfo } from '@/utils/homeModel'

const FILTER_KEYS = ['all', 'running', 'failed', 'done']

const { t } = useI18n()
const router = useRouter()
const tasks = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = 50
const filter = ref('all')
const loading = ref(false)
let timer = null

// 失败原因：已知错误码按界面语言翻译；不认识的错误码才用服务端给的可读文字。
function errorText(task) {
  const key = taskErrorKey(task)
  if (!key) return ''
  if (key === 'home.tasks.err.UNKNOWN' && task.error_readable) return task.error_readable
  return t(key)
}

function targetText(task) {
  const info = taskTargetInfo(task)
  return info ? t(info.key, { shot: info.shot }) : ''
}

async function load(silent = false) {
  if (!silent) loading.value = true
  try {
    const data = await aiTasksAPI.list({ page: page.value, page_size: pageSize, state: filterStates(filter.value) })
    tasks.value = data.items || []
    total.value = data.pagination ? data.pagination.total : tasks.value.length
  } catch (_) {
    /* request.js 已经提示过错误 */
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
      await ElMessageBox.confirm(t('home.tasks.retryConfirm'), t('home.tasks.retryConfirmTitle'), {
        confirmButtonText: t('home.tasks.retryAnyway'), cancelButtonText: t('common.cancel'), type: 'warning'
      })
    } catch (_) { return }
  }
  try {
    await aiTasksAPI.retry(req.id, req.body)
    ElMessage.success(t('home.tasks.requeued'))
    load()
  } catch (_) { /* 拦截器已提示 */ }
}

async function cancel(row) {
  try {
    await aiTasksAPI.cancel(row.id)
    ElMessage.success(t('home.tasks.cancelled'))
    load()
  } catch (_) { /* 拦截器已提示 */ }
}

// https 链接由桌面外壳交给系统浏览器（window open handler）。
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
.logo { margin: 0; font-size: 18px; cursor: pointer; color: var(--text-bright); }
.btn-back { margin-left: auto; }
.main { padding: 16px 24px; }
.err { color: var(--el-color-danger); margin-right: 8px; }
.console-link { vertical-align: baseline; }
.pager { margin-top: 12px; justify-content: center; }
</style>
