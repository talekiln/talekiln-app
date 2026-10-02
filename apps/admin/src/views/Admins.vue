<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, errorText } from '../api.js'
import { formatTime } from '../format.js'
import { AUDIT_ACTION_OPTIONS, auditActionLabel, auditSummary, validateGrant } from '../ops.js'
import { ROLE_LABEL, ROLE_OPTIONS, roleLabel } from '../permissions.js'
import { ensureMe, me } from '../session.js'

const tab = ref('admins')
const admins = ref([])
const audit = ref([])
const loading = ref(false)
const dialog = ref(false)
const saving = ref(false)
const form = reactive({ email: '', role: 'OPERATOR', password: '' })
const filter = reactive({ action: '', actorId: '' })
const exhausted = ref(false)
const PAGE = 100

async function loadAdmins() {
  loading.value = true
  try {
    admins.value = await api.listAdmins()
  } catch (e) {
    ElMessage.error(errorText(e))
  } finally {
    loading.value = false
  }
}

async function loadAudit(more = false) {
  loading.value = true
  try {
    const before = more && audit.value.length ? audit.value[audit.value.length - 1].at : undefined
    const rows = await api.listAudit({ action: filter.action || undefined, actorId: filter.actorId || undefined, before, limit: PAGE })
    audit.value = more ? [...audit.value, ...rows] : rows
    exhausted.value = rows.length < PAGE
  } catch (e) {
    ElMessage.error(errorText(e))
  } finally {
    loading.value = false
  }
}

function openGrant() {
  Object.assign(form, { email: '', role: 'OPERATOR', password: '' })
  dialog.value = true
}

async function grant() {
  const err = validateGrant(form)
  if (err) return ElMessage.warning(err)
  saving.value = true
  try {
    await api.grantAdmin({ email: form.email.trim(), role: form.role, password: form.password || undefined })
    dialog.value = false
    ElMessage.success('已授予')
    await loadAdmins()
  } catch (e) {
    ElMessage.error(errorText(e))
  } finally {
    saving.value = false
  }
}

async function changeRole(row, role) {
  if (role === row.role) return
  try {
    await ElMessageBox.confirm(`把 ${row.email} 的角色改为「${roleLabel(role)}」？立即生效。`, '修改角色', { type: 'warning' })
    await api.setAdminRole(row.accountId, role)
    ElMessage.success('已修改')
    if (row.email === me.value?.email) await ensureMe(true)
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(errorText(e))
  }
  await loadAdmins()
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`撤销 ${row.email} 的管理员身份？账号本身保留，但立即无法登录后台。`, '撤销管理员', { type: 'warning' })
    await api.removeAdmin(row.accountId)
    ElMessage.success('已撤销')
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(errorText(e))
  }
  await loadAdmins()
}

function onTab(name) {
  if (name === 'audit' && !audit.value.length) loadAudit()
}

onMounted(loadAdmins)
</script>

<template>
  <div class="page">
    <h2 class="page-title">管理员与审计</h2>
    <el-tabs v-model="tab" @tab-change="onTab">
      <el-tab-pane label="管理员" name="admins">
        <div class="toolbar">
          <el-button type="primary" @click="openGrant">授予管理员</el-button>
          <el-button @click="loadAdmins">刷新</el-button>
          <span class="muted">角色即时生效；至少保留一个可用的“管理员”。</span>
        </div>
        <el-table v-loading="loading" :data="admins" border stripe empty-text="暂无管理员">
          <el-table-column prop="email" label="邮箱" min-width="220" />
          <el-table-column label="角色" width="180">
            <template #default="{ row }">
              <el-select :model-value="row.role" size="small" @change="(r) => changeRole(row, r)">
                <el-option v-for="r in ROLE_OPTIONS" :key="r.value" :label="r.label" :value="r.value" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="说明" min-width="300"><template #default="{ row }"><span class="muted">{{ (ROLE_LABEL[row.role] || {}).desc }}</span></template></el-table-column>
          <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag :type="row.disabled ? 'danger' : 'success'" size="small">{{ row.disabled ? '已禁用' : '正常' }}</el-tag></template></el-table-column>
          <el-table-column label="授予时间" width="160"><template #default="{ row }">{{ formatTime(row.since) }}<el-tag v-if="row.legacy" size="small" type="info" style="margin-left: 4px">初始</el-tag></template></el-table-column>
          <el-table-column label="操作" width="90"><template #default="{ row }"><el-button link type="danger" @click="remove(row)">撤销</el-button></template></el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="审计日志" name="audit">
        <div class="toolbar">
          <el-select v-model="filter.action" placeholder="全部操作" clearable filterable style="width: 220px" @change="loadAudit()">
            <el-option v-for="o in AUDIT_ACTION_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
          <el-select v-model="filter.actorId" placeholder="全部操作者" clearable style="width: 240px" @change="loadAudit()">
            <el-option v-for="a in admins" :key="a.accountId" :label="a.email" :value="a.accountId" />
          </el-select>
          <el-button @click="loadAudit()">刷新</el-button>
          <span class="muted">记录所有管理写操作、登录和越权尝试；口令、密钥、令牌已脱敏，日志只增不改。</span>
        </div>
        <el-table v-loading="loading" :data="audit" size="small" border stripe empty-text="暂无记录">
          <el-table-column label="时间" width="160"><template #default="{ row }">{{ formatTime(row.at) }}</template></el-table-column>
          <el-table-column label="操作者" min-width="190">
            <template #default="{ row }">{{ row.actorEmail || '—' }} <el-tag v-if="row.actorRole" size="small" type="info">{{ roleLabel(row.actorRole) }}</el-tag></template>
          </el-table-column>
          <el-table-column label="操作" width="170"><template #default="{ row }">{{ auditActionLabel(row.action) }}</template></el-table-column>
          <el-table-column label="对象与内容" min-width="320" show-overflow-tooltip><template #default="{ row }"><span class="mono">{{ auditSummary(row) }}</span></template></el-table-column>
          <el-table-column label="结果" width="90">
            <template #default="{ row }"><el-tag :type="row.ok ? 'success' : 'danger'" size="small">{{ row.ok ? '成功' : '失败' }} {{ row.status }}</el-tag></template>
          </el-table-column>
          <el-table-column label="来源 IP" width="130"><template #default="{ row }"><span class="mono">{{ row.ip || '—' }}</span></template></el-table-column>
        </el-table>
        <div style="margin-top: 12px"><el-button :disabled="exhausted" @click="loadAudit(true)">{{ exhausted ? '没有更早的记录了' : '加载更早的记录' }}</el-button></div>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="dialog" title="授予管理员" width="480px">
      <el-form label-width="90px">
        <el-form-item label="邮箱"><el-input v-model="form.email" placeholder="已有账号则直接授予" /></el-form-item>
        <el-form-item label="角色">
          <el-radio-group v-model="form.role"><el-radio v-for="r in ROLE_OPTIONS" :key="r.value" :value="r.value">{{ r.label }}</el-radio></el-radio-group>
          <div class="muted" style="width: 100%">{{ (ROLE_LABEL[form.role] || {}).desc }}</div>
        </el-form-item>
        <el-form-item label="初始口令"><el-input v-model="form.password" type="password" show-password placeholder="邮箱尚无账号时必填，至少 12 位" autocomplete="new-password" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="grant">授予</el-button>
      </template>
    </el-dialog>
  </div>
</template>
