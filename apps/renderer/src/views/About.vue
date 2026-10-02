<template>
  <div class="about-page" data-test="about">
    <header class="about-header">
      <el-button size="small" @click="$router.back()">
        <el-icon><ArrowLeft /></el-icon> 返回
      </el-button>
      <h1>关于故事窑</h1>
    </header>

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
import { computed } from 'vue'
import { ArrowLeft } from '@element-plus/icons-vue'
import { PENDING_LABEL, readConsent, resolveLegalLinks, safeLocalStorage } from '@/utils/legal'

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
.legal-list { margin: 0; padding-left: 20px; line-height: 2; }
.pending { color: var(--el-text-color-secondary); }
.pending em { font-style: normal; }
.hint { margin: 12px 0 0; font-size: 13px; color: var(--el-text-color-secondary); }
</style>
