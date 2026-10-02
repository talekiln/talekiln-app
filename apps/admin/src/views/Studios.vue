<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, errorText } from '../api.js'
import { formatTime } from '../format.js'
import { can } from '../permissions.js'
import { me } from '../session.js'
import { SEAT_PRICING_NOTE, STATUS_OPTIONS, inviteRow, memberRow, seatBody, studioRow, validateSeatLimit } from '../studios.js'

const rows = ref([])
const loading = ref(false)
const detail = ref(null)
const drawer = ref(false)
const busy = ref(false)
const canWrite = computed(() => can(me.value, 'ops:write'))
const members = computed(() => (detail.value ? detail.value.members.map(memberRow) : []))
const invites = computed(() => (detail.value ? detail.value.invites.map(inviteRow) : []))

async function load() {
  loading.value = true
  try {
    rows.value = (await api.listStudios()).map(studioRow)
  } catch (e) {
    ElMessage.error(errorText(e))
  } finally {
    loading.value = false
  }
}

async function open(row) {
  try {
    detail.value = await api.getStudio(row.id)
    drawer.value = true
  } catch (e) {
    ElMessage.error(errorText(e))
  }
}

async function editSeats(row) {
  let value
  try {
    ;({ value } = await ElMessageBox.prompt(`「${row.name}」当前 ${row.seatLabel}。${SEAT_PRICING_NOTE}`, '调整席位数', {
      inputValue: String(row.seatLimit),
      inputValidator: (v) => validateSeatLimit(v, row.seats) || true,
    }))
  } catch {
    return
  }
  busy.value = true
  try {
    await api.setStudioSeats(row.id, seatBody(value))
    ElMessage.success('席位数已更新')
    await load()
    if (detail.value && detail.value.id === row.id) detail.value = await api.getStudio(row.id)
  } catch (e) {
    ElMessage.error(errorText(e))
  } finally {
    busy.value = false
  }
}

async function toggleStatus(row) {
  const next = row.status === 'suspended' ? 'active' : 'suspended'
  const label = STATUS_OPTIONS.find((o) => o.value === next).label
  try {
    await ElMessageBox.confirm(`把「${row.name}」设为${label}？${next === 'suspended' ? '停用后成员只能查看，不能邀请或发布。' : ''}`, '修改状态', { type: 'warning' })
  } catch {
    return
  }
  busy.value = true
  try {
    await api.setStudioStatus(row.id, next)
    ElMessage.success(`已设为${label}`)
    await load()
  } catch (e) {
    ElMessage.error(errorText(e))
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <div>
    <div class="toolbar">
      <h2>工作室</h2>
      <el-button :loading="loading" @click="load">刷新</el-button>
      <span class="hint">{{ SEAT_PRICING_NOTE }}</span>
    </div>
    <el-table :data="rows" v-loading="loading" size="small" stripe>
      <el-table-column label="名称" min-width="160">
        <template #default="{ row }"><el-link type="primary" @click="open(row)">{{ row.name }}</el-link></template>
      </el-table-column>
      <el-table-column label="所有者" prop="ownerText" min-width="180" />
      <el-table-column label="席位" width="200">
        <template #default="{ row }"><el-tag :type="row.seatTag.type" size="small">{{ row.seatTag.label }}</el-tag></template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }"><el-tag :type="row.statusTag.type" size="small">{{ row.statusTag.label }}</el-tag></template>
      </el-table-column>
      <el-table-column label="创建时间" width="170">
        <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column v-if="canWrite" label="操作" width="200">
        <template #default="{ row }">
          <el-button size="small" :disabled="busy" @click="editSeats(row)">调整席位</el-button>
          <el-button size="small" :type="row.status === 'suspended' ? 'success' : 'danger'" plain :disabled="busy" @click="toggleStatus(row)">{{ row.status === 'suspended' ? '恢复' : '停用' }}</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-drawer v-model="drawer" size="55%" :title="detail ? `${detail.name} · 成员与邀请` : ''">
      <template v-if="detail">
        <p class="hint">所有者 {{ detail.owner_email || detail.ownerId }} · 席位 {{ detail.seats.used }} / {{ detail.seats.limit }}（{{ detail.seats.pending }} 份待处理邀请）</p>
        <h3>成员</h3>
        <el-table :data="members" size="small">
          <el-table-column label="邮箱" min-width="200">
            <template #default="{ row }">{{ row.email || row.account_id }}</template>
          </el-table-column>
          <el-table-column label="角色" prop="roleLabel" width="90" />
          <el-table-column label="状态" prop="statusLabel" width="90" />
          <el-table-column label="加入" width="160">
            <template #default="{ row }">{{ formatTime(row.joined_at) }}</template>
          </el-table-column>
          <el-table-column label="移除" width="160">
            <template #default="{ row }">{{ row.removed_at ? formatTime(row.removed_at) : '—' }}</template>
          </el-table-column>
        </el-table>
        <h3>邀请</h3>
        <el-table :data="invites" size="small">
          <el-table-column label="邀请码" prop="code" width="130" />
          <el-table-column label="对象" prop="target" min-width="180" />
          <el-table-column label="角色" prop="roleLabel" width="90" />
          <el-table-column label="状态" prop="state" width="90" />
          <el-table-column label="有效期至" width="160">
            <template #default="{ row }">{{ formatTime(row.expires_at) }}</template>
          </el-table-column>
        </el-table>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.toolbar h2 { margin: 0; }
.hint { color: #6b7280; font-size: 12px; }
h3 { font-size: 14px; margin: 16px 0 8px; }
</style>
