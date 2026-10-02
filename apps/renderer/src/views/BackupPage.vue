<template>
  <div class="bk-page" data-test="backup-page">
    <header class="bk-header">
      <el-button size="small" @click="$router.back()">
        <el-icon><ArrowLeft /></el-icon> 返回
      </el-button>
      <h1>云备份</h1>
      <div class="bk-spacer" />
      <el-button size="small" :loading="loading" data-test="refresh" @click="reloadAll">刷新</el-button>
    </header>

    <el-alert v-if="loadError" type="error" :closable="false" show-icon :title="loadError" />

    <!-- 状态 -->
    <section class="bk-card" data-test="status-card">
      <el-alert :type="summary.tone" :closable="false" show-icon :title="summary.text" />
    </section>

    <!-- 设置 -->
    <section class="bk-card" data-test="settings-card">
      <h2 class="bk-card-title">对象存储设置</h2>
      <p class="bk-note">{{ PROVIDER_NOTE }}</p>
      <el-form label-position="top" class="bk-form" @submit.prevent>
        <div class="bk-grid">
          <el-form-item label="地址（Endpoint）" :error="errors.endpoint">
            <el-input v-model="form.endpoint" placeholder="https://s3.example.com 或 http://192.168.1.10:9000" data-test="endpoint" />
            <div v-if="endpointCheck.ok && endpointCheck.insecure" class="bk-hint warn">{{ endpointCheck.message }}</div>
          </el-form-item>
          <el-form-item label="区域（Region）" :error="errors.region">
            <el-input v-model="form.region" placeholder="us-east-1（MinIO 默认）" data-test="region" />
          </el-form-item>
          <el-form-item label="存储桶（Bucket）" :error="errors.bucket">
            <el-input v-model="form.bucket" placeholder="talekiln-backup" data-test="bucket" />
          </el-form-item>
          <el-form-item label="前缀（Prefix）" :error="errors.prefix">
            <el-input v-model="form.prefix" placeholder="talekiln" data-test="prefix" />
          </el-form-item>
          <el-form-item label="Access Key" :error="errors.access_key">
            <el-input v-model="form.access_key" autocomplete="off" data-test="access-key" />
          </el-form-item>
          <el-form-item label="Secret Key" :error="errors.secret_key">
            <el-input v-model="form.secret_key" type="password" show-password autocomplete="new-password" :placeholder="hasSecret ? '已保存（留空保持不变）' : '只写：保存后不会再显示'" data-test="secret-key" />
            <div v-if="hasSecret" class="bk-hint" data-test="secret-saved">已保存。要更换就填新的，<el-button text size="small" type="danger" data-test="clear-secret" @click="clearSecret">或清除</el-button></div>
          </el-form-item>
          <el-form-item label="自动备份" :error="errors.auto">
            <el-select v-model="form.auto" data-test="auto">
              <el-option v-for="o in AUTO_OPTIONS" :key="o.value" :value="o.value" :label="o.label" />
            </el-select>
            <div class="bk-hint">{{ autoHint }}</div>
          </el-form-item>
          <el-form-item label="每个项目保留最近几份" :error="errors.keep">
            <el-input-number v-model="form.keep" :min="0" :max="365" data-test="keep" />
            <div class="bk-hint">0 表示不自动清理</div>
          </el-form-item>
        </div>
        <el-checkbox v-model="form.path_style" data-test="path-style">路径式寻址（MinIO 默认；阿里云 OSS / 腾讯云 COS 的虚拟主机式请取消勾选）</el-checkbox>
        <div class="bk-actions">
          <el-button :loading="testing" data-test="test" @click="testConnection">测试连接</el-button>
          <el-button type="primary" :loading="saving" data-test="save" @click="save">保存设置</el-button>
          <span v-if="testResult" class="bk-test-result" :class="testResult.ok ? 'ok' : 'bad'" data-test="test-result">{{ testResult.text }}</span>
        </div>
      </el-form>
    </section>

    <!-- 项目：立即备份 -->
    <section class="bk-card" data-test="projects-card">
      <h2 class="bk-card-title">项目</h2>
      <div v-if="!dramas.length" class="bk-empty">还没有项目。</div>
      <div v-for="d in dramas" :key="d.id" class="bk-row" :data-test="'drama-' + d.id">
        <div class="bk-main">
          <div class="bk-title">{{ d.title }}</div>
          <div class="bk-meta">{{ lastBackupText(d.id) }}</div>
        </div>
        <el-button size="small" type="primary" plain :disabled="!configured || !!busy[d.id] || status.running" :loading="!!busy[d.id]" :data-test="'backup-' + d.id" @click="backupNow(d)">立即备份</el-button>
      </div>
    </section>

    <!-- 快照 -->
    <section class="bk-card" data-test="snapshots-card">
      <div class="bk-card-head">
        <h2 class="bk-card-title">云端快照</h2>
        <el-tag v-if="snapshotsSource === 'local'" size="small" type="warning" data-test="offline-tag">离线：显示本机记录</el-tag>
      </div>
      <p class="bk-note">{{ RESTORE_NOTE }}</p>
      <div v-if="!groups.length" class="bk-empty">{{ configured ? '还没有快照。' : '配置并保存设置后，这里会列出云端的快照。' }}</div>
      <div v-for="g in groups" :key="g.drama_id" class="bk-group" :data-test="'group-' + g.drama_id">
        <div class="bk-group-title">
          {{ g.title }}
          <el-tag v-if="!g.exists" size="small" type="info">项目已不在本机</el-tag>
        </div>
        <div v-for="s in g.snapshots" :key="s.key" class="bk-row bk-snapshot" :data-test="'snapshot-' + s.key">
          <div class="bk-main">
            <div class="bk-title mono">{{ s.created }} · {{ s.size_label }}</div>
            <div class="bk-meta">
              <span v-if="s.hash" class="mono" :title="s.sha256">sha256 {{ s.hash }}</span>
              <span v-else class="warn">无校验信息，无法恢复</span>
              <span class="mono bk-key" :title="s.key">{{ s.key }}</span>
            </div>
          </div>
          <el-button size="small" :disabled="!s.verifiable || snapshotsSource === 'local' || status.running" :loading="busyKey === s.key && busyAction === 'restore'" :data-test="'restore-' + s.key" @click="restore(s, g)">恢复为新项目</el-button>
          <el-button size="small" text type="danger" :disabled="snapshotsSource === 'local'" :loading="busyKey === s.key && busyAction === 'delete'" :data-test="'delete-' + s.key" @click="remove(s, g)">删除</el-button>
        </div>
      </div>
    </section>

    <!-- 运行历史 -->
    <section class="bk-card" data-test="runs-card">
      <h2 class="bk-card-title">运行历史</h2>
      <div v-if="!runs.length" class="bk-empty">还没有记录。</div>
      <table v-else class="bk-table">
        <thead><tr><th>时间</th><th>类型</th><th>触发</th><th>项目</th><th>大小</th><th>结果</th></tr></thead>
        <tbody>
          <tr v-for="r in runs" :key="r.id" :data-test="'run-' + r.id">
            <td class="mono">{{ r.started }}</td>
            <td>{{ r.kind }}</td>
            <td>{{ r.trigger }}</td>
            <td>{{ r.title }}</td>
            <td>{{ r.size }}</td>
            <td>
              <el-tag size="small" :type="r.tag" effect="plain">{{ r.status_label }}</el-tag>
              <span v-if="r.error" class="bk-error" :title="r.error">{{ r.error }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowLeft } from '@element-plus/icons-vue'
import { backupAPI } from '@/api/backup'
import { dramaAPI } from '@/api/drama'
import {
  AUTO_OPTIONS, PROVIDER_NOTE, RESTORE_NOTE, checkEndpoint, formFromSettings, formatDate, groupSnapshots, runRow, settingsPayload,
  statusSummary, validateForm,
} from '@/utils/backupView'

const loading = ref(false)
const loadError = ref('')
const saving = ref(false)
const testing = ref(false)
const testResult = ref(null)
const settings = ref({})
const form = reactive(formFromSettings({}))
const errors = reactive({})
const status = ref({})
const dramas = ref([])
const snapshots = ref([])
const snapshotsSource = ref('s3')
const runsRaw = ref([])
const busy = reactive({})
const busyKey = ref('')
const busyAction = ref('')

const hasSecret = computed(() => !!settings.value.has_secret)
const configured = computed(() => !!settings.value.configured)
const endpointCheck = computed(() => checkEndpoint(form.endpoint))
const autoHint = computed(() => (AUTO_OPTIONS.find((o) => o.value === form.auto) || {}).hint || '')
const summary = computed(() => statusSummary(status.value))
const groups = computed(() => groupSnapshots(snapshots.value, dramas.value))
const runs = computed(() => runsRaw.value.map(runRow))

function setErrors(next) {
  for (const k of Object.keys(errors)) delete errors[k]
  Object.assign(errors, next)
}

function applySettings(s) {
  settings.value = s || {}
  Object.assign(form, formFromSettings(s))
}

function lastBackupText(dramaId) {
  const r = runsRaw.value.find((x) => x.drama_id === dramaId && x.kind === 'backup' && x.status === 'done')
  return r ? `上次备份 ${formatDate(r.finished_at)}` : '还没有备份过'
}

async function loadStatusAndRuns() {
  const [st, rs] = await Promise.all([backupAPI.status(), backupAPI.runs({ limit: 100 })])
  status.value = st || {}
  runsRaw.value = Array.isArray(rs?.items) ? rs.items : []
}

async function loadSnapshots() {
  if (!configured.value) { snapshots.value = []; snapshotsSource.value = 's3'; return }
  const r = await backupAPI.snapshots()
  snapshots.value = Array.isArray(r?.items) ? r.items : []
  snapshotsSource.value = r?.source || 's3'
}

async function reloadAll() {
  loading.value = true
  loadError.value = ''
  try {
    const [s, list] = await Promise.all([backupAPI.getSettings(), dramaAPI.list({ page: 1, page_size: 200 }).catch(() => null)])
    applySettings(s)
    const items = list?.items || list?.data?.items || (Array.isArray(list) ? list : [])
    dramas.value = items.map((d) => ({ id: d.id, title: d.title }))
    await Promise.all([loadStatusAndRuns(), loadSnapshots()])
  } catch (e) {
    loadError.value = `云备份信息加载失败：${e.message || '本地服务未就绪'}`
  } finally {
    loading.value = false
  }
}

async function save() {
  const errs = validateForm(form, { hasSecret: hasSecret.value })
  setErrors(errs)
  if (Object.keys(errs).length) return ElMessage.warning('请先改正表单里标红的项')
  saving.value = true
  try {
    applySettings(await backupAPI.putSettings(settingsPayload(form)))
    ElMessage.success('云备份设置已保存')
    await Promise.all([loadStatusAndRuns(), loadSnapshots()])
  } catch (e) {
    ElMessage.error(e.action ? `${e.message} ${e.action}` : e.message)
  } finally {
    saving.value = false
  }
}

async function testConnection() {
  const errs = validateForm(form, { hasSecret: hasSecret.value })
  delete errs.auto; delete errs.keep
  setErrors(errs)
  if (Object.keys(errs).length) return ElMessage.warning('请先填好地址、存储桶与密钥')
  testing.value = true
  testResult.value = null
  try {
    const r = await backupAPI.test(settingsPayload(form))
    testResult.value = { ok: true, text: `连接成功：${r.bucket}（${r.latency_ms} ms）` }
  } catch (e) {
    testResult.value = { ok: false, text: e.action ? `${e.message} ${e.action}` : e.message }
  } finally {
    testing.value = false
  }
}

async function clearSecret() {
  try {
    await ElMessageBox.confirm('清除已保存的 Secret Key？清除后在重新填写之前无法备份。', '清除 Secret Key', { type: 'warning', confirmButtonText: '清除', cancelButtonText: '取消' })
  } catch (_) { return }
  try {
    applySettings(await backupAPI.putSettings({ secret_key: null }))
    ElMessage.success('已清除 Secret Key')
    await loadStatusAndRuns()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

async function backupNow(d) {
  if (busy[d.id]) return
  busy[d.id] = true
  try {
    const r = await backupAPI.backupDrama(d.id)
    ElMessage.success(`已备份「${d.title}」（${runRow(r.run).size}）`)
    await Promise.all([loadStatusAndRuns(), loadSnapshots()])
  } catch (e) {
    ElMessage.error(e.action ? `${e.message} ${e.action}` : e.message)
    await loadStatusAndRuns().catch(() => {})
  } finally {
    busy[d.id] = false
  }
}

async function restore(s, g) {
  try {
    await ElMessageBox.confirm(`把「${g.title}」${s.created} 的快照恢复为一个新项目？${RESTORE_NOTE}`, '恢复快照', { type: 'info', confirmButtonText: '恢复为新项目', cancelButtonText: '取消' })
  } catch (_) { return }
  busyKey.value = s.key
  busyAction.value = 'restore'
  try {
    const r = await backupAPI.restore(s.key)
    ElMessage.success(`已恢复为新项目「${r.title}」`)
    await reloadAll()
  } catch (e) {
    ElMessage.error(e.action ? `${e.message} ${e.action}` : e.message)
  } finally {
    busyKey.value = ''
    busyAction.value = ''
  }
}

async function remove(s, g) {
  try {
    await ElMessageBox.confirm(`删除「${g.title}」${s.created} 的云端快照？此操作不可恢复，不影响本机项目。`, '删除快照', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
  } catch (_) { return }
  busyKey.value = s.key
  busyAction.value = 'delete'
  try {
    await backupAPI.deleteSnapshot(s.key)
    ElMessage.success('已删除快照')
    await loadSnapshots()
  } catch (_) {
    await loadSnapshots().catch(() => {})
  } finally {
    busyKey.value = ''
    busyAction.value = ''
  }
}

onMounted(reloadAll)
</script>

<style scoped>
.bk-page { max-width: 880px; margin: 0 auto; padding: 16px; color: var(--text-primary); }
.bk-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.bk-header h1 { margin: 0; font-size: 18px; color: var(--text-bright); }
.bk-spacer { flex: 1; }
.bk-card { padding: 12px 16px; border-radius: 12px; border: 1px solid var(--el-border-color); background: var(--el-bg-color); margin-bottom: 12px; }
.bk-card-head { display: flex; align-items: center; gap: 10px; }
.bk-card-title { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
.bk-note { font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.6; margin: 0 0 10px; }
.bk-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; }
.bk-hint { font-size: 12px; color: var(--el-text-color-secondary); margin-top: 4px; line-height: 1.5; }
.bk-hint.warn, .warn { color: var(--el-color-warning); }
.bk-actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.bk-test-result { font-size: 12px; }
.bk-test-result.ok { color: var(--el-color-success); }
.bk-test-result.bad { color: var(--el-color-danger); }
.bk-row { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--el-border-color-lighter); }
.bk-row:last-child { border-bottom: none; }
.bk-main { flex: 1; min-width: 0; }
.bk-title { font-size: 14px; font-weight: 600; }
.bk-meta { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 4px; font-size: 12px; color: var(--el-text-color-secondary); }
.bk-key { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.bk-group { margin-top: 6px; }
.bk-group-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; margin: 8px 0 2px; }
.bk-snapshot .bk-title { font-weight: 500; font-size: 13px; }
.bk-empty { padding: 16px 0; text-align: center; color: var(--el-text-color-secondary); font-size: 13px; }
.bk-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.bk-table th, .bk-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--el-border-color-lighter); vertical-align: top; }
.bk-table th { color: var(--el-text-color-secondary); font-weight: 500; }
.bk-error { margin-left: 6px; color: var(--el-color-danger); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
@media (max-width: 720px) { .bk-grid { grid-template-columns: 1fr; } }
</style>
