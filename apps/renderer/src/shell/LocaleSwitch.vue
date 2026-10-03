<template>
  <el-dropdown trigger="click" @command="setLocale">
    <button type="button" class="locale-btn" :aria-label="t('shell.locale.label')" :title="t('shell.locale.label')" data-test="locale-switch">
      <el-icon><Switch /></el-icon>
      <span>{{ locale === 'en' ? 'EN' : '中' /* i18n-ignore */ }}</span>
    </button>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item command="zh-CN" :class="{ active: locale === 'zh-CN' }">中文 <!-- i18n-ignore --></el-dropdown-item>
        <el-dropdown-item command="en" :class="{ active: locale === 'en' }">English</el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup>
import { useI18n } from '@/i18n'

const { t, locale, setLocale } = useI18n()
</script>

<style scoped>
.locale-btn {
  display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 8px;
  border: 1px solid var(--border-muted); border-radius: 6px; background: transparent;
  color: var(--text-muted); font-size: 12px; cursor: pointer;
}
.locale-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
:deep(.active) { color: var(--el-color-primary); font-weight: 600; }
</style>
