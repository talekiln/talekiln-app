<template>
  <div class="library-page">
    <header class="head">
      <el-button text :aria-label="t('home.back')" data-test="library-back" @click="router.push({ name: 'list' })">
        <el-icon><ArrowLeft /></el-icon>{{ t('home.back') }}
      </el-button>
      <h1 class="title">{{ t('home.library.pageTitle') }}</h1>
    </header>

    <el-tabs v-model="tab" class="tabs" data-test="library-tabs" @tab-change="onTab">
      <el-tab-pane v-for="name in TABS" :key="name" :name="name" :label="t(`home.library.tab.${name}`)" lazy>
        <MediaAssetsPanel v-if="name === 'media'" />
        <GlobalLibraryPanel v-else :kind="name" />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft } from '@element-plus/icons-vue'
import { useI18n } from '@/i18n'
import MediaAssetsPanel from '@/components/home/MediaAssetsPanel.vue'
import GlobalLibraryPanel from '@/components/home/GlobalLibraryPanel.vue'

// 四个标签：本地媒体素材 + 全局的角色 / 场景 / 道具库。?tab= 决定初始标签，切换时回写。
const TABS = ['media', 'character', 'scene', 'prop']

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

function tabFromRoute() {
  const q = Array.isArray(route.query.tab) ? route.query.tab[0] : route.query.tab
  return TABS.includes(q) ? q : 'media'
}

const tab = ref(tabFromRoute())

watch(() => route.query.tab, () => {
  const next = tabFromRoute()
  if (next !== tab.value) tab.value = next
})

function onTab(name) {
  if (route.query.tab !== name) router.replace({ name: 'media-library', query: { ...route.query, tab: name } })
}
</script>

<style scoped>
.library-page { min-height: 100vh; padding: 16px 24px 48px; background: var(--bg-page); color: var(--text-primary); }
.head { display: flex; align-items: center; gap: 12px; max-width: 1280px; margin: 0 auto 8px; }
.title { margin: 0; font-size: 20px; font-weight: 600; color: var(--text-bright); }
.tabs { max-width: 1280px; margin: 0 auto; }
</style>
