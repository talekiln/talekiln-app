<template>
  <div class="sb-shell">
  <ViewSwitcher />
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
      <el-button plain data-test="open-batch" @click="$router.push(`/project/${$route.params.dramaId}/batch`)">批量生成</el-button>
      <el-button plain :disabled="!episodeId" title="用一句话描述修改，先看计划与花费再执行（可整体撤销）" data-test="open-director" @click="openDirector(episodeId)">导演模式</el-button>
      <el-button type="success" plain :disabled="!rows.length || !episodeId" data-test="generate-all" @click="gen.ask({ shots: 'all', kind: 'both' })">
        生成全部首帧与视频
      </el-button>
      <el-button text @click="$router.push('/task-center')">任务中心</el-button>
      <el-button type="primary" plain :loading="adding" @click="addRow">
        <el-icon><Plus /></el-icon>添加镜头
      </el-button>
    </div>

    <el-table v-loading="loading" :data="rows" row-key="id" border empty-text="暂无分镜" :row-class-name="rowClass" @row-click="onRowClick">
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
      <el-table-column label="状态" width="110" align="center">
        <template #default="{ row }">
          <el-tooltip :disabled="!genFailure(row)" :content="genFailure(row)" placement="top">
            <el-tag v-if="gen.chip(row.id)" size="small" :type="gen.chip(row.id).type" data-test="gen-chip">{{ gen.chip(row.id).label }}</el-tag>
            <el-tag v-else size="small" :type="row.status === 'completed' ? 'success' : row.status === 'failed' ? 'danger' : 'info'">{{ statusLabel(row.status) }}</el-tag>
          </el-tooltip>
          <!-- P3-C 一致性：与锁定参考图的评分（只读） -->
          <el-tooltip v-if="consChip(row.id)" :content="consHint(row.id)" placement="top">
            <el-tag size="small" :type="consChip(row.id).type" class="cons-tag" data-test="consistency-chip">{{ consChip(row.id).label }}</el-tag>
          </el-tooltip>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="260" align="center">
        <template #default="{ row, $index }">
          <el-button link type="success" :disabled="isBusy(gen.shotStatus(row.id))" data-test="generate-row" @click="gen.ask({ shots: [row.id], kind: 'both' })">生成</el-button>
          <el-button link type="primary" @click="$router.push(`/project/${$route.params.dramaId}/shot/${row.id}`)">工作台</el-button>
          <el-button link :disabled="$index === 0" title="上移" @click="move($index, $index - 1)"><el-icon><ArrowUp /></el-icon></el-button>
          <el-button link :disabled="$index === rows.length - 1" title="下移" @click="move($index, $index + 1)"><el-icon><ArrowDown /></el-icon></el-button>
          <el-button link type="danger" title="删除" @click="removeShot(row)"><el-icon><Delete /></el-icon></el-button>
        </template>
      </el-table-column>
    </el-table>
    <GenerateDialog :state="gen.dialog.value" @confirm="gen.confirm" @cancel="gen.cancel" />
  </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowDown, ArrowLeft, ArrowUp, Delete, Plus } from '@element-plus/icons-vue'
import { dramaAPI } from '@/api/drama'
import { storyboardsAPI } from '@/api/storyboards'
import { scriptgenAPI } from '@/api/scriptgen'
import { consistencyAPI } from '@/api/consistency'
import GenerateDialog from '@/components/GenerateDialog.vue'
import ViewSwitcher from '@/components/ViewSwitcher.vue'
import { useProjectViewsStore } from '@/stores/projectViews'
import { useGeneration } from '@/composables/useGeneration'
import { openDirector } from '@/composables/useDirectorPanel'
import { failureText, isBusy } from '@/utils/generationView'
import { badgeForShot, busyCount, consistencyHint, consistencyShotMap } from '@/utils/consistencyView'
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
// 四视图共享状态：选择 / 历史 / 过期数。分镜表自己的编辑仍走旧接口（已改道经内核），保存后从共享 store 刷新
const views = useProjectViewsStore()
const focusShot = computed(() => views.focusFor('shots'))
const focusLegacy = computed(() => (focusShot.value ? views.index.shotById[focusShot.value.id]?.legacy_id : null))
const rowClass = ({ row }) => (focusLegacy.value != null && row.id === focusLegacy.value ? 'is-focus' : '')
function onRowClick(row) {
  const id = views.index.shotByLegacy[row.id]
  if (id) views.select({ kind: 'shot', id })
}
// 出图 / 出视频：走持久队列（估算 -> 确认 -> 任务中心），结果写回后状态芯片变“最新”
const gen = useGeneration(episodeId)
const genFailure = (row) => failureText(gen.shotStatus(row.id))
const saver = createAutosaver({ delay: 800, onState: (s) => { saveState.value = s } })
// P3-C 一致性评分（只读）：按旧表 id 查；一批任务跑完后拉一次、稍后再拉一次（评分在写回后后台完成）
const consistency = ref(null)
const consMap = computed(() => consistencyShotMap(consistency.value))
const consChip = (id) => badgeForShot(consMap.value, id)
const consHint = (id) => consistencyHint(consMap.value.get(Number(id)), consistency.value?.min_score, consistency.value)
let consTimer = null
async function loadConsistency() {
  if (!episodeId.value) return
  try { consistency.value = await consistencyAPI.episodeReport(episodeId.value) } catch (_) { /* request.js 已提示 */ }
}
watch(() => busyCount(gen.status.value), (now, before) => {
  if (before > 0 && now === 0) {
    loadConsistency()
    clearTimeout(consTimer)
    consTimer = setTimeout(loadConsistency, 4000)
  }
})

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
    gen.refresh()
    loadConsistency()
    views.load(episodeId.value, { drama: route.params.dramaId })
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

// 保存完成 -> 共享 store 刷新（其它视图立刻看到）；在别的地方撤销 / 重做后 -> 重新读取分镜行
watch(saveState, (s, old) => { if (s === 'saved' && old !== 'saved' && episodeId.value) views.refresh() })
watch(() => views.revision, () => { if (saveState.value === 'saved') load() })

onMounted(() => {
  load()
  window.addEventListener('beforeunload', beforeUnload)
})
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnload)
  clearTimeout(consTimer)
})
</script>

<style scoped>
.sb-shell { min-height: 100vh; }
:deep(.el-table .is-focus > td.el-table__cell) { background: var(--el-color-primary-light-9) !important; }
.storyboard-page { max-width: 1200px; margin: 0 auto; padding: 24px; }
.page-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.page-title { margin: 0; font-size: 20px; }
.summary { color: var(--el-text-color-secondary); font-size: 13px; }
.spacer { flex: 1; }
.clickable { cursor: pointer; }
.thumb { width: 90px; height: 90px; border-radius: 4px; display: block; margin: 0 auto; }
.thumb-empty { display: flex; align-items: center; justify-content: center; background: var(--el-fill-color-light); color: var(--el-text-color-placeholder); font-size: 12px; }
.warn { margin-top: 4px; font-size: 12px; color: var(--el-color-warning); }
.cons-tag { margin-top: 4px; }
</style>
