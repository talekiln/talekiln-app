<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, errorText } from '../api.js'
import { INVITE_STATUS, formatTime, invitesToCsv } from '../format.js'
import { can } from '../permissions.js'
import { me } from '../session.js'

const canWrite = computed(() => can(me.value, 'ops:write'))

const rows = ref([])
const loading = ref(false)
const status = ref('')
const form = reactive({ count: 1, plan: 'test', expiresInDays: 30 })
const creating = ref(false)
const created = ref([])
const showCreated = ref(false)

async function load() {
  loading.value = true
  try {
    rows.value = await api.listInvites(status.value || undefined)
  } catch (e) {
    ElMessage.error(errorText(e))
  } finally {
    loading.value = false
  }
}

async function create() {
  creating.value = true
  try {
    created.value = await api.createInvites({
      count: form.count,
      plan: form.plan || undefined,
      expiresInDays: form.expiresInDays || undefined,
    })
    showCreated.value = true
    await load()
  } catch (e) {
    ElMessage.error(errorText(e))
  } finally {
    creating.value = false
  }
}

async function revoke(row) {
  try {
    await ElMessageBox.confirm(`确定吊销邀请码 ${row.code}？吊销后无法再用于注册。`, '吊销邀请码', { type: 'warning' })
  } catch {
    return
  }
  try {
    await api.revokeInvite(row.id)
    ElMessage.success('已吊销')
    await load()
  } catch (e) {
    ElMessage.error(errorText(e))
  }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('已复制')
  } catch {
    ElMessage.warning('复制失败，请手动选择文字')
  }
}

function downloadCsv() {
  const blob = new Blob([invitesToCsv(created.value)], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `邀请码-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}

onMounted(load)
</script>

<template>
  <div class="page">
    <h2 class="page-title">邀请码管理</h2>

    <div class="section">
      <h3>创建</h3>
      <div class="toolbar">
        <span>数量</span>
        <el-input-number v-model="form.count" :min="1" :max="200" />
        <span>套餐</span>
        <el-input v-model="form.plan" style="width: 120px" />
        <span>有效天数</span>
        <el-input-number v-model="form.expiresInDays" :min="0" :max="365" />
        <span class="muted">0 = 永不过期；一次最多 200 个</span>
        <el-button type="primary" :disabled="!canWrite" :loading="creating" @click="create">生成邀请码</el-button>
      </div>
    </div>

    <div class="toolbar">
      <el-select v-model="status" placeholder="全部状态" clearable style="width: 150px" @change="load">
        <el-option v-for="(v, k) in INVITE_STATUS" :key="k" :label="v.label" :value="k" />
      </el-select>
      <el-button @click="load">刷新</el-button>
    </div>

    <el-table v-loading="loading" :data="rows" border stripe empty-text="暂无邀请码">
      <el-table-column label="邀请码" min-width="190">
        <template #default="{ row }"><span class="mono">{{ row.code }}</span></template>
      </el-table-column>
      <el-table-column prop="plan" label="套餐" width="90" />
      <el-table-column label="状态" width="100">
        <template #default="{ row }"><el-tag :type="INVITE_STATUS[row.status].type">{{ INVITE_STATUS[row.status].label }}</el-tag></template>
      </el-table-column>
      <el-table-column label="创建时间" width="160"><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></el-table-column>
      <el-table-column label="过期时间" width="160"><template #default="{ row }">{{ row.expiresAt ? formatTime(row.expiresAt) : '永不过期' }}</template></el-table-column>
      <el-table-column label="使用时间" width="160"><template #default="{ row }">{{ formatTime(row.usedAt) }}</template></el-table-column>
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="copy(row.code)">复制</el-button>
          <el-button v-if="row.status === 'unused' && canWrite" link type="danger" @click="revoke(row)">吊销</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="showCreated" title="已生成邀请码" width="520px">
      <p class="muted">邀请码之后也可在列表中随时查看。请妥善发放，每个邀请码只能注册一个账号。</p>
      <el-input type="textarea" :rows="Math.min(created.length, 10)" readonly :model-value="created.map((c) => c.code).join('\n')" class="mono" />
      <template #footer>
        <el-button @click="copy(created.map((c) => c.code).join('\n'))">复制全部</el-button>
        <el-button @click="downloadCsv">下载 CSV</el-button>
        <el-button type="primary" @click="showCreated = false">完成</el-button>
      </template>
    </el-dialog>
  </div>
</template>
