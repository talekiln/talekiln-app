<template>
  <div class="workbench">
    <div class="page-header">
      <el-button text @click="$router.back()"><el-icon><ArrowLeft /></el-icon>返回</el-button>
      <h2 class="page-title">分镜工作台 · 镜 {{ shot?.storyboard_number ?? '' }}</h2>
      <span class="spacer" />
      <el-tag v-if="genChip" :type="genChip.type" data-test="gen-chip">{{ genChip.label }}</el-tag>
      <span v-if="genFailureText" class="gen-fail">{{ genFailureText }}</span>
      <el-button text @click="$router.push('/task-center')">任务中心</el-button>
      <el-button :disabled="!episodeId || genBusy" data-test="gen-frame" @click="askGenerate('image')">生成首帧图</el-button>
      <el-button :disabled="!episodeId || genBusy" data-test="gen-both" @click="askGenerate('both')">首帧图 + 视频</el-button>
      <el-button type="primary" :disabled="!episodeId || genBusy" data-test="gen-video" @click="regenerate">重新生成视频 (R)</el-button>
      <!-- 旧的同步出视频：仅在 config.yaml generation.legacy_enabled=true 时出现 -->
      <template v-if="gen.legacyEnabled.value">
        <el-select v-model="model" placeholder="视频模型（旧流程）" style="width: 200px">
          <el-option v-for="m in models" :key="m" :label="m" :value="m" />
        </el-select>
        <el-button type="warning" plain :loading="busy" :disabled="!canRegen" @click="regenerateLegacy">旧流程生成（不走队列）</el-button>
      </template>
    </div>

    <div v-loading="loading" class="grid">
      <section class="panel">
        <h4>首帧</h4>
        <el-image v-if="firstFrame" :src="firstFrame" fit="contain" class="frame" :preview-src-list="[firstFrame]" />
        <div v-else class="frame empty">该镜头尚无首帧图</div>
        <p class="prompt">{{ shot?.video_prompt || shot?.description || '（无提示词）' }}</p>
      </section>

      <section class="panel main">
        <el-tabs v-model="tab">
          <el-tab-pane label="当前视频" name="video">
            <video v-if="adoptedSrc" :key="adoptedSrc" :src="adoptedSrc" controls class="player" />
            <div v-else class="player empty">尚未采用视频</div>
          </el-tab-pane>
          <el-tab-pane label="A/B 对比 (Tab)" name="compare">
            <div class="ab-bar">
              <span>A</span>
              <el-select :model-value="compare.a" size="small" style="width: 90px" @change="(v) => (compare = setCompareSide(compare, 'a', v))">
                <el-option v-for="s in playableSlots" :key="s" :label="`V${s}`" :value="s" />
              </el-select>
              <span>B</span>
              <el-select :model-value="compare.b" size="small" style="width: 90px" clearable @change="(v) => (compare = setCompareSide(compare, 'b', v ?? null))">
                <el-option v-for="s in playableSlots" :key="s" :label="`V${s}`" :value="s" />
              </el-select>
              <el-tag :type="compare.showing === 'a' ? 'primary' : 'warning'">正在看 {{ compare.showing.toUpperCase() }}{{ shownNo ? ` (V${shownNo})` : '' }}</el-tag>
              <el-button size="small" :disabled="compare.a == null || compare.b == null" @click="doToggle">切换 A/B</el-button>
            </div>
            <video v-if="compareSrc" :key="compareSrc" :src="compareSrc" controls class="player" />
            <div v-else class="player empty">至少需要两个已完成的候选才能对比</div>
          </el-tab-pane>
        </el-tabs>
      </section>
    </div>

    <GenerateDialog :state="gen.dialog.value" @confirm="gen.confirm" @cancel="gen.cancel" />

    <h4>候选视频（Alt+1..4 采用）</h4>
    <div class="cands">
      <div v-for="(c, i) in slots" :key="i" class="cand" :class="{ adopted: c && c.adopted }">
        <div class="cand-head">
          <strong>V{{ i + 1 }}</strong>
          <el-tag v-if="c && c.adopted" size="small" type="success">已采用</el-tag>
          <el-tag v-else-if="c && c.status === 'processing'" size="small">生成中</el-tag>
          <el-tag v-else-if="c && c.status === 'failed'" size="small" type="danger">失败</el-tag>
        </div>
        <video v-if="c && isPlayable(c)" :src="candidateVideoSrc(c)" controls class="thumb" preload="metadata" />
        <div v-else class="thumb empty">{{ c ? (c.error_msg || '等待结果…') : '空' }}</div>
        <el-button size="small" type="primary" :disabled="!pickableAt(slots, i + 1) || (c && c.adopted)" @click="pick(i + 1)">采用 V{{ i + 1 }}</el-button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowLeft } from '@element-plus/icons-vue'
import { storyboardsAPI } from '@/api/storyboards'
import { aiAPI } from '@/api/ai'
import { videosAPI } from '@/api/videos'
import { shotCandidatesAPI } from '@/api/referenceLocks'
import { dramaAPI } from '@/api/drama'
import { useKeymap } from '@/composables/useKeymap'
import GenerateDialog from '@/components/GenerateDialog.vue'
import { useGeneration } from '@/composables/useGeneration'
import { failureText, isBusy } from '@/utils/generationView'
import { SCOPE_WORKBENCH } from '@/utils/keymap'
import { assetImageUrl } from '@/utils/mediaUrl'
import { getSelectableModels } from '@/utils/modelSelection'
import {
  buildRegenerateBody, buildWorkbenchHandlers, candidateVideoSrc, canRegenerate, createCompare, defaultCompare,
  isPlayable, pickableAt, setCompareSide, shownSlot, toSlots, toggleCompare,
} from '@/utils/shotWorkbench'

const route = useRoute()
const shotId = route.params.shotId
const shot = ref(null)
const loading = ref(false)
const busy = ref(false)
const models = ref([])
const model = ref('')
const tab = ref('video')
const adoptedId = ref(null)
const slots = ref(toSlots([]))
const compare = ref(createCompare())
const aspectRatio = ref('')
let timer = null

const firstFrame = computed(() => assetImageUrl(shot.value))
const adopted = computed(() => slots.value.find((c) => c && c.id === adoptedId.value) || null)
const adoptedSrc = computed(() => (adopted.value ? candidateVideoSrc(adopted.value) : (shot.value?.video_url || '')))
const playableSlots = computed(() => slots.value.map((c, i) => (isPlayable(c) ? i + 1 : null)).filter(Boolean))
const shownNo = computed(() => shownSlot(compare.value))
const compareSrc = computed(() => (shownNo.value ? candidateVideoSrc(slots.value[shownNo.value - 1]) : ''))
const canRegen = computed(() => canRegenerate({ busy: busy.value, shot: shot.value, model: model.value }))

const episodeId = computed(() => Number(shot.value?.episode_id) || 0)
const gen = useGeneration(episodeId)
const genStatus = computed(() => gen.shotStatus(shotId))
const genChip = computed(() => gen.chip(shotId))
const genBusy = computed(() => isBusy(genStatus.value))
const genFailureText = computed(() => failureText(genStatus.value))
// 任务结束并写回后，重新读一次镜头（video_url / 首帧已由内核物化到旧列）
watch(() => genStatus.value && genStatus.value.state, (now, before) => {
  if ((before === 'queued' || before === 'running') && now !== before) {
    storyboardsAPI.get(shotId).then((s) => { shot.value = s }).catch(() => {})
  }
})

function applyCandidates(res, resetCompare) {
  slots.value = toSlots(res.items)
  adoptedId.value = res.adopted_video_id ?? null
  const valid = (n) => n != null && isPlayable(slots.value[n - 1])
  if (resetCompare || !valid(compare.value.a) || (compare.value.b != null && !valid(compare.value.b))) {
    compare.value = defaultCompare(slots.value, adoptedId.value)
  }
}

async function refreshCandidates(resetCompare = false) {
  applyCandidates(await shotCandidatesAPI.list(shotId), resetCompare)
}

function ensurePolling() {
  const pending = slots.value.some((c) => c && c.status === 'processing')
  if (pending && !timer) timer = setInterval(() => refreshCandidates().catch(() => {}), 3000)
  if (!pending && timer) { clearInterval(timer); timer = null }
}
watch(slots, ensurePolling)

async function load() {
  loading.value = true
  try {
    shot.value = await storyboardsAPI.get(shotId)
    gen.refresh()
    await refreshCandidates(true)
    dramaAPI.get(route.params.dramaId).then((d) => {
      try { aspectRatio.value = (typeof d.metadata === 'string' ? JSON.parse(d.metadata) : d.metadata)?.aspect_ratio || '' } catch (_) { /* 忽略 */ }
    }).catch(() => {})
    try {
      models.value = getSelectableModels(await aiAPI.list('video'), 'video')
      model.value = models.value[0] || ''
    } catch (_) { /* 模型列表失败不阻塞页面 */ }
  } finally {
    loading.value = false
  }
}

/** 新流程：估算 -> 确认 -> 持久队列；结果写回内核后状态变“最新”，下面自动刷新镜头。 */
function askGenerate(kind, regenerateSeed = false) {
  if (!episodeId.value || genBusy.value) return
  gen.ask({ shots: [Number(shotId)], kind, regenerate: regenerateSeed })
}

/** 重新生成视频 = 换种子后只重做这个镜头的视频（旧版本保留，可在内核里切回）。 */
function regenerate() {
  askGenerate('video', true)
}

async function regenerateLegacy() {
  if (!canRegen.value) return
  busy.value = true
  try {
    await videosAPI.create(buildRegenerateBody({
      shot: { ...shot.value, drama_id: Number(route.params.dramaId) },
      model: model.value, firstFrameUrl: firstFrame.value, aspectRatio: aspectRatio.value,
    }))
    await refreshCandidates()
    ElMessage.success('已提交生成，完成后会出现在候选中（已锁定的角色/场景参考图会自动带上）')
  } catch (e) {
    ElMessage.error(e.message || '提交失败')
  } finally {
    busy.value = false
  }
}

async function pick(n) {
  const c = pickableAt(slots.value, n)
  if (!c) { ElMessage.warning(`V${n} 尚不可用`); return }
  try {
    applyCandidates(await shotCandidatesAPI.adopt(shotId, c.id))
    shot.value = await storyboardsAPI.get(shotId)
    ElMessage.success(`已采用 V${n}`)
  } catch (e) {
    ElMessage.error(e.message || '采用失败')
  }
}

function doToggle() {
  compare.value = toggleCompare(compare.value)
  if (compare.value.a == null || compare.value.b == null) ElMessage.info('需要两个已完成的候选才能 A/B 对比')
  else tab.value = 'compare'
}

const { createKeyHandler } = useKeymap()
const onKeydown = createKeyHandler(
  buildWorkbenchHandlers({ regenerate, pick, toggleCompare: doToggle }),
  [SCOPE_WORKBENCH],
)

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  load()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (timer) clearInterval(timer)
})
</script>

<style scoped>
.workbench { max-width: 1200px; margin: 0 auto; padding: 24px; }
.page-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.page-title { margin: 0; font-size: 18px; }
.spacer { flex: 1; }
.gen-fail { font-size: 12px; color: var(--el-color-danger); max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.grid { display: grid; grid-template-columns: 320px 1fr; gap: 20px; }
.panel h4 { margin: 0 0 8px; }
.frame { width: 100%; aspect-ratio: 16 / 9; background: var(--el-fill-color); border-radius: 6px; }
.prompt { color: var(--el-text-color-secondary); font-size: 13px; white-space: pre-wrap; }
.player { width: 100%; max-height: 420px; background: #000; border-radius: 6px; }
.empty { display: flex; align-items: center; justify-content: center; color: var(--el-text-color-secondary); background: var(--el-fill-color); min-height: 160px; font-size: 13px; text-align: center; padding: 8px; }
.ab-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.cands { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.cand { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 2px solid var(--el-border-color); border-radius: 6px; }
.cand.adopted { border-color: var(--el-color-success); }
.cand-head { display: flex; align-items: center; gap: 8px; }
.thumb { width: 100%; aspect-ratio: 16 / 9; border-radius: 4px; background: #000; object-fit: contain; }
.thumb.empty { min-height: 0; background: var(--el-fill-color); }
@media (max-width: 800px) { .grid { grid-template-columns: 1fr; } .cands { grid-template-columns: repeat(2, 1fr); } }
</style>
