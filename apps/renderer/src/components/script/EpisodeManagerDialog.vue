<template>
  <el-dialog
    v-model="visible"
    :title="t('script.manage.title')"
    width="640px"
    append-to-body
    class="episode-manager-dialog"
    @closed="emit('close', result)"
  >
    <div class="hint">{{ t('script.manage.hint') }}</div>
    <div v-loading="loading" class="list" data-test="manage-list">
      <div v-if="!loading && !rows.length" class="empty">{{ t('script.manage.empty') }}</div>
      <div v-for="(e, i) in rows" :key="e.id" class="row" :class="{ current: Number(e.id) === Number(episodeId) }" data-test="manage-row">
        <span class="no">{{ episodeLabel(e) }}</span>
        <span class="ttl">{{ e.title || t('script.episode.untitled') }}</span>
        <span class="cnt">{{ t('script.import.chars', { n: String(e.script_content || '').length }) }}</span>
        <el-tag v-if="(e.storyboards || []).length" size="small" type="info">{{ t('script.manage.shots', { n: e.storyboards.length }) }}</el-tag>
        <span class="btns">
          <el-button size="small" text :disabled="busy || i === 0" :aria-label="t('script.manage.up')" data-test="manage-up" @click="move(i, i - 1)">
            <el-icon><ArrowUp /></el-icon>
          </el-button>
          <el-button size="small" text :disabled="busy || i === rows.length - 1" :aria-label="t('script.manage.down')" data-test="manage-down" @click="move(i, i + 1)">
            <el-icon><ArrowDown /></el-icon>
          </el-button>
          <el-button size="small" text :disabled="busy" data-test="manage-rename" @click="rename(e)">{{ t('common.rename') }}</el-button>
          <el-button size="small" text type="danger" :disabled="busy || rows.length <= 1" data-test="manage-delete" @click="remove(e)">{{ t('common.delete') }}</el-button>
        </span>
      </div>
    </div>
    <el-alert v-if="errorText" :title="errorText" type="error" show-icon :closable="false" class="err" />
    <template #footer>
      <el-button :disabled="busy" data-test="manage-add" @click="add">{{ t('script.manage.add') }}</el-button>
      <el-button type="primary" @click="visible = false">{{ t('common.close') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowDown, ArrowUp } from '@element-plus/icons-vue'
import { useI18n } from '@/i18n'
import { episodesAPI } from '@/api/episodes'
import { episodeOrderAfterMove } from '@/utils/scriptTools'
import { addEpisode, deleteEpisode, episodeLabel, errorText as opError, gotoEpisode, moveEpisode, renameEpisode } from './episodeOps'

const props = defineProps({
  dramaId: { type: [Number, String], required: true },
  episodeId: { type: [Number, String], default: null },
})
const emit = defineEmits(['close'])
const { t } = useI18n()
const router = useRouter()

const visible = ref(true)
const loading = ref(true)
const busy = ref(false)
const errorText = ref('')
const rows = ref([])
let result

async function reload() {
  rows.value = await episodesAPI.list(props.dramaId)
}

onMounted(async () => {
  try { await reload() } catch (e) { errorText.value = opError(e) } finally { loading.value = false }
})

// 每个操作：加锁 -> 执行 -> 重读列表；失败只显示错误，不关闭对话框
async function guarded(fn) {
  if (busy.value) return
  busy.value = true
  errorText.value = ''
  try {
    await fn()
    result = { changed: true }
  } catch (e) {
    errorText.value = opError(e)
  } finally {
    try { await reload() } catch (_) { /* 保留旧列表 */ }
    busy.value = false
  }
}

const move = (from, to) => guarded(async () => {
  const order = episodeOrderAfterMove(rows.value, from, to)
  if (order) await moveEpisode({ dramaId: props.dramaId, orderIds: order })
})
const rename = (episode) => guarded(() => renameEpisode({ dramaId: props.dramaId, episode }))
const add = () => guarded(() => addEpisode({ dramaId: props.dramaId }))
const remove = (episode) => guarded(async () => {
  const r = await deleteEpisode({ dramaId: props.dramaId, episode })
  // 删的是正在看的那一集：跳到相邻集，避免页面指着一个不存在的集
  if (r && Number(episode.id) === Number(props.episodeId) && r.next) await gotoEpisode(router, props.dramaId, r.next.id, 'script', true)
})
</script>

<style scoped>
.hint { color: var(--el-text-color-secondary); font-size: 12px; margin-bottom: 8px; }
.list { min-height: 100px; max-height: 420px; overflow: auto; }
.empty { color: var(--el-text-color-secondary); padding: 24px; text-align: center; }
.row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-bottom: 1px solid var(--el-border-color-extra-light); }
.row.current { background: var(--el-color-primary-light-9); }
.no { flex: none; min-width: 64px; color: var(--el-text-color-secondary); font-size: 13px; }
.ttl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cnt { flex: none; color: var(--el-text-color-secondary); font-size: 12px; }
.btns { flex: none; display: flex; align-items: center; }
.err { margin-top: 10px; }
</style>
