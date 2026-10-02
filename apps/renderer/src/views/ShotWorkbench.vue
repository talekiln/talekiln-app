<template>
  <div class="workbench">
    <div class="page-header">
      <el-button text @click="$router.back()"><el-icon><ArrowLeft /></el-icon>返回</el-button>
      <h2 class="page-title">分镜工作台 · 镜 {{ shot?.storyboard_number ?? '' }}</h2>
      <span class="spacer" />
      <el-tag v-if="genChip" :type="genChip.type" data-test="gen-chip">{{ genChip.label }}</el-tag>
      <span v-if="genFailureText" class="gen-fail">{{ genFailureText }}</span>
      <!-- P3-C 一致性：与锁定参考图的评分（只读；没有锁定参考图或没有内核时不显示） -->
      <el-tooltip v-if="consBadge" :content="consHint" placement="bottom">
        <el-tag :type="consBadge.type" data-test="consistency-chip">{{ consBadge.label }}</el-tag>
      </el-tooltip>
      <el-button text @click="$router.push('/task-center')">任务中心</el-button>
      <el-button :disabled="!episodeId" title="用一句话描述修改，先看计划与花费再执行（可整体撤销）" data-test="open-director" @click="openDirector(episodeId)">导演模式</el-button>
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
        <p v-if="consHint" class="cons-hint" :class="`is-${consBadge.type}`" data-test="consistency-hint">{{ consHint }}</p>
      </section>

      <section class="panel main">
        <el-tabs v-model="tab">
          <el-tab-pane label="当前视频" name="video">
            <div ref="playerWrap" class="player-wrap">
              <video
                v-if="adoptedSrc" ref="playerEl" :key="adoptedSrc" :src="adoptedSrc" controls class="player"
                @loadedmetadata="onMeta" @timeupdate="headMs = nowMs()"
              />
              <div v-else class="player empty">尚未采用视频</div>
              <!-- P3-R：框选区域层，贴在画面实际显示的区域上（黑边不算） -->
              <div
                v-if="adoptedSrc && edit.mode === 'region'" class="rect-layer" :class="{ drawing: drawMode }" :style="layerStyle" data-test="rect-layer"
                @mousedown="onDragStart" @mousemove="onDragMove" @mouseup="onDragEnd" @mouseleave="onDragEnd"
              >
                <div v-if="edit.rect && !drag" class="rect-box" :style="rectStyle(edit.rect)"><span>{{ rectLabel(edit.rect) }} · {{ rectPercent(edit.rect) }}%</span></div>
                <div v-if="drag && drag.rect" class="rect-box live" :style="rectStyle(drag.rect)" />
              </div>
            </div>
          </el-tab-pane>
          <el-tab-pane label="A/B 对比 (Tab)" name="compare">
            <div class="ab-bar">
              <span>A</span>
              <el-select :model-value="compare.a" size="small" style="width: 90px" @change="(v) => (compare = setCompareSide(compare, 'a', v))">
                <el-option v-for="v in playableVersions" :key="v.no" :label="v.label" :value="v.no" />
              </el-select>
              <span>B</span>
              <el-select :model-value="compare.b" size="small" style="width: 90px" clearable @change="(v) => (compare = setCompareSide(compare, 'b', v ?? null))">
                <el-option v-for="v in playableVersions" :key="v.no" :label="v.label" :value="v.no" />
              </el-select>
              <el-tag :type="compare.showing === 'a' ? 'primary' : 'warning'">正在看 {{ compare.showing.toUpperCase() }}{{ shownNo ? ` (V${shownNo})` : '' }}</el-tag>
              <el-button size="small" :disabled="compare.a == null || compare.b == null" @click="doToggle">切换 A/B</el-button>
              <el-button v-if="shownVersion && !shownVersion.adopted" size="small" type="primary" @click="adoptVersion(shownVersion)">采用 {{ shownVersion.label }}</el-button>
            </div>
            <video v-if="compareSrc" :key="compareSrc" :src="compareSrc" controls class="player" />
            <div v-else class="player empty">至少需要两个有文件的版本才能对比</div>
          </el-tab-pane>
          <el-tab-pane label="候选（旧流程）" name="legacy">
            <div class="cands legacy">
              <div v-for="(c, i) in slots" :key="i" class="cand" :class="{ adopted: c && c.adopted }">
                <div class="cand-head">
                  <strong>候选 {{ i + 1 }}</strong>
                  <el-tag v-if="c && c.adopted" size="small" type="success">已采用</el-tag>
                  <el-tag v-else-if="c && c.status === 'processing'" size="small">生成中</el-tag>
                  <el-tag v-else-if="c && c.status === 'failed'" size="small" type="danger">失败</el-tag>
                </div>
                <video v-if="c && isPlayable(c)" :src="candidateVideoSrc(c)" controls class="thumb" preload="metadata" />
                <div v-else class="thumb empty">{{ c ? (c.error_msg || '等待结果…') : '空' }}</div>
                <el-button size="small" :disabled="!pickableAt(slots, i + 1) || (c && c.adopted)" @click="pickLegacy(i + 1)">采用候选 {{ i + 1 }}</el-button>
              </div>
            </div>
          </el-tab-pane>
        </el-tabs>

        <!-- P3-R 选镜改片：只重做 [入点, 出点) 里框选的区域 -->
        <div class="region-edit" data-test="region-edit">
          <div class="re-head">
            <h4>选镜改片</h4>
            <el-radio-group v-model="edit.mode" size="small">
              <el-radio-button v-for="m in MODES" :key="m.value" :value="m.value">{{ m.label }}</el-radio-button>
            </el-radio-group>
            <span class="spacer" />
            <span v-if="regionList" class="hint">{{ strategyText(regionList.strategy) }}</span>
          </div>
          <template v-if="totalMs">
            <div class="clip-bar" data-test="clip-bar" @click="onBarClick">
              <div class="clip-range" :style="rangeStyle(edit.range, totalMs)" />
              <div class="clip-head" :style="{ left: headPercent }" />
            </div>
            <div class="re-row">
              <el-button size="small" @click="doMarkIn">设入点 (I)</el-button>
              <el-input-number
                :model-value="edit.range.t0 / 1000" :min="0" :max="totalMs / 1000" :step="0.1" :precision="2" size="small" controls-position="right" style="width: 120px"
                @change="(v) => setRange({ t0: Math.round((v || 0) * 1000) })"
              />
              <el-button size="small" @click="doMarkOut">设出点 (O)</el-button>
              <el-input-number
                :model-value="edit.range.t1 / 1000" :min="0" :max="totalMs / 1000" :step="0.1" :precision="2" size="small" controls-position="right" style="width: 120px"
                @change="(v) => setRange({ t1: Math.round((v || 0) * 1000) })"
              />
              <span class="hint">{{ formatMs(edit.range.t0) }} – {{ formatMs(edit.range.t1) }}，按 {{ segmentSeconds(edit.range.t0, edit.range.t1) }} 秒计费（整条 {{ formatMs(totalMs) }}）</span>
            </div>
            <div v-if="edit.mode === 'region'" class="re-row">
              <el-button size="small" :type="drawMode ? 'primary' : 'default'" data-test="re-draw" @click="drawMode = !drawMode">{{ drawMode ? '在画面上拖出矩形…' : '框选区域' }}</el-button>
              <el-button size="small" :disabled="!edit.rect" @click="edit.rect = null">清除</el-button>
              <span class="hint">{{ edit.rect ? `${rectLabel(edit.rect)} · 约占画面 ${rectPercent(edit.rect)}%` : '先在上方画面里拖出一个矩形' }}</span>
            </div>
            <el-input v-model="edit.prompt" type="textarea" :rows="2" maxlength="300" show-word-limit placeholder="要改成什么样？例如：把伞换成红色" data-test="re-prompt" />
            <div class="re-row">
              <span v-if="estimateState.loading" class="hint">估算中…</span>
              <span v-else-if="estimateState.data" class="cost" data-test="re-cost">{{ costLine(estimateState.data) }}</span>
              <span v-else-if="estimateState.error" class="gen-fail">{{ estimateState.error }}</span>
              <span v-else class="hint">填好入点 / 出点、区域和提示词后显示费用</span>
              <span class="spacer" />
              <el-button type="primary" size="small" :loading="submitting" :disabled="!canSubmit" data-test="re-submit" @click="submitEdit">确认改片</el-button>
            </div>
            <p v-if="refusal" class="gen-fail">{{ refusal }}</p>
          </template>
          <p v-else class="hint">先生成并采用一版视频，再框选时间段和区域修改。</p>

          <ul v-if="regionItems.length" class="re-list" data-test="re-list">
            <li v-for="it in regionItems" :key="it.id">
              <el-tag size="small" :type="regionStatusType(it.status)">{{ regionStatusText(it.status) }}</el-tag>
              <span class="re-line" :title="regionLine(it)">{{ regionLine(it) }}</span>
              <span v-if="it.error" class="gen-fail" :title="it.error">{{ it.error }}</span>
              <el-button v-if="it.status === 'done' && it.result_version_id" size="small" text type="primary" @click="adoptById(it.result_version_id)">采用结果</el-button>
            </li>
          </ul>
        </div>
      </section>
    </div>

    <GenerateDialog :state="gen.dialog.value" @confirm="gen.confirm" @cancel="gen.cancel" />

    <h4>版本（Alt+1..4 采用前四版）</h4>
    <div v-if="versions.length" class="cands" data-test="versions">
      <div v-for="v in versions" :key="v.id" class="cand" :class="{ adopted: v.adopted }">
        <div class="cand-head">
          <strong>{{ v.label }}</strong>
          <el-tag v-if="v.adopted" size="small" type="success">已采用</el-tag>
          <el-tag v-if="v.isEdit" size="small" type="warning">改片</el-tag>
          <span class="hint">{{ v.source }}</span>
        </div>
        <video v-if="v.playable" :src="v.src" controls class="thumb" preload="metadata" />
        <div v-else class="thumb empty">无文件</div>
        <div class="hint ellipsis" :title="v.regionText || v.meta">{{ v.regionText || v.meta || '　' }}</div>
        <el-button size="small" type="primary" :disabled="!v.playable || v.adopted" @click="adoptVersion(v)">{{ adoptHint(v) }}</el-button>
      </div>
    </div>
    <div v-else class="empty">还没有视频版本：生成一版视频后会出现在这里（旧流程的候选在上方「候选（旧流程）」）</div>
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
import { consistencyAPI } from '@/api/consistency'
import { dramaAPI } from '@/api/drama'
import { kernelAPI } from '@/api/kernel'
import { regionEditAPI } from '@/api/regionEdit'
import { useKeymap } from '@/composables/useKeymap'
import GenerateDialog from '@/components/GenerateDialog.vue'
import { useGeneration } from '@/composables/useGeneration'
import { openDirector } from '@/composables/useDirectorPanel'
import { useProjectViewsStore } from '@/stores/projectViews'
import { failureText, isBusy } from '@/utils/generationView'
import { consistencyBadge, consistencyHint, consistencyShotMap, shouldRefreshConsistency } from '@/utils/consistencyView'
import { SCOPE_WORKBENCH } from '@/utils/keymap'
import { assetImageUrl } from '@/utils/mediaUrl'
import { getSelectableModels } from '@/utils/modelSelection'
import {
  buildRegenerateBody, buildWorkbenchHandlers, candidateVideoSrc, canRegenerate, createCompare,
  isPlayable, pickableAt, setCompareSide, shownSlot, toSlots, toggleCompare,
} from '@/utils/shotWorkbench'
import {
  MODES, adoptHint, canSubmitEdit, clampRange, contentBox, costLine, defaultVersionCompare, editRequestBody, findVideoVersions, formatMs, fullRange,
  isRegionPending, markIn, markOut, msAtFraction, rangeStyle, rectFromDrag, rectLabel, rectPercent, rectStyle, refusalText, regionLine,
  regionStatusText, regionStatusType, segmentSeconds, strategyText, versionAt, versionItems,
} from '@/utils/regionEdit'

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

// ---------- 内核版本（P3-R：版本列表、A/B 对比、采用都基于内核版本） ----------
const regionList = ref(null) // GET /shots/:id/edit-regions：改片记录 + 视频节点 + 片长
const videoInfo = ref(null) // GET /episodes/:id/versions 里该镜头的视频节点项
const versions = computed(() => versionItems(videoInfo.value, regionList.value?.items || []))
const playableVersions = computed(() => versions.value.filter((v) => v.playable))
const regionItems = computed(() => regionList.value?.items || [])
const adoptedVersion = computed(() => versions.value.find((v) => v.adopted) || null)

const firstFrame = computed(() => assetImageUrl(shot.value))
const legacyAdopted = computed(() => slots.value.find((c) => c && c.id === adoptedId.value) || null)
const adoptedSrc = computed(() => adoptedVersion.value?.src || (legacyAdopted.value ? candidateVideoSrc(legacyAdopted.value) : (shot.value?.video_url || '')))
const shownNo = computed(() => shownSlot(compare.value))
const shownVersion = computed(() => (shownNo.value ? versionAt(versions.value, shownNo.value) : null))
const compareSrc = computed(() => (shownVersion.value ? shownVersion.value.src : ''))
const canRegen = computed(() => canRegenerate({ busy: busy.value, shot: shot.value, model: model.value }))

const episodeId = computed(() => Number(shot.value?.episode_id) || 0)
const gen = useGeneration(episodeId)
// 导演模式执行 / 撤销（或别处的内核撤销）后，重新读取这个镜头（字段已由内核物化到旧表）
const views = useProjectViewsStore()
watch(() => views.revision, () => { if (!loading.value) load() })
const genStatus = computed(() => gen.shotStatus(shotId))
const genChip = computed(() => gen.chip(shotId))
const genBusy = computed(() => isBusy(genStatus.value))
const genFailureText = computed(() => failureText(genStatus.value))
// P3-C 一致性评分（只读）：结果写回后内核在后台评分，所以任务结束时拉一次、稍后再拉一次
const consistency = ref(null)
const consShot = computed(() => consistencyShotMap(consistency.value).get(Number(shotId)) || null)
const consBadge = computed(() => consistencyBadge(consShot.value))
const consHint = computed(() => consistencyHint(consShot.value, consistency.value?.min_score))
let consTimer = null
async function loadConsistency() {
  if (!episodeId.value) return
  try { consistency.value = await consistencyAPI.episodeReport(episodeId.value) } catch (_) { /* request.js 已提示 */ }
}
// 任务结束并写回后，重新读一次镜头（video_url / 首帧已由内核物化到旧列）
watch(() => genStatus.value && genStatus.value.state, (now, before) => {
  if (shouldRefreshConsistency(before, now)) {
    storyboardsAPI.get(shotId).then((s) => { shot.value = s }).catch(() => {})
    loadConsistency()
    clearTimeout(consTimer)
    consTimer = setTimeout(loadConsistency, 4000)
    refreshVersions().catch(() => {})
  }
})

function applyCandidates(res) {
  slots.value = toSlots(res.items)
  adoptedId.value = res.adopted_video_id ?? null
}

async function refreshCandidates() {
  applyCandidates(await shotCandidatesAPI.list(shotId))
}

/** 版本列表：/versions 的节点项为准（与版本历史抽屉同一份），拿不到时退回改片接口附带的那份。 */
async function refreshVersions() {
  let list = null
  try { list = await regionEditAPI.list(shotId) } catch (_) { return }
  regionList.value = list
  let info = null
  if (episodeId.value) {
    try { info = findVideoVersions(await kernelAPI.versions(episodeId.value), { node: list.node, shotId: list.shot_id }) } catch (_) { info = null }
  }
  videoInfo.value = info || list.versions || null
  if (!edit.value.touched) edit.value.range = fullRange(totalMs.value)
  const valid = (n) => n != null && !!versionAt(versions.value, n)
  if (!valid(compare.value.a) || (compare.value.b != null && !valid(compare.value.b))) compare.value = defaultVersionCompare(versions.value)
}

function ensurePolling() {
  const pending = slots.value.some((c) => c && c.status === 'processing') || regionItems.value.some((it) => isRegionPending(it.status))
  if (pending && !timer) timer = setInterval(() => { refreshCandidates().catch(() => {}); refreshVersions().catch(() => {}) }, 3000)
  if (!pending && timer) { clearInterval(timer); timer = null }
}
watch([slots, regionItems], ensurePolling)

async function load() {
  loading.value = true
  try {
    shot.value = await storyboardsAPI.get(shotId)
    gen.refresh()
    loadConsistency()
    await Promise.all([refreshCandidates().catch(() => {}), refreshVersions()])
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

/** 新流程：估算 -> 确认 -> 持久队列；结果写回内核后状态变“最新”，上面自动刷新镜头。 */
function askGenerate(kind, regenerateSeed = false) {
  if (!episodeId.value || genBusy.value) return
  gen.ask({ shots: [Number(shotId)], kind, regenerate: regenerateSeed })
}

/** 重新生成视频 = 换种子后只重做这个镜头的视频（旧版本保留，可在下面的版本列表切回）。 */
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

/** 采用内核版本：服务端用 adoptShotVersion，让节点参数跟随版本配方（采用改片结果 / 切回原版本都保持“最新”）。 */
async function adoptVersion(v) {
  if (!v || !v.playable || v.adopted) return
  try {
    await regionEditAPI.adopt(shotId, v.id)
    await refreshVersions()
    shot.value = await storyboardsAPI.get(shotId)
    gen.refresh()
    ElMessage.success(`已采用 ${v.label}`)
  } catch (_) { /* request.js 已提示 */ }
}
const adoptById = (id) => adoptVersion(versions.value.find((v) => v.id === id))

/** Alt+N：有内核版本时采用第 N 版；没有（纯旧流程项目）时采用旧候选。 */
function pick(n) {
  if (versions.value.length) {
    const v = versionAt(versions.value, n)
    if (!v) { ElMessage.warning(`V${n} 不可用`); return }
    return adoptVersion(v)
  }
  return pickLegacy(n)
}

async function pickLegacy(n) {
  const c = pickableAt(slots.value, n)
  if (!c) { ElMessage.warning(`候选 ${n} 尚不可用`); return }
  try {
    applyCandidates(await shotCandidatesAPI.adopt(shotId, c.id))
    shot.value = await storyboardsAPI.get(shotId)
    ElMessage.success(`已采用候选 ${n}`)
  } catch (e) {
    ElMessage.error(e.message || '采用失败')
  }
}

function doToggle() {
  compare.value = toggleCompare(compare.value)
  if (compare.value.a == null || compare.value.b == null) ElMessage.info('需要两个有文件的版本才能 A/B 对比')
  else tab.value = 'compare'
}

// ---------- 选镜改片 ----------
const playerWrap = ref(null)
const playerEl = ref(null)
const playerMs = ref(0) // 播放器读到的真实片长（内核没记时长时用）
const headMs = ref(0)
const dims = ref({ elWidth: 0, elHeight: 0, videoWidth: 0, videoHeight: 0 })
const drawMode = ref(false)
const drag = ref(null)
const submitting = ref(false)
const edit = ref({ range: { t0: 0, t1: 0 }, rect: null, prompt: '', mode: 'region', touched: false })
const estimateState = ref({ loading: false, data: null, error: '' })

const totalMs = computed(() => Number(regionList.value?.total_ms) || playerMs.value || Math.round((Number(shot.value?.duration) || 0) * 1000))
const headPercent = computed(() => (totalMs.value ? `${Math.min(100, (headMs.value / totalMs.value) * 100).toFixed(2)}%` : '0%'))
const layerStyle = computed(() => {
  const b = contentBox(dims.value)
  return { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` }
})
const editBody = computed(() => editRequestBody({ range: edit.value.range, rect: edit.value.rect, prompt: edit.value.prompt, mode: edit.value.mode, total: totalMs.value }))
const refusal = computed(() => refusalText(estimateState.value.data))
const canSubmit = computed(() => canSubmitEdit({ total: totalMs.value, prompt: edit.value.prompt, range: edit.value.range, rect: edit.value.rect, mode: edit.value.mode, busy: submitting.value }) && !refusal.value)

const nowMs = () => Math.round((playerEl.value?.currentTime || 0) * 1000)
function measure() {
  const el = playerEl.value
  if (!el) return
  dims.value = { elWidth: el.clientWidth, elHeight: el.clientHeight, videoWidth: el.videoWidth, videoHeight: el.videoHeight }
}
function onMeta(e) {
  playerMs.value = Math.round((e.target.duration || 0) * 1000) || 0
  if (!edit.value.touched) edit.value.range = fullRange(totalMs.value)
  measure()
}
function setRange(patch) {
  edit.value.range = clampRange({ ...edit.value.range, ...patch }, totalMs.value)
  edit.value.touched = true
}
function doMarkIn() {
  if (!totalMs.value) return
  edit.value.range = markIn(edit.value.range, nowMs(), totalMs.value)
  edit.value.touched = true
}
function doMarkOut() {
  if (!totalMs.value) return
  edit.value.range = markOut(edit.value.range, nowMs(), totalMs.value)
  edit.value.touched = true
}
function onBarClick(e) {
  const r = e.currentTarget.getBoundingClientRect()
  const ms = msAtFraction((e.clientX - r.left) / (r.width || 1), totalMs.value)
  if (playerEl.value) playerEl.value.currentTime = ms / 1000
  headMs.value = ms
}

function pointIn(e) {
  const r = e.currentTarget.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top, box: { width: r.width, height: r.height } }
}
function onDragStart(e) {
  if (!drawMode.value || e.button !== 0) return
  e.preventDefault()
  measure()
  const p = pointIn(e)
  drag.value = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, box: p.box, rect: null }
}
function onDragMove(e) {
  if (!drag.value) return
  const p = pointIn(e)
  drag.value = { ...drag.value, x1: p.x, y1: p.y, rect: rectFromDrag({ ...drag.value, x1: p.x, y1: p.y }, drag.value.box) }
}
function onDragEnd() {
  if (!drag.value) return
  const rect = rectFromDrag(drag.value, drag.value.box)
  if (rect) { edit.value.rect = rect; drawMode.value = false }
  drag.value = null
}

// 表单一变就重新估算（去抖）：confirm=false 不建任务
let estTimer = null
watch(editBody, (body) => {
  clearTimeout(estTimer)
  if (!body) { estimateState.value = { loading: false, data: null, error: '' }; return }
  estimateState.value = { ...estimateState.value, loading: true }
  estTimer = setTimeout(async () => {
    try { estimateState.value = { loading: false, data: await regionEditAPI.estimate(shotId, body), error: '' } }
    catch (e) { estimateState.value = { loading: false, data: null, error: e.message || '估算失败' } }
  }, 400)
})

async function submitEdit() {
  const body = editBody.value
  if (!body || !canSubmit.value) return
  submitting.value = true
  try {
    const r = await regionEditAPI.submit(shotId, body)
    ElMessage.success(r.outcome === 'created' ? '已提交改片，完成后出现在版本列表（不会自动采用）' : r.outcome === 'retried' ? '已重试这次改片' : '这次改片已在队列里')
    edit.value.prompt = ''
    await refreshVersions()
  } catch (_) { /* 超额度等错误已由 request.js 提示 */ } finally {
    submitting.value = false
  }
}

const { createKeyHandler } = useKeymap()
const onKeydown = createKeyHandler(
  buildWorkbenchHandlers({ regenerate, pick, toggleCompare: doToggle, markIn: doMarkIn, markOut: doMarkOut }),
  [SCOPE_WORKBENCH],
)

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('resize', measure)
  load()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', measure)
  if (timer) clearInterval(timer)
  clearTimeout(consTimer)
  clearTimeout(estTimer)
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
.cons-hint { font-size: 12px; margin: 4px 0 0; color: var(--el-text-color-secondary); }
.cons-hint.is-warning { color: var(--el-color-warning); }
.cons-hint.is-danger { color: var(--el-color-danger); }
.player-wrap { position: relative; }
.player { width: 100%; max-height: 420px; background: #000; border-radius: 6px; display: block; }
.empty { display: flex; align-items: center; justify-content: center; color: var(--el-text-color-secondary); background: var(--el-fill-color); min-height: 160px; font-size: 13px; text-align: center; padding: 8px; }
.ab-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.cands { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.cands.legacy { grid-template-columns: repeat(2, 1fr); }
.cand { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 2px solid var(--el-border-color); border-radius: 6px; }
.cand.adopted { border-color: var(--el-color-success); }
.cand-head { display: flex; align-items: center; gap: 8px; }
.thumb { width: 100%; aspect-ratio: 16 / 9; border-radius: 4px; background: #000; object-fit: contain; }
.thumb.empty { min-height: 0; background: var(--el-fill-color); }
/* P3-R 选镜改片 */
.rect-layer { position: absolute; pointer-events: none; }
.rect-layer.drawing { pointer-events: auto; cursor: crosshair; background: rgba(0, 0, 0, 0.15); }
.rect-box { position: absolute; border: 2px dashed var(--el-color-warning); box-sizing: border-box; pointer-events: none; }
.rect-box.live { border-style: solid; }
.rect-box span { position: absolute; left: 0; top: 100%; font-size: 11px; color: #fff; background: rgba(0, 0, 0, 0.6); padding: 1px 4px; white-space: nowrap; }
.region-edit { margin-top: 12px; padding: 12px; border: 1px solid var(--el-border-color); border-radius: 6px; display: flex; flex-direction: column; gap: 8px; }
.re-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.re-head h4 { margin: 0; }
.re-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.clip-bar { position: relative; height: 18px; background: var(--el-fill-color-dark); border-radius: 4px; cursor: pointer; }
.clip-range { position: absolute; top: 0; bottom: 0; background: var(--el-color-primary-light-5); border-radius: 4px; }
.clip-head { position: absolute; top: -2px; bottom: -2px; width: 2px; background: var(--el-color-danger); }
.hint { font-size: 12px; color: var(--el-text-color-secondary); }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cost { font-size: 13px; color: var(--el-color-warning-dark-2); }
.re-list { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.re-list li { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.re-line { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 800px) { .grid { grid-template-columns: 1fr; } .cands { grid-template-columns: repeat(2, 1fr); } }
</style>
