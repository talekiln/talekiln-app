<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, errorText } from '../api.js'
import { formatTime } from '../format.js'
import { can } from '../permissions.js'
import { me } from '../session.js'
import {
  STATUS_OPTIONS, actionGate, fileHashRows, keySummary, manifestFileName, parseInspectText, prettyJson,
  reviewActionLabel, signState, signedManifestText, statusTag, submitBody, validateSubmission, versionRow,
} from '../plugins.js'

const rows = ref([])
const loading = ref(false)
const status = ref('')
const keyInfo = ref(null)
const detail = ref(null)
const drawer = ref(false)
const busy = ref(false)
const submitDialog = ref(false)
const form = reactive({ text: '', packageUrl: '', sha256: '', notes: '', parsed: null, error: '' })

const canWrite = computed(() => can(me.value, 'ops:write'))
const canReview = computed(() => can(me.value, 'plugins:review'))
const canSign = computed(() => can(me.value, 'plugins:sign'))
const activeKid = computed(() => (keyInfo.value ? keyInfo.value.kid : null))
const banner = computed(() => keySummary(keyInfo.value))
const gate = computed(() => actionGate(detail.value, { canReview: canReview.value, canSign: canSign.value, activeKid: activeKid.value }))
const detailSign = computed(() => signState(detail.value, activeKid.value))
const hashRows = computed(() => fileHashRows(detail.value && detail.value.fileHashes))

async function load() {
  loading.value = true
  try {
    rows.value = (await api.listPlugins({ status: status.value || undefined, limit: 200 })).map((v) => versionRow(v, activeKid.value))
  } catch (e) {
    ElMessage.error(errorText(e))
  } finally {
    loading.value = false
  }
}

/** 只有能签名的管理员才看得到密钥信息（接口要求 plugins:sign）；其他角色不请求。 */
async function loadKey() {
  if (!canSign.value) return
  try {
    keyInfo.value = await api.pluginSigningKey()
  } catch (e) {
    if (e.status !== 403) ElMessage.error(errorText(e))
  }
}

async function open(row) {
  try {
    detail.value = await api.getPlugin(row.id)
    drawer.value = true
  } catch (e) {
    ElMessage.error(errorText(e))
  }
}

async function refreshDetail() {
  if (detail.value) detail.value = await api.getPlugin(detail.value.id)
  await load()
}

/** 弹出备注框 -> 调接口 -> 刷新。取消不做任何事。 */
async function withNotes(title, tip, fn, successText) {
  let notes = ''
  try {
    const r = await ElMessageBox.prompt(tip, title, { inputType: 'textarea', inputPlaceholder: '备注（可选，会写进审核记录与审计日志）', confirmButtonText: '确定', cancelButtonText: '取消' })
    notes = (r.value || '').trim()
  } catch {
    return
  }
  busy.value = true
  try {
    await fn(notes)
    ElMessage.success(successText)
    await refreshDetail()
  } catch (e) {
    ElMessage.error(errorText(e))
  } finally {
    busy.value = false
  }
}

const approve = () => withNotes('通过审核',
  `请确认已按 packageUrl 下载包、核对 sha256，解包后用 sign-plugin.mjs --inspect 比对指纹与登记的 ${detail.value.hash.slice(0, 16)}… 一致，并看过代码。`,
  (n) => api.approvePlugin(detail.value.id, n), '已通过审核')
const reject = () => withNotes('驳回版本', '驳回理由。已签名的版本只会撤出公开目录，签名本身不可撤回（见 docs/phase3-plugins.md）。',
  (n) => api.rejectPlugin(detail.value.id, n), '已驳回')
const sign = () => withNotes('官方签名',
  `将在云端服务器上用插件签名密钥（kid ${activeKid.value || '?'}）签名。签出去的包在所有客户端都算官方且不可撤回，请确认审核已完成。`,
  (n) => api.signPlugin(detail.value.id, n), '已签名；把「已签名清单」交给作者写回包里')

async function copySigned() {
  try {
    await navigator.clipboard.writeText(signedManifestText(detail.value))
    ElMessage.success('已复制；作者原样覆盖包里的 manifest.json 后重新打包')
  } catch {
    ElMessage.error('复制失败，请手动选择下方文本')
  }
}

function downloadSigned() {
  const blob = new Blob([signedManifestText(detail.value)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = manifestFileName(detail.value)
  a.click()
  URL.revokeObjectURL(a.href)
}

function openSubmit() {
  Object.assign(form, { text: '', packageUrl: '', sha256: '', notes: '', parsed: null, error: '' })
  submitDialog.value = true
}

function onInspectInput() {
  const r = parseInspectText(form.text)
  form.parsed = r.error ? null : r
  form.error = r.error || ''
}

async function submit() {
  onInspectInput()
  const err = validateSubmission(form)
  if (err) return ElMessage.warning(err)
  busy.value = true
  try {
    await api.submitPlugin(submitBody(form))
    submitDialog.value = false
    ElMessage.success('已登记，进入待审核')
    await load()
  } catch (e) {
    ElMessage.error(errorText(e))
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  await loadKey()
  await load()
})
</script>

<template>
  <div class="page">
    <h2 class="page-title">插件审核</h2>
    <el-alert v-if="canSign" :title="banner.text" :type="banner.type" :closable="false" show-icon style="margin-bottom: 12px" />
    <div class="toolbar">
      <el-select v-model="status" style="width: 140px" @change="load">
        <el-option v-for="o in STATUS_OPTIONS" :key="o.value" :value="o.value" :label="o.label" />
      </el-select>
      <el-button type="primary" :disabled="!canWrite" @click="openSubmit">登记新版本</el-button>
      <el-button @click="load">刷新</el-button>
      <span class="muted">流程：登记（运营）→ 审核通过/驳回（运营及以上）→ 官方签名（仅管理员，私钥只在云端服务器）→ 作者把已签名清单写回包里。云端不下载、不执行插件包，核对包是人工动作。</span>
    </div>

    <el-table v-loading="loading" :data="rows" border stripe row-key="id" empty-text="暂无登记的插件版本">
      <el-table-column label="插件" min-width="160">
        <template #default="{ row }"><b>{{ row.label }}</b> <span class="muted">{{ row.name }}</span></template>
      </el-table-column>
      <el-table-column prop="version" label="版本" width="90" />
      <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag size="small" :type="row.status.type">{{ row.status.label }}</el-tag></template></el-table-column>
      <el-table-column label="签名" width="150"><template #default="{ row }"><el-tag size="small" :type="row.sign.type">{{ row.sign.label }}</el-tag></template></el-table-column>
      <el-table-column label="指纹" width="170"><template #default="{ row }"><span class="mono">{{ row.hashShort }}</span></template></el-table-column>
      <el-table-column label="能力" min-width="160" show-overflow-tooltip><template #default="{ row }">{{ row.caps }}</template></el-table-column>
      <el-table-column label="文件" width="70"><template #default="{ row }">{{ row.fileCount }}</template></el-table-column>
      <el-table-column label="登记时间" width="160"><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></el-table-column>
      <el-table-column label="审核时间" width="160"><template #default="{ row }">{{ formatTime(row.reviewedAt) }}</template></el-table-column>
      <el-table-column label="操作" width="90" fixed="right">
        <template #default="{ row }"><el-button link type="primary" @click="open(row)">详情</el-button></template>
      </el-table-column>
    </el-table>

    <el-drawer v-model="drawer" :title="detail ? `${detail.label} v${detail.version}` : '插件版本'" size="680px">
      <template v-if="detail">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="插件名">{{ detail.name }}（服务商 id）</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag size="small" :type="statusTag(detail.reviewStatus).type">{{ statusTag(detail.reviewStatus).label }}</el-tag>
            <span class="muted" style="margin-left: 8px">{{ detail.reviewedAt ? `审核于 ${formatTime(detail.reviewedAt)}` : '未审核' }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="签名">
            <el-tag size="small" :type="detailSign.type">{{ detailSign.label }}</el-tag>
            <span v-if="detail.signedAt" class="muted" style="margin-left: 8px">签于 {{ formatTime(detail.signedAt) }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="包指纹 hash"><span class="mono">{{ detail.hash }}</span></el-descriptions-item>
          <el-descriptions-item label="包地址"><a :href="detail.packageUrl" target="_blank" rel="noopener noreferrer">{{ detail.packageUrl }}</a></el-descriptions-item>
          <el-descriptions-item label="包 sha256"><span class="mono">{{ detail.sha256 }}</span></el-descriptions-item>
          <el-descriptions-item label="SDK 版本">{{ detail.manifest.sdkVersion }}</el-descriptions-item>
          <el-descriptions-item label="权限">{{ (detail.manifest.permissions || []).join('，') }}</el-descriptions-item>
        </el-descriptions>

        <div class="actions">
          <el-tooltip :content="gate.approve.reason" :disabled="gate.approve.ok"><span><el-button type="success" :disabled="!gate.approve.ok" :loading="busy" @click="approve">通过</el-button></span></el-tooltip>
          <el-tooltip :content="gate.reject.reason" :disabled="gate.reject.ok"><span><el-button type="danger" plain :disabled="!gate.reject.ok" :loading="busy" @click="reject">驳回</el-button></span></el-tooltip>
          <el-tooltip :content="gate.sign.reason" :disabled="gate.sign.ok"><span><el-button type="primary" :disabled="!gate.sign.ok" :loading="busy" @click="sign">官方签名{{ activeKid ? `（${activeKid}）` : '' }}</el-button></span></el-tooltip>
        </div>

        <template v-if="detail.signedManifest">
          <h4>已签名清单（作者原样覆盖包里的 manifest.json）</h4>
          <div class="toolbar">
            <el-button size="small" @click="copySigned">复制已签名清单</el-button>
            <el-button size="small" @click="downloadSigned">下载 manifest.json</el-button>
          </div>
          <pre class="code">{{ signedManifestText(detail) }}</pre>
        </template>

        <h4>manifest（登记时提交，不含签名）</h4>
        <pre class="code">{{ prettyJson(detail.manifest) }}</pre>

        <h4>文件哈希（{{ hashRows.length }} 个文件）</h4>
        <el-table :data="hashRows" size="small" border>
          <el-table-column prop="path" label="路径" min-width="160" />
          <el-table-column label="sha256" min-width="300"><template #default="{ row }"><span class="mono">{{ row.sha256 }}</span></template></el-table-column>
        </el-table>

        <h4>审核记录</h4>
        <el-table :data="detail.reviews || []" size="small" border empty-text="暂无记录">
          <el-table-column label="时间" width="150"><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></el-table-column>
          <el-table-column label="动作" width="70"><template #default="{ row }">{{ reviewActionLabel(row.action) }}</template></el-table-column>
          <el-table-column prop="actorEmail" label="操作人" min-width="160" />
          <el-table-column prop="notes" label="备注" min-width="200" show-overflow-tooltip />
        </el-table>
      </template>
    </el-drawer>

    <el-dialog v-model="submitDialog" title="登记新插件版本" width="760px">
      <el-form label-width="110px">
        <el-form-item label="--inspect 输出">
          <el-input v-model="form.text" type="textarea" :rows="12" placeholder="粘贴 node packages/plugin-sdk/scripts/sign-plugin.mjs <插件目录> --inspect 的完整 JSON 输出（含 manifest 与 fileHashes）" @input="onInspectInput" />
        </el-form-item>
        <el-form-item label="包下载地址"><el-input v-model="form.packageUrl" placeholder="https://… 作者提供的压缩包地址" /></el-form-item>
        <el-form-item label="包文件 sha256"><el-input v-model="form.sha256" placeholder="压缩包文件的 sha256（64 位十六进制）" maxlength="64" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="form.notes" type="textarea" :rows="2" maxlength="2000" show-word-limit placeholder="可选：来源、联系人等" /></el-form-item>
        <div v-if="form.error" class="err">{{ form.error }}</div>
        <div v-else-if="form.parsed" class="muted">
          {{ form.parsed.manifest.name }}@{{ form.parsed.manifest.version }} · {{ form.parsed.manifest.files.length }} 个文件 · 能力 {{ (form.parsed.manifest.capabilities || []).join(', ') }}
          <template v-if="form.parsed.hash"> · 指纹 <span class="mono">{{ form.parsed.hash.slice(0, 16) }}…</span></template>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="submitDialog = false">取消</el-button>
        <el-button type="primary" :loading="busy" :disabled="!form.parsed" @click="submit">登记（进入待审核）</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.err { color: var(--el-color-danger); font-size: 12px; }
.actions { display: flex; gap: 8px; margin: 14px 0; }
h4 { margin: 16px 0 8px; font-size: 14px; }
.code { background: #f5f7fa; border: 1px solid #ebeef5; border-radius: 6px; padding: 10px; font-size: 12px; max-height: 320px; overflow: auto; white-space: pre-wrap; word-break: break-all; font-family: ui-monospace, Menlo, Consolas, monospace; }
</style>
