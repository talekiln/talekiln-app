<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, errorText } from '../api.js'
import { formatTime } from '../format.js'
import { can } from '../permissions.js'
import { me } from '../session.js'
import { TIER_OPTIONS, manifestSummary, parseManifestText, templateBody, templateRow, tierLabel, validateTemplate, versionBody, versionState } from '../templates.js'

const rows = ref([])
const loading = ref(false)
const saving = ref(false)
const canWrite = computed(() => can(me.value, 'ops:write'))
const createDialog = ref(false)
const form = reactive({ id: '', name: '', genre: '', tier: 'free', description: '' })
const versionDialog = ref(false)
const versionTarget = ref(null)
const versionForm = reactive({ text: '', packageUrl: '', manifest: null, error: '' })
const expanded = ref([])

async function load() {
  loading.value = true
  try {
    rows.value = (await api.listTemplates()).map(templateRow)
  } catch (e) {
    ElMessage.error(errorText(e))
  } finally {
    loading.value = false
  }
}

function openCreate() {
  Object.assign(form, { id: '', name: '', genre: '', tier: 'free', description: '' })
  createDialog.value = true
}

async function create() {
  const err = validateTemplate(form)
  if (err) return ElMessage.warning(err)
  saving.value = true
  try {
    await api.createTemplate(templateBody(form))
    createDialog.value = false
    ElMessage.success('模板已创建，接着新增一个版本（粘贴 manifest.json）')
    await load()
  } catch (e) {
    ElMessage.error(errorText(e))
  } finally {
    saving.value = false
  }
}

function openVersion(row) {
  versionTarget.value = row
  Object.assign(versionForm, { text: '', packageUrl: '', manifest: null, error: '' })
  versionDialog.value = true
}

function onManifestInput() {
  const r = parseManifestText(versionForm.text, versionTarget.value && versionTarget.value.id)
  versionForm.manifest = r.manifest || null
  versionForm.error = r.error || ''
}

async function addVersion() {
  onManifestInput()
  if (!versionForm.manifest) return ElMessage.warning(versionForm.error || '请先粘贴清单')
  saving.value = true
  try {
    await api.addTemplateVersion(versionTarget.value.id, versionBody(versionForm))
    versionDialog.value = false
    ElMessage.success('版本已签名入库（未发布）；发布后客户端才能看到')
    await load()
  } catch (e) {
    ElMessage.error(errorText(e))
  } finally {
    saving.value = false
  }
}

async function setPublished(row, v, published) {
  try {
    await api.publishTemplateVersion(row.id, v.id, published)
    ElMessage.success(published ? `v${v.version} 已发布到目录` : `v${v.version} 已下架`)
    await load()
  } catch (e) {
    ElMessage.error(errorText(e))
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`删除模板「${row.name}」及其全部版本？已安装到客户端的副本不受影响。`, '删除模板', { type: 'warning' })
    await api.deleteTemplate(row.id)
    await load()
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(errorText(e))
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <h2 class="page-title">模板市场</h2>
    <div class="toolbar">
      <el-button type="primary" :disabled="!canWrite" @click="openCreate">新建模板</el-button>
      <el-button @click="load">刷新</el-button>
      <span class="muted">每个模板可有多个版本；新增版本时云端校验清单并签名，发布后的最新版本进入公开目录（GET /templates/catalog）。</span>
    </div>
    <el-table v-loading="loading" :data="rows" border stripe row-key="id" empty-text="暂无模板" :expand-row-keys="expanded">
      <el-table-column type="expand">
        <template #default="{ row }">
          <el-table :data="row.versions" size="small" empty-text="还没有版本">
            <el-table-column prop="version" label="版本" width="90" />
            <el-table-column label="状态" width="90"><template #default="{ row: v }"><el-tag size="small" :type="versionState(v).type">{{ versionState(v).label }}</el-tag></template></el-table-column>
            <el-table-column label="清单" min-width="200"><template #default="{ row: v }">{{ manifestSummary(v.manifest) }}</template></el-table-column>
            <el-table-column label="摘要" min-width="160"><template #default="{ row: v }"><code>{{ v.sha256.slice(0, 16) }}…</code>（kid {{ v.kid }}）</template></el-table-column>
            <el-table-column label="包地址" min-width="160" show-overflow-tooltip><template #default="{ row: v }">{{ v.packageUrl || '—' }}</template></el-table-column>
            <el-table-column label="发布时间" width="160"><template #default="{ row: v }">{{ v.publishedAt ? formatTime(v.publishedAt) : '—' }}</template></el-table-column>
            <el-table-column label="操作" width="110">
              <template #default="{ row: v }">
                <template v-if="canWrite">
                  <el-button v-if="!v.published" link type="primary" @click="setPublished(row, v, true)">发布</el-button>
                  <el-button v-else link @click="setPublished(row, v, false)">下架</el-button>
                </template>
              </template>
            </el-table-column>
          </el-table>
        </template>
      </el-table-column>
      <el-table-column prop="id" label="模板 id" min-width="180" />
      <el-table-column prop="name" label="名称" min-width="160" />
      <el-table-column prop="genre" label="类型" width="110" />
      <el-table-column label="档位" width="80"><template #default="{ row }">{{ tierLabel(row.tier) }}</template></el-table-column>
      <el-table-column label="目录状态" width="140"><template #default="{ row }"><el-tag :type="row.state.type">{{ row.state.label }}</el-tag></template></el-table-column>
      <el-table-column label="版本数" width="80"><template #default="{ row }">{{ row.versionCount }}</template></el-table-column>
      <el-table-column label="更新时间" width="160"><template #default="{ row }">{{ formatTime(row.updatedAt) }}</template></el-table-column>
      <el-table-column label="操作" width="170" fixed="right">
        <template #default="{ row }">
          <template v-if="canWrite">
            <el-button link type="primary" @click="openVersion(row)">新增版本</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="createDialog" title="新建模板" width="520px">
      <el-form label-width="90px">
        <el-form-item label="模板 id"><el-input v-model="form.id" placeholder="如 official-guofeng-drama，须与清单里的 id 一致" maxlength="64" /></el-form-item>
        <el-form-item label="名称"><el-input v-model="form.name" maxlength="100" show-word-limit /></el-form-item>
        <el-form-item label="类型"><el-input v-model="form.genre" placeholder="guofeng / ecommerce / knowledge …" maxlength="40" /></el-form-item>
        <el-form-item label="档位">
          <el-radio-group v-model="form.tier"><el-radio v-for="t in TIER_OPTIONS" :key="t.value" :value="t.value">{{ t.label }}</el-radio></el-radio-group>
        </el-form-item>
        <el-form-item label="简介"><el-input v-model="form.description" type="textarea" :rows="3" maxlength="2000" show-word-limit /></el-form-item>
        <div class="muted">名称、类型、档位、简介会在新增版本时被清单里的值覆盖。</div>
      </el-form>
      <template #footer>
        <el-button @click="createDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="create">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="versionDialog" :title="versionTarget ? `新增版本：${versionTarget.name}` : '新增版本'" width="720px">
      <el-form label-width="90px">
        <el-form-item label="清单 JSON">
          <el-input v-model="versionForm.text" type="textarea" :rows="14" placeholder="粘贴 manifest.json 的内容（不含 signature）" @input="onManifestInput" />
        </el-form-item>
        <el-form-item label="包地址"><el-input v-model="versionForm.packageUrl" placeholder="可选：.lytpl 压缩包的下载地址（https）" /></el-form-item>
        <div v-if="versionForm.error" class="err">{{ versionForm.error }}</div>
        <div v-else-if="versionForm.manifest" class="muted">v{{ versionForm.manifest.version }} · {{ manifestSummary(versionForm.manifest) }} · {{ tierLabel(versionForm.manifest.tier) }}</div>
      </el-form>
      <template #footer>
        <el-button @click="versionDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="!versionForm.manifest" @click="addVersion">校验并签名入库</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.err { color: var(--el-color-danger); font-size: 12px; }
</style>
