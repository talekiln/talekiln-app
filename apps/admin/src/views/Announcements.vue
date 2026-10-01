<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, errorText } from '../api.js'
import { LEVELS, formatTime } from '../format.js'
import { ANNOUNCE_CHANNELS, announceChannelLabel, announcementBody, announcementState, validateAnnouncement } from '../ops.js'
import { can } from '../permissions.js'
import { me } from '../session.js'

const rows = ref([])
const loading = ref(false)
const saving = ref(false)
const dialog = ref(false)
const editingId = ref(null)
const canWrite = computed(() => can(me.value, 'ops:write'))
const form = reactive({ title: '', body: '', level: 'info', channel: 'all', startsAt: new Date(), endsAt: null, enabled: true })
const levelLabel = (v) => (LEVELS.find((l) => l.value === v) || { label: v }).label

async function load() {
  loading.value = true
  try {
    rows.value = await api.listAnnouncements()
  } catch (e) {
    ElMessage.error(errorText(e))
  } finally {
    loading.value = false
  }
}

function openCreate() {
  editingId.value = null
  Object.assign(form, { title: '', body: '', level: 'info', channel: 'all', startsAt: new Date(), endsAt: null, enabled: true })
  dialog.value = true
}

function openEdit(row) {
  editingId.value = row.id
  Object.assign(form, { title: row.title, body: row.body, level: row.level, channel: row.channel, startsAt: new Date(row.startsAt), endsAt: row.endsAt ? new Date(row.endsAt) : null, enabled: row.enabled })
  dialog.value = true
}

async function save() {
  const err = validateAnnouncement(form)
  if (err) return ElMessage.warning(err)
  saving.value = true
  try {
    const body = announcementBody(form)
    if (editingId.value) await api.updateAnnouncement(editingId.value, body)
    else await api.createAnnouncement(body)
    dialog.value = false
    ElMessage.success('已保存，客户端下次拉取时生效')
    await load()
  } catch (e) {
    ElMessage.error(errorText(e))
  } finally {
    saving.value = false
  }
}

async function toggle(row) {
  try {
    await api.updateAnnouncement(row.id, { enabled: !row.enabled })
    await load()
  } catch (e) {
    ElMessage.error(errorText(e))
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`删除公告「${row.title}」？不可恢复；只想下线可以改为“停用”。`, '删除公告', { type: 'warning' })
    await api.deleteAnnouncement(row.id)
    await load()
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(errorText(e))
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <h2 class="page-title">公告</h2>
    <div class="toolbar">
      <el-button type="primary" :disabled="!canWrite" @click="openCreate">新建公告</el-button>
      <el-button @click="load">刷新</el-button>
      <span class="muted">客户端只会拿到“已启用、在生效时间窗内、渠道匹配”的公告。</span>
    </div>
    <el-table v-loading="loading" :data="rows" border stripe empty-text="暂无公告">
      <el-table-column prop="title" label="标题" min-width="180" />
      <el-table-column label="级别" width="80"><template #default="{ row }">{{ levelLabel(row.level) }}</template></el-table-column>
      <el-table-column label="渠道" width="140"><template #default="{ row }">{{ announceChannelLabel(row.channel) }}</template></el-table-column>
      <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="announcementState(row).type">{{ announcementState(row).label }}</el-tag></template></el-table-column>
      <el-table-column label="生效时间" width="160"><template #default="{ row }">{{ formatTime(row.startsAt) }}</template></el-table-column>
      <el-table-column label="结束时间" width="160"><template #default="{ row }">{{ row.endsAt ? formatTime(row.endsAt) : '不结束' }}</template></el-table-column>
      <el-table-column prop="body" label="正文" min-width="240" show-overflow-tooltip />
      <el-table-column label="操作" width="190" fixed="right">
        <template #default="{ row }">
          <template v-if="canWrite">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link @click="toggle(row)">{{ row.enabled ? '停用' : '启用' }}</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialog" :title="editingId ? '编辑公告' : '新建公告'" width="560px">
      <el-form label-width="90px">
        <el-form-item label="标题"><el-input v-model="form.title" maxlength="100" show-word-limit /></el-form-item>
        <el-form-item label="正文"><el-input v-model="form.body" type="textarea" :rows="4" maxlength="2000" show-word-limit /></el-form-item>
        <el-form-item label="级别">
          <el-radio-group v-model="form.level"><el-radio v-for="l in LEVELS" :key="l.value" :value="l.value">{{ l.label }}</el-radio></el-radio-group>
        </el-form-item>
        <el-form-item label="渠道">
          <el-radio-group v-model="form.channel"><el-radio v-for="c in ANNOUNCE_CHANNELS" :key="c.value" :value="c.value">{{ c.label }}</el-radio></el-radio-group>
        </el-form-item>
        <el-form-item label="生效时间"><el-date-picker v-model="form.startsAt" type="datetime" :clearable="false" /></el-form-item>
        <el-form-item label="结束时间"><el-date-picker v-model="form.endsAt" type="datetime" placeholder="留空 = 不结束" /></el-form-item>
        <el-form-item label="启用"><el-switch v-model="form.enabled" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
