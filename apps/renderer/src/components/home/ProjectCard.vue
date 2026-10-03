<template>
  <article class="project-card" :data-test="`project-card-${project.id}`">
    <div class="cover" :class="{ empty: !info.cover }" aria-hidden="true" @click="$emit('open', project)">
      <img v-if="info.cover" :src="info.cover" alt="" loading="lazy" />
      <el-icon v-else :size="28"><Film /></el-icon>
    </div>
    <div class="head">
      <button type="button" class="open" :aria-label="t('home.card.openAria', { title: displayTitle })" data-test="card-open" @click="$emit('open', project)">
        {{ displayTitle }}
      </button>
      <el-dropdown trigger="click" @command="onCommand">
        <button type="button" class="more" :aria-label="t('home.card.menuAria', { title: displayTitle })" data-test="card-menu">
          <el-icon><MoreFilled /></el-icon>
        </button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="zip" data-test="menu-zip"><el-icon><Download /></el-icon>{{ t('home.card.menu.zip') }}</el-dropdown-item>
            <el-dropdown-item command="backup" data-test="menu-backup"><el-icon><FolderChecked /></el-icon>{{ t('home.card.menu.backup') }}</el-dropdown-item>
            <el-dropdown-item command="rename" data-test="menu-rename"><el-icon><Edit /></el-icon>{{ t('home.card.menu.rename') }}</el-dropdown-item>
            <el-dropdown-item command="delete" divided data-test="menu-delete"><el-icon><Delete /></el-icon>{{ t('home.card.menu.delete') }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
    <div class="body">
      <div class="meta">{{ metaText }}</div>
      <div class="next" data-test="card-next">{{ nextText }}</div>
    </div>
  </article>
</template>

<script setup>
import { computed } from 'vue'
import { Delete, Download, Edit, Film, FolderChecked, MoreFilled } from '@element-plus/icons-vue'
import { useI18n } from '@/i18n'
import { cardNextStop, formatUpdated, projectCardInfo } from '@/utils/homeModel'

const props = defineProps({
  project: { type: Object, required: true },
  // shell store 的 lastView(dramaId)：{ episodeId, view } | null
  lastVisited: { type: Object, default: null },
})
const emit = defineEmits(['open', 'zip', 'backup', 'rename', 'delete'])

const { t, locale } = useI18n()

const info = computed(() => projectCardInfo(props.project))
const stop = computed(() => cardNextStop(props.project, props.lastVisited))
const displayTitle = computed(() => props.project.title || t('home.card.untitled'))

const metaText = computed(() => {
  const parts = [t('home.card.episodes', { n: info.value.episodeCount })]
  if (info.value.shotCount) parts.push(t('home.card.shots', { n: info.value.shotCount }))
  if (info.value.aspect) parts.push(info.value.aspect)
  const when = formatUpdated(info.value.updatedAt, locale.value)
  if (when) parts.push(when)
  return parts.join(' · ')
})

const nextText = computed(() => {
  const s = stop.value
  if (s.kind === 'last') return t('home.card.lastAt', { ep: s.episodeNumber ?? '?', view: t(`home.view.${s.view}`) })
  if (s.kind === 'first') return t('home.card.startAt', { ep: s.episodeNumber ?? '?', view: t(`home.view.${s.view}`) })
  return t('home.card.noEpisodes')
})

function onCommand(cmd) {
  emit(cmd, props.project)
}
</script>

<style scoped>
.project-card {
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px;
}
.project-card:hover, .project-card:focus-within { border-color: var(--el-color-primary); }
.cover { display: flex; align-items: center; justify-content: center; aspect-ratio: 16 / 9; overflow: hidden; background: var(--bg-inner); color: var(--text-subtle); cursor: pointer; }
.cover img { width: 100%; height: 100%; object-fit: cover; }
.head { display: flex; align-items: center; gap: 6px; padding: 8px 8px 0 12px; }
.open {
  flex: 1; min-width: 0; padding: 4px 0; border: 0; background: transparent; color: var(--text-bright);
  font: inherit; font-size: 15px; font-weight: 700; text-align: left; cursor: pointer;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.open:focus-visible, .more:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 1px; border-radius: 6px; }
.more {
  display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px;
  border: 0; border-radius: 8px; background: transparent; color: var(--text-muted); cursor: pointer;
}
.more:hover { background: var(--bg-hover); color: var(--text-primary); }
.body { display: flex; flex-direction: column; gap: 2px; padding: 0 12px 12px; }
.meta, .next { font-size: 12px; color: var(--text-muted); line-height: 1.5; }
.next { color: var(--el-color-primary); }
</style>
