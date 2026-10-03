<template>
  <header class="home-bar" data-test="home-bar">
    <div class="brand">
      <el-icon :size="22" class="logo" aria-hidden="true"><Orange /></el-icon>
      <span class="brand-name">{{ t('home.brand') }}</span>
    </div>
    <span class="spacer" />
    <nav class="links" :aria-label="t('home.bar.aria')">
      <button type="button" class="link" data-test="bar-library" @click="openLibrary">{{ t('home.bar.library') }}</button>
      <button type="button" class="link" data-test="bar-templates" @click="go({ name: 'templates' })">{{ t('home.bar.templates') }}</button>
      <button type="button" class="link" data-test="bar-tasks" @click="go({ name: 'task-center' })">{{ t('home.bar.tasks') }}</button>
      <button type="button" class="link" data-test="bar-spend" @click="go({ name: 'spend' })">{{ t('home.bar.spend') }}</button>
      <el-dropdown trigger="click" placement="bottom-end" @command="onSettings">
        <button type="button" class="link" data-test="bar-settings">
          {{ t('home.bar.settings') }}<el-icon class="caret"><ArrowDown /></el-icon>
        </button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="ai-config" data-test="set-ai">{{ t('home.settings.aiConfig') }}</el-dropdown-item>
            <el-dropdown-item command="backup" data-test="set-backup">{{ t('home.settings.backup') }}</el-dropdown-item>
            <el-dropdown-item command="keyboard-settings">{{ t('home.settings.shortcuts') }}</el-dropdown-item>
            <el-dropdown-item command="plugins">{{ t('home.settings.plugins') }}</el-dropdown-item>
            <el-dropdown-item command="studio">{{ t('home.settings.studio') }}</el-dropdown-item>
            <el-dropdown-item command="about" data-test="set-about">{{ t('home.settings.about') }}</el-dropdown-item>
            <el-dropdown-item command="theme" divided data-test="set-theme">{{ isDark ? t('home.settings.themeLight') : t('home.settings.themeDark') }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <LocaleSwitch />
    </nav>
  </header>
</template>

<script setup>
import { ArrowDown, Orange } from '@element-plus/icons-vue'
import { useRouter } from 'vue-router'
import { useI18n } from '@/i18n'
import { useTheme } from '@/composables/useTheme'
import LocaleSwitch from '@/shell/LocaleSwitch.vue'
import { runAction } from '@/shell/actions/registry.js'
import { useActionContext } from '@/shell/context.js'

const emit = defineEmits(['ai-config'])
const { t } = useI18n()
const router = useRouter()
const { isDark, toggle } = useTheme()
const actionCtx = useActionContext()

function go(location) {
  router.push(location)
}

// 和项目内“从素材库导入”共用 assets.globalLibrary 对话框（actions/home.js 的 home.globalLibrary）
function openLibrary() {
  return runAction('home.globalLibrary', actionCtx())
}

function onSettings(cmd) {
  if (cmd === 'ai-config') return emit('ai-config')
  if (cmd === 'theme') return toggle()
  go({ name: cmd })
}
</script>

<style scoped>
.home-bar {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap; min-height: 56px; padding: 8px 16px; box-sizing: border-box;
  background: var(--bg-card); border-bottom: 1px solid var(--border-color);
}
.brand { display: flex; align-items: center; gap: 8px; }
.logo { color: var(--el-color-primary); }
.brand-name { font-weight: 700; font-size: 15px; color: var(--text-bright); }
.spacer { flex: 1 1 24px; }
.links { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.link {
  display: inline-flex; align-items: center; gap: 2px; height: 36px; padding: 0 10px; border: 0; border-radius: 8px;
  background: transparent; color: var(--text-primary); font: inherit; font-size: 13px; cursor: pointer;
}
.link:hover { background: var(--bg-hover); }
.link:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 1px; }
</style>
