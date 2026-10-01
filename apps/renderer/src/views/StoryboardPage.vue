<template>
  <div class="storyboard-page">
    <div class="page-header">
      <el-button text @click="$router.push('/')">
        <el-icon><ArrowLeft /></el-icon>
        项目列表
      </el-button>
      <h2 class="page-title">{{ title || '分镜表' }}</h2>
      <span class="summary">共 {{ rows.length }} 镜 · {{ total.toFixed(1) }} 秒</span>
      <span class="spacer" />
      <el-tag
        :type="saveState === 'error' ? 'danger' : saveState === 'saved' ? 'success' : 'warning'"
        :class="{ clickable: saveState === 'error' }"
        data-test="save-indicator"
        @click="saveState === 'error' && retry()"
      >{{ saveStateText(saveState) }}</el-tag>
      <el-button plain @click="$router.push(`/project/${$route.params.dramaId}/library`)">角色与场景库</el-button>
      <el-button type="primary" plain :loading="adding" @click="addRow">
        <el-icon><Plus /></el-icon>添加镜头
      </el-button>
    </div>

    <el-table v-loading="loading" :data="rows" row-key="id" border empty-text="暂无分镜">
      <el-table-column label="镜号" width="64" align="center">
        <template #default="{ row }">{{ row.no }}</template>
      </el-table-column>
      <el-table-column label="首帧" width="110" align="center">
        <template #default="{ row }">
          <el-image v-if="row.thumb" :src="row.thumb" fit="cover" class="thumb" lazy />
          <div v-else class="thumb thumb-empty">未生成</div>
        </template>
      </el-table-column>
      <el-table-column label="画面描述" min-width="280">
        <template #default="{ row }">
          <el-input v-model="row.description" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }" @input="touch(row)" />
          <div v-for="w in rowWarnings(row)" :key="w" class="warn">{{ w }}</div>
        </template>
      </el-table-column>
      <el-table-column label="台词" min-width="200">
        <template #default="{ row }">
          <el-input v-model="row.dialogue" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }" placeholder="无台词" @input="touch(row)" />
        </template>
      </el-table-column>
      <el-table-column label="时长（秒）" width="130" align="center">
        <template #default="{ row }">
          <el-input-number v-model="row.duration" :min="0.5" :max="30" :step="0.5" :precision="1" size="small" controls-position="right" @change="touch(row)" />
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90" align="center">
        <template #default="{ row }">
          <el-tag size="small" :type="row.status === 'completed' ? 'success' : row.status === 'failed' ? 'danger' : 'info'">{{ statusLabel(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="210" align="center">
        <template #default="{ row, $index }">
          <el-button link type="primary" @click="$router.push(`/project/${$route.params.dramaId}/shot/${row.id}`)">工作台</el-button>
          <el-button link :disabled="$index === 0" title="上移" @click="move($index, $index - 1)"><el-icon><ArrowUp /></el-icon></el-button>
          <el-button link :disabled="$index === rows.length - 1" title="下移" @click="move($index, $index + 1)"><el-icon><ArrowDown /></el-icon></el-button>
          <el-button link type="danger" title="删除" @click="removeShot(row)"><el-icon><Delete /></el-icon></el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave, useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowDown, ArrowLeft, ArrowUp, Delete, Plus } from '@element-plus/icons-vue'
import { dramaAPI } from '@/api/drama'
import { storyboardsAPI } from '@/api/storyboards'
import { scriptgenAPI } from '@/api/scriptgen'
import {
  createAutosaver, moveRow, patchFromRow, removeRow, rowFromApi, rowWarnings,
  saveStateText, sortRows, statusLabel, totalDuration,
} from '@/utils/storyboardTable'

const route = useRoute()
const title = ref('')
const rows = ref([])
const loading = ref(false)
const adding = ref(false)
const saveState = ref('saved')
const episodeId = ref(Number(route.query.episode) || 0)

const total = computed(() => totalDuration(rows.value))
const saver = createAutosaver({ delay: 800, onState: (s) => { saveState.value = s } })

async function load() {
  loading.value = true
  try {
    if (!episodeId.value) {
      const drama = await dramaAPI.get(route.params.dramaId)
      title.value = drama.title
      episodeId.value = drama.episodes?.[0]?.id || 0
    } else {
      dramaAPI.get(route.params.dramaId).then((d) => { title.value = d.title }).catch(() => {})
    }
    if (!episodeId.value) { rows.value = []; return }
    const data = await dramaAPI.getStoryboards(episodeId.value)
    rows.value = sortRows((data.storyboards || []).map(rowFromApi))
  } finally {
    loading.value = false
  }
}

/** 编辑：按 id 防抖保存，任务执行时读取该行最新值。 */
function touch(row) {
  saver.schedule(`u:${row.id}`, async () => {
    const cur = rows.value.find((r) => r.id === row.id)
    if (cur) await storyboardsAPI.update(cur.id, patchFromRow(cur))
  })
}

function scheduleOrder() {
  saver.schedule('order', async () => {
    await scriptgenAPI.reorder(episodeId.value, rows.value.map((r) => r.id))
  })
}

function move(from, to) {
  rows.value = moveRow(rows.value, from, to)
  scheduleOrder()
}

async function addRow() {
  adding.value = true
  try {
    await saver.flush()
    const sb = await storyboardsAPI.create({
      episode_id: episodeId.value,
      storyboard_number: rows.value.length + 1,
      description: '新镜头',
      duration: 3,
    })
    rows.value = [...rows.value, rowFromApi(sb)]
  } catch (e) {
    ElMessage.error(e.message || '添加失败')
  } finally {
    adding.value = false
  }
}

async function removeShot(row) {
  try {
    await ElMessageBox.confirm(`删除第 ${row.no} 镜？`, '删除镜头', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
  } catch (_) { return }
  try {
    saver.cancel(`u:${row.id}`)
    await storyboardsAPI.delete(row.id)
    rows.value = removeRow(rows.value, row.id)
    scheduleOrder()
  } catch (e) {
    ElMessage.error(e.message || '删除失败')
  }
}

async function retry() {
  await saver.flush()
}

function beforeUnload(e) {
  if (saver.state !== 'saved') { e.preventDefault(); e.returnValue = '' }
}

onBeforeRouteLeave(async () => {
  if (saver.state === 'saved') return true
  const ok = await saver.flush()
  if (ok) return true
  try {
    await ElMessageBox.confirm('还有修改未能保存，确定离开？', '未保存', { type: 'warning' })
    return true
  } catch (_) { return false }
})

onMounted(() => {
  load()
  window.addEventListener('beforeunload', beforeUnload)
})
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))
</script>

<style scoped>
.storyboard-page { max-width: 1200px; margin: 0 auto; padding: 24px; }
.page-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.page-title { margin: 0; font-size: 20px; }
.summary { color: var(--el-text-color-secondary); font-size: 13px; }
.spacer { flex: 1; }
.clickable { cursor: pointer; }
.thumb { width: 90px; height: 90px; border-radius: 4px; display: block; margin: 0 auto; }
.thumb-empty { display: flex; align-items: center; justify-content: center; background: var(--el-fill-color-light); color: var(--el-text-color-placeholder); font-size: 12px; }
.warn { margin-top: 4px; font-size: 12px; color: var(--el-color-warning); }
</style>
