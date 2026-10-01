<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, errorText } from '../api.js'
import { formatTime } from '../format.js'
import { CHANNELS, channelLabel, compareSemver, isSemver, releaseBody, releaseState, validateRelease } from '../ops.js'
import { can } from '../permissions.js'
import { me } from '../session.js'

const rows = ref([])
const loading = ref(false)
const saving = ref(false)
const canWrite = computed(() => can(me.value, 'ops:write'))
const dialog = ref(false)
const form = reactive({ version: '', channel: 'stable', rolloutPercent: 10, minVersion: '', forced: false, notes: '' })

// 版本从新到旧排；非法版本号（不应出现）排最后
const sorted = computed(() => [...rows.value].sort((a, b) => (isSemver(a.version) && isSemver(b.version) ? compareSemver(b.version, a.version) : 0)))

async function load() {
  loading.value = true
  try {
    rows.value = await api.listReleases()
  } catch (e) {
    ElMessage.error(errorText(e))
  } finally {
    loading.value = false
  }
}

function openCreate() {
  Object.assign(form, { version: '', channel: 'stable', rolloutPercent: 10, minVersion: '', forced: false, notes: '' })
  dialog.value = true
}

async function create() {
  const err = validateRelease(form)
  if (err) return ElMessage.warning(err)
  saving.value = true
  try {
    await api.createRelease(releaseBody(form))
    dialog.value = false
    ElMessage.success('已创建；客户端下次检查更新时按灰度比例命中')
    await load()
  } catch (e) {
    ElMessage.error(errorText(e))
  } finally {
    saving.value = false
  }
}

async function patch(row, change, confirmText) {
  try {
    if (confirmText) await ElMessageBox.confirm(confirmText, '确认', { type: 'warning' })
    await api.updateRelease(row.id, change)
    await load()
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(errorText(e))
  }
}

async function setPercent(row) {
  try {
    const { value } = await ElMessageBox.prompt(`${row.version}（${channelLabel(row.channel)}）当前 ${row.rolloutPercent}%，改为（0–100 的整数）：`, '调整灰度', {
      inputValue: String(row.rolloutPercent), inputPattern: /^(100|[1-9]?\d)$/, inputErrorMessage: '请输入 0–100 的整数',
    })
    await api.updateRelease(row.id, { rolloutPercent: Number(value) })
    await load()
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(errorText(e))
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <h2 class="page-title">版本灰度</h2>
    <div class="toolbar">
      <el-button type="primary" :disabled="!canWrite" @click="openCreate">新建发布</el-button>
      <el-button @click="load">刷新</el-button>
      <span class="muted">客户端调用“检查更新”时按设备号哈希分档：同一设备结果固定；调高百分比只会纳入更多设备。暂停 = 立刻停止下发（回滚开关）。</span>
    </div>
    <el-table v-loading="loading" :data="sorted" border stripe empty-text="暂无发布">
      <el-table-column prop="version" label="版本" width="140"><template #default="{ row }"><span class="mono">{{ row.version }}</span></template></el-table-column>
      <el-table-column label="通道" width="150"><template #default="{ row }">{{ channelLabel(row.channel) }}</template></el-table-column>
      <el-table-column label="状态" width="130"><template #default="{ row }"><el-tag :type="releaseState(row).type">{{ releaseState(row).label }}</el-tag></template></el-table-column>
      <el-table-column label="最低版本" width="110"><template #default="{ row }"><span class="mono">{{ row.minVersion || '—' }}</span></template></el-table-column>
      <el-table-column label="强制" width="80"><template #default="{ row }"><el-tag v-if="row.forced" type="danger" size="small">强制</el-tag><span v-else class="muted">否</span></template></el-table-column>
      <el-table-column prop="notes" label="说明" min-width="220" show-overflow-tooltip />
      <el-table-column label="创建时间" width="160"><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></el-table-column>
      <el-table-column label="操作" width="260" fixed="right">
        <template #default="{ row }">
          <template v-if="canWrite">
            <el-button link type="primary" @click="setPercent(row)">调灰度</el-button>
            <el-button v-if="row.rolloutPercent < 100" link type="primary" @click="patch(row, { rolloutPercent: 100 }, `将 ${row.version} 全量发布？所有设备都会收到更新提示。`)">全量</el-button>
            <el-button link :type="row.forced ? 'info' : 'warning'" @click="patch(row, { forced: !row.forced }, row.forced ? null : `将 ${row.version} 标记为强制更新？客户端会要求用户更新后才能继续使用。`)">{{ row.forced ? '取消强制' : '设为强制' }}</el-button>
            <el-button link :type="row.enabled ? 'danger' : 'success'" @click="patch(row, { enabled: !row.enabled }, row.enabled ? `暂停 ${row.version} 的下发？` : null)">{{ row.enabled ? '暂停' : '恢复' }}</el-button>
          </template>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialog" title="新建发布" width="520px">
      <el-form label-width="100px">
        <el-form-item label="版本号"><el-input v-model="form.version" placeholder="如 1.2.0 或 1.3.0-beta.1" /></el-form-item>
        <el-form-item label="通道">
          <el-radio-group v-model="form.channel"><el-radio v-for="c in CHANNELS" :key="c.value" :value="c.value">{{ c.label }}</el-radio></el-radio-group>
        </el-form-item>
        <el-form-item label="灰度百分比"><el-slider v-model="form.rolloutPercent" :min="0" :max="100" show-input style="max-width: 360px" /></el-form-item>
        <el-form-item label="最低版本"><el-input v-model="form.minVersion" placeholder="可空；低于它的客户端必须更新" /></el-form-item>
        <el-form-item label="强制更新"><el-switch v-model="form.forced" /></el-form-item>
        <el-form-item label="更新说明"><el-input v-model="form.notes" type="textarea" :rows="4" maxlength="2000" show-word-limit /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="create">创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>
