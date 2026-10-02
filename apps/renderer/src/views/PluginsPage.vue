<template>
  <div class="pl-page" data-test="plugins-page">
    <header class="pl-header">
      <el-button size="small" @click="$router.back()">
        <el-icon><ArrowLeft /></el-icon> 返回
      </el-button>
      <h1>插件与服务商</h1>
      <div class="pl-spacer" />
      <a class="pl-link" :href="docsUrl" target="_blank" rel="noopener noreferrer" data-test="sdk-docs">插件 SDK 文档</a>
      <el-button size="small" type="primary" :loading="installing" data-test="install-from-folder" @click="installFromFolder">从文件夹安装</el-button>
    </header>

    <section class="pl-card pl-devmode" data-test="developer-mode">
      <div class="pl-devmode-text">
        <div class="pl-devmode-title">开发者模式</div>
        <div class="pl-note">{{ DEVELOPER_MODE_NOTE }}</div>
      </div>
      <el-switch :model-value="developerMode" :loading="togglingDev" data-test="developer-mode-switch" @change="setDeveloperMode" />
    </section>

    <el-alert v-if="loadError" type="error" :closable="false" show-icon :title="loadError" />

    <section v-loading="loading" class="pl-card pl-list">
      <div v-for="item in items" :key="item.id" class="pl-row" :data-test="'row-' + item.id">
        <div class="pl-main">
          <div class="pl-title">
            <span class="pl-name">{{ item.label }}</span>
            <span v-if="item.version" class="pl-version">v{{ item.version }}</span>
            <el-tag size="small" :type="signatureTagType(item.signature.status)" effect="plain" :data-test="'sig-' + item.id">
              {{ signatureLabel(item.signature.status) }}
            </el-tag>
          </div>
          <div class="pl-meta">
            <span v-if="capabilityLabels(item.capabilities).length">{{ capabilityLabels(item.capabilities).join(' · ') }}</span>
            <span v-if="item.hosts.length" class="pl-hosts">访问 {{ item.hosts.join('、') }}</span>
            <span v-if="item.signature.hash" class="pl-hash" :title="item.signature.hash">指纹 {{ shortHash(item.signature.hash) }}</span>
            <span v-if="item.reviewed_at" class="pl-reviewed">审核 {{ formatDate(item.reviewed_at) }}</span>
          </div>
          <div class="pl-status" :class="{ warn: item.enabled && !item.active && item.source !== 'builtin' }">{{ statusText(item, developerMode) }}</div>
        </div>
        <div class="pl-actions">
          <el-tooltip :disabled="!switchState(item, developerMode).hint" :content="switchState(item, developerMode).hint || ''" placement="top">
            <span>
              <el-switch
                :model-value="switchState(item, developerMode).checked"
                :disabled="switchState(item, developerMode).disabled || busy[item.id]"
                :loading="!!busy[item.id]"
                :data-test="'switch-' + item.id"
                @change="(v) => toggle(item, v)"
              />
            </span>
          </el-tooltip>
          <el-button size="small" text :data-test="'detail-' + item.id" @click="openDetail(item)">详情</el-button>
          <el-button v-if="item.source !== 'builtin'" size="small" text type="danger" :data-test="'remove-' + item.id" @click="remove(item)">删除</el-button>
        </div>
      </div>
      <div v-if="!loading && !items.length" class="pl-empty">还没有可用的服务商。</div>
    </section>

    <p class="pl-note pl-footer" data-test="community-note">{{ COMMUNITY_NOTE }}</p>
    <p v-if="pluginsDir" class="pl-note">插件目录：{{ pluginsDir }}</p>

    <el-drawer v-model="detailOpen" :title="detail ? detail.label : ''" size="420px" append-to-body>
      <div v-if="detail" class="pl-detail" data-test="plugin-detail">
        <p v-if="detail.description" class="pl-desc">{{ detail.description }}</p>
        <dl>
          <template v-for="row in detailRows(detail)" :key="row.key">
            <dt>{{ row.label }}</dt>
            <dd :class="{ mono: row.key === 'hash' || row.key === 'dir' }">
              <a v-if="row.link" :href="row.link" target="_blank" rel="noopener noreferrer">{{ row.value }}</a>
              <template v-else>{{ row.value }}</template>
            </dd>
          </template>
        </dl>
        <p v-if="detail.load_error" class="pl-error">加载失败：{{ detail.load_error }}</p>
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowLeft } from '@element-plus/icons-vue'
import { onboardingAPI } from '@/api/onboarding'
import { pluginsAPI } from '@/api/plugins'
import {
  COMMUNITY_NOTE, DEVELOPER_MODE_NOTE, capabilityLabels, detailRows, formatDate, mergeProviderList, normalizeInstallPath,
  sdkDocsUrl, shortHash, signatureLabel, signatureTagType, statusText, switchState,
} from '@/utils/pluginsView'

const loading = ref(false)
const loadError = ref('')
const providers = ref(null)
const plugins = ref([])
const developerMode = ref(false)
const pluginsDir = ref('')
const togglingDev = ref(false)
const installing = ref(false)
const busy = reactive({})
const detailOpen = ref(false)
const detail = ref(null)

const docsUrl = sdkDocsUrl(import.meta.env)
const items = computed(() => mergeProviderList(providers.value, plugins.value))

function applySummary(summary) {
  plugins.value = Array.isArray(summary?.items) ? summary.items : []
  developerMode.value = !!summary?.developer_mode
  pluginsDir.value = summary?.plugins_dir || ''
  if (detail.value) detail.value = items.value.find((i) => i.id === detail.value.id) || null
}

async function reload() {
  loading.value = true
  loadError.value = ''
  try {
    const [p, s] = await Promise.all([onboardingAPI.providers().catch(() => null), pluginsAPI.list()])
    providers.value = p
    applySummary(s)
  } catch (e) {
    loadError.value = `插件列表加载失败：${e.message || '本地服务未就绪'}`
  } finally {
    loading.value = false
  }
}

async function toggle(item, on) {
  if (item.source === 'builtin' || busy[item.id]) return
  busy[item.id] = true
  try {
    await (on ? pluginsAPI.enable(item.id) : pluginsAPI.disable(item.id))
    await reload()
    ElMessage.success(on ? `已启用 ${item.label}` : `已关闭 ${item.label}`)
  } catch (_) {
    await reload()
  } finally {
    busy[item.id] = false
  }
}

async function setDeveloperMode(on) {
  if (on) {
    try {
      await ElMessageBox.confirm(DEVELOPER_MODE_NOTE, '打开开发者模式', { type: 'warning', confirmButtonText: '我已了解，打开', cancelButtonText: '取消' })
    } catch (_) {
      return
    }
  }
  togglingDev.value = true
  try {
    applySummary(await pluginsAPI.setDeveloperMode(on))
    ElMessage.success(on ? '开发者模式已打开' : '开发者模式已关闭，未签名插件已停用')
  } catch (_) {
    await reload()
  } finally {
    togglingDev.value = false
  }
}

async function installFromFolder() {
  let value
  try {
    ({ value } = await ElMessageBox.prompt(
      '输入插件文件夹的完整路径（里面有 manifest.json）。文件夹会被复制到插件目录；未签名或签名无效的插件需要先打开开发者模式。',
      '从文件夹安装',
      { confirmButtonText: '安装', cancelButtonText: '取消', inputPlaceholder: '例如 D:\\plugins\\my-plugin' },
    ))
  } catch (_) {
    return
  }
  const dir = normalizeInstallPath(value)
  if (!dir) return ElMessage.warning('请输入插件文件夹路径')
  installing.value = true
  try {
    const installed = await pluginsAPI.install(dir)
    await reload()
    ElMessage.success(`已安装 ${installed.label || installed.id}（${signatureLabel(installed.signature?.status)}）`)
  } catch (e) {
    ElMessage.error(e.action ? `${e.message} ${e.action}` : e.message)
  } finally {
    installing.value = false
  }
}

async function remove(item) {
  try {
    await ElMessageBox.confirm(`删除插件 ${item.label}？插件文件夹会从插件目录移除，已保存的 API Key 不受影响。`, '删除插件', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
  } catch (_) {
    return
  }
  busy[item.id] = true
  try {
    await pluginsAPI.remove(item.id)
    if (detail.value && detail.value.id === item.id) detailOpen.value = false
    await reload()
    ElMessage.success(`已删除 ${item.label}`)
  } catch (_) {
    await reload()
  } finally {
    busy[item.id] = false
  }
}

function openDetail(item) {
  detail.value = item
  detailOpen.value = true
}

onMounted(reload)
</script>

<style scoped>
.pl-page { max-width: 820px; margin: 0 auto; padding: 16px; color: var(--text-primary); }
.pl-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.pl-header h1 { margin: 0; font-size: 18px; color: var(--text-bright); }
.pl-spacer { flex: 1; }
.pl-link { font-size: 13px; color: var(--el-color-primary); text-decoration: none; }
.pl-link:hover { text-decoration: underline; }
.pl-card { padding: 12px 16px; border-radius: 12px; border: 1px solid var(--el-border-color); background: var(--el-bg-color); margin-bottom: 12px; }
.pl-devmode { display: flex; align-items: center; gap: 16px; }
.pl-devmode-text { flex: 1; }
.pl-devmode-title { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
.pl-note { font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.6; margin: 0; }
.pl-footer { margin: 4px 2px 8px; }
.pl-list { padding: 0 16px; min-height: 80px; }
.pl-row { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--el-border-color-lighter); }
.pl-row:last-child { border-bottom: none; }
.pl-main { flex: 1; min-width: 0; }
.pl-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pl-name { font-size: 14px; font-weight: 600; }
.pl-version { font-size: 12px; color: var(--el-text-color-secondary); }
.pl-meta { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 4px; font-size: 12px; color: var(--el-text-color-secondary); }
.pl-hash { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.pl-status { margin-top: 4px; font-size: 12px; color: var(--el-text-color-placeholder); }
.pl-status.warn { color: var(--el-color-warning); }
.pl-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.pl-empty { padding: 24px 0; text-align: center; color: var(--el-text-color-secondary); font-size: 13px; }
.pl-detail dl { display: grid; grid-template-columns: 96px 1fr; gap: 8px 12px; margin: 0; font-size: 13px; }
.pl-detail dt { color: var(--el-text-color-secondary); }
.pl-detail dd { margin: 0; word-break: break-all; }
.pl-detail dd.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.pl-desc { margin: 0 0 12px; font-size: 13px; }
.pl-error { margin-top: 12px; font-size: 12px; color: var(--el-color-danger); }
</style>
