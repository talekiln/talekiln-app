<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, errorText } from '../api.js'
import { formatTime } from '../format.js'
import { can } from '../permissions.js'
import { me } from '../session.js'

const canWrite = computed(() => can(me.value, 'ops:write'))

const rows = ref([])
const loading = ref(false)
const keyword = ref('')
const detail = ref(null)
const drawer = ref(false)

const filtered = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  return k ? rows.value.filter((u) => u.email.toLowerCase().includes(k)) : rows.value
})

async function load() {
  loading.value = true
  try {
    rows.value = await api.listUsers()
  } catch (e) {
    ElMessage.error(errorText(e))
  } finally {
    loading.value = false
  }
}

async function toggle(row) {
  const disable = !row.disabled
  try {
    await ElMessageBox.confirm(
      disable ? `禁用 ${row.email}？该用户将立即无法登录、刷新令牌和续期授权。` : `启用 ${row.email}？`,
      disable ? '禁用用户' : '启用用户',
      { type: disable ? 'warning' : 'info' },
    )
  } catch {
    return
  }
  try {
    await api.setUserDisabled(row.id, disable)
    ElMessage.success(disable ? '已禁用' : '已启用')
    await load()
    if (detail.value && detail.value.id === row.id) await open(row)
  } catch (e) {
    ElMessage.error(errorText(e))
  }
}

async function open(row) {
  try {
    detail.value = await api.getUser(row.id)
    drawer.value = true
  } catch (e) {
    ElMessage.error(errorText(e))
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <h2 class="page-title">用户列表</h2>
    <div class="toolbar">
      <el-input v-model="keyword" placeholder="按邮箱搜索" clearable style="width: 240px" />
      <el-button @click="load">刷新</el-button>
      <span class="muted">共 {{ filtered.length }} 个账号</span>
    </div>

    <el-table v-loading="loading" :data="filtered" border stripe empty-text="暂无用户">
      <el-table-column prop="email" label="邮箱" min-width="220" />
      <el-table-column label="角色" width="90"><template #default="{ row }">{{ row.role === 'ADMIN' ? '管理员' : '用户' }}</template></el-table-column>
      <el-table-column prop="plan" label="套餐" width="90" />
      <el-table-column prop="deviceCount" label="设备数" width="90" />
      <el-table-column label="最近活跃" width="160"><template #default="{ row }">{{ formatTime(row.lastSeenAt) }}</template></el-table-column>
      <el-table-column label="注册时间" width="160"><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }"><el-tag :type="row.disabled ? 'danger' : 'success'">{{ row.disabled ? '已禁用' : '正常' }}</el-tag></template>
      </el-table-column>
      <el-table-column label="操作" width="170" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="open(row)">授权详情</el-button>
          <el-button v-if="row.role !== 'ADMIN' && canWrite" link :type="row.disabled ? 'success' : 'danger'" @click="toggle(row)">
            {{ row.disabled ? '启用' : '禁用' }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-drawer v-model="drawer" title="授权详情" size="460px">
      <template v-if="detail">
        <el-descriptions :column="1" border>
          <el-descriptions-item label="邮箱">{{ detail.email }}</el-descriptions-item>
          <el-descriptions-item label="账号状态">{{ detail.disabled ? '已禁用（' + formatTime(detail.disabledAt) + '）' : '正常' }}</el-descriptions-item>
          <el-descriptions-item label="套餐">{{ detail.licence.plan }}</el-descriptions-item>
          <el-descriptions-item label="功能权益">
            <el-tag v-for="f in detail.licence.entitlements" :key="f" style="margin: 0 6px 6px 0">{{ f }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="授权有效期">{{ detail.licence.validDays }} 天（联网续期）</el-descriptions-item>
          <el-descriptions-item label="离线宽限">{{ detail.licence.graceDays }} 天</el-descriptions-item>
          <el-descriptions-item label="可续期">{{ detail.licence.renewable ? '是' : '否（账号已禁用）' }}</el-descriptions-item>
        </el-descriptions>
        <h4>设备（{{ detail.devices.length }}）</h4>
        <el-table :data="detail.devices" border size="small" empty-text="无设备">
          <el-table-column prop="name" label="名称" />
          <el-table-column label="最近活跃" width="140"><template #default="{ row }">{{ formatTime(row.lastSeenAt) }}</template></el-table-column>
          <el-table-column label="状态" width="80"><template #default="{ row }">{{ row.revokedAt ? '已吊销' : '正常' }}</template></el-table-column>
        </el-table>
      </template>
    </el-drawer>
  </div>
</template>
