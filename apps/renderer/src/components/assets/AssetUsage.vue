<template>
  <section v-if="episodeId" class="usage" data-test="asset-usage">
    <h4 class="h">{{ t('assets.usage.title') }}</h4>
    <p v-if="loading" class="hint">{{ t('common.loading') }}</p>
    <p v-else-if="!shots.length" class="hint">{{ t('assets.usage.none') }}</p>
    <template v-else>
      <div class="chips">
        <el-tag v-for="sb in shots" :key="sb.id" class="chip" effect="plain" size="small" role="link" tabindex="0" @click="openShot(sb)" @keydown.enter="openShot(sb)">
          {{ t('assets.usage.shot', { n: sb.storyboard_number || sb.id }) }}
        </el-tag>
      </div>
      <el-button size="small" :loading="regenerating" :disabled="regenerating" data-test="regen-shots" @click="onRegenerate">
        {{ regenerating ? t('assets.usage.regenProgress', { cur: progress, total: shots.length }) : t('assets.usage.regen') }}
      </el-button>
    </template>
  </section>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useI18n } from '@/i18n'
import { dramaAPI } from '@/api/drama'
import { approveBatch, queueShot } from '@/api/queuedGeneration'
import { affectedShots } from '@/utils/assets'
import { useAssetScope } from './assetContext'

const props = defineProps({
  kind: { type: String, required: true },
  id: { type: [Number, String], required: true },
})
const { t } = useI18n()
const router = useRouter()
const { dramaId, episodeId } = useAssetScope()

const all = ref([])
const loading = ref(false)
const regenerating = ref(false)
const progress = ref(0)

const shots = computed(() => affectedShots(props.kind, props.id, all.value))

let token = 0
async function load() {
  if (!episodeId.value) {
    all.value = []
    return
  }
  const mine = ++token
  loading.value = true
  try {
    const res = await dramaAPI.getStoryboards(episodeId.value)
    if (mine !== token) return
    all.value = Array.isArray(res) ? res : res?.storyboards || res?.items || []
  } catch (_) {
    if (mine === token) all.value = []
  } finally {
    if (mine === token) loading.value = false
  }
}
onMounted(load)
watch(episodeId, load)

function openShot(sb) {
  router.push({ name: 'shot-workbench', params: { dramaId: dramaId.value, episodeId: episodeId.value, shotId: sb.id } })
}

// 关联分镜重新出图：走分镜队列（先估价确认一次，再逐个入队），不经过旧的同步出图路由。
async function onRegenerate() {
  const list = shots.value
  if (!list.length || regenerating.value) return
  try {
    await ElMessageBox.confirm(
      t('assets.usage.regenConfirm', { n: list.length, nums: list.map((s) => s.storyboard_number || s.id).join(', ') }),
      t('assets.usage.regenTitle'),
      { type: 'warning', confirmButtonText: t('assets.usage.regenOk'), cancelButtonText: t('common.cancel') },
    )
  } catch (_) {
    return
  }
  regenerating.value = true
  progress.value = 0
  let failed = 0
  try {
    await approveBatch(episodeId.value, list.map((s) => s.id), 'image')
    for (const sb of list) {
      progress.value += 1
      try {
        await queueShot(episodeId.value, sb.id, 'image', { regenerate: true })
      } catch (_) {
        failed += 1
      }
    }
    if (failed) ElMessage.warning(t('assets.usage.regenPartial', { failed, total: list.length }))
    else ElMessage.success(t('assets.usage.regenQueued', { n: list.length }))
  } catch (e) {
    // 取消确认或额度不足：approveBatch 抛出的错误已带原因
    if (e && e.message) ElMessage.info(e.message)
  } finally {
    regenerating.value = false
  }
}
</script>

<style scoped>
.usage { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.h { margin: 0; font-size: 13px; font-weight: 600; color: var(--text-primary); }
.hint { margin: 0; font-size: 12px; color: var(--text-muted); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { cursor: pointer; }
</style>
