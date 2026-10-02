<template>
  <div class="about-page" data-test="about">
    <header class="about-header">
      <el-button size="small" @click="$router.back()">
        <el-icon><ArrowLeft /></el-icon> 返回
      </el-button>
      <h1>关于故事窑</h1>
    </header>

    <section v-if="isDesktop" class="about-card update-card" data-test="update-card">
      <h2>版本与更新</h2>
      <p class="version-line">当前版本 <strong data-test="current-version">{{ status.currentVersion || '未知' }}</strong>
        <span class="channel">（{{ status.channel === 'beta' ? '测试' : '稳定' }}通道）</span></p>
      <div class="update-row" :class="'is-' + notice.kind">
        <span data-test="update-text">{{ notice.text }}</span>
        <el-button v-if="notice.kind === 'update'" type="primary" size="small" :loading="acting" data-test="update-download" @click="onDownload">{{ notice.button }}</el-button>
        <el-button v-else-if="notice.button" size="small" :loading="acting" data-test="update-check" @click="onCheck">{{ notice.button }}</el-button>
      </div>
      <pre v-if="notice.kind === 'update' && notice.notes" class="notes" data-test="update-notes">{{ notice.notes }}</pre>
      <p v-if="status.checkedAt" class="hint">上次检查：{{ new Date(status.checkedAt).toLocaleString() }}</p>
    </section>

    <section class="about-card">
      <h2>协议与政策</h2>
      <ul class="legal-list">
        <li v-for="l in links" :key="l.id" :data-test="'legal-' + l.id">
          <a v-if="l.url" :href="l.url" target="_blank" rel="noopener noreferrer">{{ l.label }}</a>
          <span v-else class="pending">{{ l.label }}<em>（{{ PENDING_LABEL }}）</em></span>
        </li>
      </ul>
      <p class="hint" data-test="consent-state">
        <template v-if="consent">已于 {{ consentTime }} 同意当前版本（{{ consent.version }}）。</template>
        <template v-else>尚未记录同意。</template>
      </p>
    </section>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { ArrowLeft } from '@element-plus/icons-vue'
import { PENDING_LABEL, readConsent, resolveLegalLinks, safeLocalStorage } from '@/utils/legal'
import { useDesktopCloud } from '@/composables/useDesktopCloud'
import { downloadResultText, updateNotice } from '@/utils/updatesView'

// 云端更新提示：状态由主进程每 6 小时检查一次后经 IPC 推来（浏览器开发模式下整块不显示）
const { status, isDesktop, checkNow, download } = useDesktopCloud()
const notice = computed(() => updateNotice(status.value, { desktop: isDesktop.value }))
const acting = ref(false)
async function onDownload() {
  acting.value = true
  try {
    const text = downloadResultText(await download())
    if (text) ElMessage.warning(text)
  } finally { acting.value = false }
}
async function onCheck() {
  acting.value = true
  try { await checkNow() } finally { acting.value = false }
}

// 地址由构建配置 VITE_LEGAL_PRIVACY_URL / VITE_LEGAL_TERMS_URL / VITE_LEGAL_REPORT_URL 给出；未配置显示“待发布”
const links = computed(() => resolveLegalLinks(import.meta.env))
const consent = readConsent(safeLocalStorage())
const consentTime = consent ? new Date(consent.acceptedAt).toLocaleString() : ''
</script>

<style scoped>
.about-page { max-width: 720px; margin: 0 auto; padding: 24px 16px; }
.about-header { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
.about-header h1 { margin: 0; font-size: 20px; }
.about-card { padding: 20px 24px; border-radius: 12px; border: 1px solid var(--el-border-color); background: var(--el-bg-color); }
.about-card h2 { margin: 0 0 12px; font-size: 16px; }
.update-card { margin-bottom: 16px; }
.version-line { margin: 0 0 8px; }
.channel { color: var(--el-text-color-secondary); font-size: 13px; }
.update-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.update-row.is-update { color: var(--el-color-primary); font-weight: 600; }
.notes { margin: 10px 0 0; padding: 10px 12px; border-radius: 8px; background: var(--el-fill-color-light); font: inherit; font-size: 13px; white-space: pre-wrap; }
.legal-list { margin: 0; padding-left: 20px; line-height: 2; }
.pending { color: var(--el-text-color-secondary); }
.pending em { font-style: normal; }
.hint { margin: 12px 0 0; font-size: 13px; color: var(--el-text-color-secondary); }
</style>
