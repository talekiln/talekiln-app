<template>
  <div class="workbench" data-test="shot-workbench">
    <div class="page-header">
      <el-button text @click="goBack"><el-icon><ArrowLeft /></el-icon>{{ t('storyboard.wb.back') }}</el-button>
      <h2 class="page-title">{{ t('storyboard.wb.title', { n: shot?.storyboard_number ?? '' }) }}</h2>
      <span class="spacer" />
      <template v-if="chips">
        <el-tag :type="chipType(chips.image)" data-test="gen-chip">{{ t('storyboard.insp.image') }} {{ t(chipKey(chips.image)) }}</el-tag>
        <el-tag :type="chipType(chips.video)" data-test="gen-chip-video">{{ t('storyboard.insp.video') }} {{ t(chipKey(chips.video)) }}</el-tag>
      </template>
      <span v-if="genFailureText" class="gen-fail">{{ genFailureText }}</span>
      <!-- read-only consistency score against the locked references (hidden when there is none) -->
      <el-tooltip v-if="consBadge" :content="consHint" placement="bottom">
        <el-tag :type="consBadge.type" data-test="consistency-chip">{{ consLabel }}</el-tag>
      </el-tooltip>
      <el-button :disabled="!episodeId" :title="t('storyboard.bar.directorHint')" data-test="open-director" @click="openDirector(episodeId)">{{ t('storyboard.bar.director') }}</el-button>
      <el-button :disabled="!episodeId || genBusy" data-test="gen-frame" @click="askGenerate('image')">{{ t('storyboard.wb.genFrame') }}</el-button>
      <el-button :disabled="!episodeId || genBusy" data-test="gen-both" @click="askGenerate('both')">{{ t('storyboard.wb.genBoth') }}</el-button>
      <el-button type="primary" :disabled="!episodeId || genBusy" data-test="gen-video" @click="regenerate">{{ t('storyboard.wb.regenVideo') }}</el-button>
    </div>

    <div v-loading="loading" class="grid">
      <section class="panel side">
        <h4>{{ t('storyboard.wb.firstFrame') }}</h4>
        <el-image v-if="firstFrame" :src="firstFrame" fit="contain" class="frame" :preview-src-list="[firstFrame]" />
        <div v-else class="frame empty">{{ t('storyboard.wb.noFirstFrame') }}</div>
        <p v-if="consHint" class="cons-hint" :class="`is-${consBadge.type}`" data-test="consistency-hint">{{ consHint }}</p>
        <ShotInspector v-if="kernelId && views.ready" :key="kernelId" :shot-id="kernelId" in-workbench />
      </section>

      <section class="panel main">
        <el-tabs v-model="tab">
          <el-tab-pane :label="t('storyboard.wb.tab.video')" name="video">
            <div ref="playerWrap" class="player-wrap">
              <video
                v-if="adoptedSrc" ref="playerEl" :key="adoptedSrc" :src="adoptedSrc" controls class="player"
                @loadedmetadata="onMeta" @error="measure" @timeupdate="headMs = nowMs()"
              />
              <div v-else class="player empty">{{ t('storyboard.wb.noAdopted') }}</div>
              <!-- box-select layer, placed over the area the picture really occupies (letterbox excluded) -->
              <div
                v-if="adoptedSrc && edit.mode === 'region'" class="rect-layer" :class="{ drawing: drawMode }" :style="layerStyle" data-test="rect-layer"
                @mousedown="onDragStart" @mousemove="onDragMove" @mouseup="onDragEnd" @mouseleave="onDragEnd"
              >
                <div v-if="edit.rect && !drag" class="rect-box" :style="rectStyle(edit.rect)"><span>{{ rectText(edit.rect) }} · {{ rectPercent(edit.rect) }}%</span></div>
                <div v-if="drag && drag.rect" class="rect-box live" :style="rectStyle(drag.rect)" />
              </div>
            </div>
          </el-tab-pane>
          <el-tab-pane :label="t('storyboard.wb.tab.compare')" name="compare">
            <div class="ab-bar">
              <span>A</span>
              <el-select :model-value="compare.a" size="small" style="width: 90px" @change="(v) => (compare = setCompareSide(compare, 'a', v))">
                <el-option v-for="v in playableVersions" :key="v.no" :label="v.label" :value="v.no" />
              </el-select>
              <span>B</span>
              <el-select :model-value="compare.b" size="small" style="width: 90px" clearable @change="(v) => (compare = setCompareSide(compare, 'b', v ?? null))">
                <el-option v-for="v in playableVersions" :key="v.no" :label="v.label" :value="v.no" />
              </el-select>
              <el-tag :type="compare.showing === 'a' ? 'primary' : 'warning'">{{ t('storyboard.wb.showing', { side: compare.showing.toUpperCase() }) }}{{ shownNo ? ` (V${shownNo})` : '' }}</el-tag>
              <el-button size="small" :disabled="compare.a == null || compare.b == null" @click="doToggle">{{ t('storyboard.wb.toggleAB') }}</el-button>
              <el-button v-if="shownVersion && !shownVersion.adopted" size="small" type="primary" @click="adoptVersion(shownVersion)">{{ t('storyboard.wb.adoptNamed', { name: shownVersion.label }) }}</el-button>
            </div>
            <video v-if="compareSrc" :key="compareSrc" :src="compareSrc" controls class="player" />
            <div v-else class="player empty">{{ t('storyboard.wb.needTwo') }}</div>
          </el-tab-pane>
          <el-tab-pane :label="t('storyboard.wb.tab.legacy')" name="legacy">
            <div class="cands legacy">
              <div v-for="(c, i) in slots" :key="i" class="cand" :class="{ adopted: c && c.adopted }">
                <div class="cand-head">
                  <strong>{{ t('storyboard.wb.cand', { n: i + 1 }) }}</strong>
                  <el-tag v-if="c && c.adopted" size="small" type="success">{{ t('storyboard.wb.adopted') }}</el-tag>
                  <el-tag v-else-if="c && c.status === 'processing'" size="small">{{ t('storyboard.wb.processing') }}</el-tag>
                  <el-tag v-else-if="c && c.status === 'failed'" size="small" type="danger">{{ t('storyboard.wb.failed') }}</el-tag>
                </div>
                <video v-if="c && isPlayable(c)" :src="candidateVideoSrc(c)" controls class="thumb" preload="metadata" />
                <div v-else class="thumb empty">{{ c ? (c.error_msg || t('storyboard.wb.waiting')) : t('storyboard.wb.slotEmpty') }}</div>
                <el-button size="small" :disabled="!pickableAt(slots, i + 1) || (c && c.adopted)" @click="pickLegacy(i + 1)">{{ t('storyboard.wb.adoptCand', { n: i + 1 }) }}</el-button>
              </div>
            </div>
          </el-tab-pane>
        </el-tabs>

        <!-- region edit: redo only the boxed region within [in, out) -->
        <div class="region-edit" data-test="region-edit">
          <div class="re-head">
            <h4>{{ t('storyboard.wb.re.title') }}</h4>
            <el-radio-group v-model="edit.mode" size="small">
              <el-radio-button value="region">{{ t('storyboard.wb.mode.region') }}</el-radio-button>
              <el-radio-button value="segment">{{ t('storyboard.wb.mode.segment') }}</el-radio-button>
            </el-radio-group>
            <span class="spacer" />
            <span v-if="regionList" class="hint">{{ strategyLabel(regionList.strategy, t) }}</span>
          </div>
          <template v-if="totalMs">
            <div class="clip-bar" data-test="clip-bar" @click="onBarClick">
              <div class="clip-range" :style="rangeStyle(edit.range, totalMs)" />
              <div class="clip-head" :style="{ left: headPercent }" />
            </div>
            <div class="re-row">
              <el-button size="small" @click="doMarkIn">{{ t('storyboard.wb.re.markIn') }}</el-button>
              <el-input-number
                :model-value="edit.range.t0 / 1000" :min="0" :max="totalMs / 1000" :step="0.1" :precision="2" size="small" controls-position="right" style="width: 120px"
                @change="(v) => setRange({ t0: Math.round((v || 0) * 1000) })"
              />
              <el-button size="small" @click="doMarkOut">{{ t('storyboard.wb.re.markOut') }}</el-button>
              <el-input-number
                :model-value="edit.range.t1 / 1000" :min="0" :max="totalMs / 1000" :step="0.1" :precision="2" size="small" controls-position="right" style="width: 120px"
                @change="(v) => setRange({ t1: Math.round((v || 0) * 1000) })"
              />
              <span class="hint">{{ t('storyboard.wb.re.rangeHint', { from: formatMs(edit.range.t0), to: formatMs(edit.range.t1), sec: segmentSeconds(edit.range.t0, edit.range.t1), total: formatMs(totalMs) }) }}</span>
            </div>
            <div v-if="edit.mode === 'region'" class="re-row">
              <el-button size="small" :type="drawMode ? 'primary' : 'default'" data-test="re-draw" @click="drawMode = !drawMode">{{ t(drawMode ? 'storyboard.wb.re.drawing' : 'storyboard.wb.re.draw') }}</el-button>
              <el-button size="small" :disabled="!edit.rect" @click="edit.rect = null">{{ t('storyboard.wb.re.clear') }}</el-button>
              <span class="hint">{{ edit.rect ? t('storyboard.wb.re.rectHint', { where: rectText(edit.rect), pct: rectPercent(edit.rect) }) : t('storyboard.wb.re.rectFirst') }}</span>
            </div>
            <el-input v-model="edit.prompt" type="textarea" :rows="2" maxlength="300" show-word-limit :placeholder="t('storyboard.wb.re.promptPlaceholder')" data-test="re-prompt" />
            <div class="re-row">
              <span v-if="estimateState.loading" class="hint">{{ t('storyboard.wb.re.estimating') }}</span>
              <span v-else-if="estimateState.data" class="cost" data-test="re-cost">{{ costLineText(estimateState.data, t) }}</span>
              <span v-else-if="estimateState.error" class="gen-fail">{{ estimateState.error }}</span>
              <span v-else class="hint">{{ t('storyboard.wb.re.costHint') }}</span>
              <span class="spacer" />
              <el-button type="primary" size="small" :loading="submitting" :disabled="!canSubmit" data-test="re-submit" @click="submitEdit">{{ t('storyboard.wb.re.submit') }}</el-button>
            </div>
            <p v-if="refusal" class="gen-fail">{{ refusal }}</p>
          </template>
          <p v-else class="hint">{{ t('storyboard.wb.re.needVideo') }}</p>

          <ul v-if="regionItems.length" class="re-list" data-test="re-list">
            <li v-for="it in regionItems" :key="it.id">
              <el-tag size="small" :type="regionStatusType(it.status)">{{ regionStatusLabel(it.status, t) }}</el-tag>
              <span class="re-line" :title="regionLineText(it, t)">{{ regionLineText(it, t) }}</span>
              <span v-if="it.error" class="gen-fail" :title="it.error">{{ it.error }}</span>
              <el-button v-if="it.status === 'done' && it.result_version_id" size="small" text type="primary" @click="adoptById(it.result_version_id)">{{ t('storyboard.wb.re.adoptResult') }}</el-button>
            </li>
          </ul>
        </div>
      </section>
    </div>

    <ShotGenerateDialog :gen="gen" />

    <h4>{{ t('storyboard.wb.versions') }}</h4>
    <div v-if="versions.length" class="cands" data-test="versions">
      <div v-for="v in versions" :key="v.id" class="cand" :class="{ adopted: v.adopted }">
        <div class="cand-head">
          <strong>{{ v.label }}</strong>
          <el-tag v-if="v.adopted" size="small" type="success">{{ t('storyboard.wb.adopted') }}</el-tag>
          <el-tag v-if="v.isEdit" size="small" type="warning">{{ t('storyboard.wb.edited') }}</el-tag>
          <span class="hint">{{ v.sourceText }}</span>
        </div>
        <video v-if="v.playable" :src="v.src" controls class="thumb" preload="metadata" />
        <div v-else class="thumb empty">{{ t('storyboard.wb.noFile') }}</div>
        <div class="hint ellipsis" :title="v.regionLabel || v.metaText">{{ v.regionLabel || v.metaText }}</div>
        <el-button size="small" type="primary" :disabled="!v.playable || v.adopted" @click="adoptVersion(v)">{{ adoptLabel(v, t) }}</el-button>
      </div>
    </div>
    <div v-else class="empty">{{ t('storyboard.wb.noVersions') }}</div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowLeft } from '@element-plus/icons-vue'
import { useI18n } from '@/i18n'
import { storyboardsAPI } from '@/api/storyboards'
import { shotCandidatesAPI } from '@/api/referenceLocks'
import { consistencyAPI } from '@/api/consistency'
import { kernelAPI } from '@/api/kernel'
import { regionEditAPI } from '@/api/regionEdit'
import { useKeymap } from '@/composables/useKeymap'
import { openDirector } from '@/composables/useDirectorPanel'
import { useProjectViewsStore } from '@/stores/projectViews'
import { consistencyBadge, consistencyShotMap, shouldRefreshConsistency } from '@/utils/consistencyView'
import { SCOPE_WORKBENCH } from '@/utils/keymap'
import { assetImageUrl } from '@/utils/mediaUrl'
import {
  buildWorkbenchHandlers, candidateVideoSrc, createCompare, isPlayable, pickableAt, setCompareSide, shownSlot, toSlots, toggleCompare,
} from '@/utils/shotWorkbench'
import {
  canSubmitEdit, clampRange, contentBox, defaultVersionCompare, editRequestBody, findVideoVersions, formatMs, fullRange,
  isRegionPending, markIn, markOut, msAtFraction, rangeStyle, rectFromDrag, rectPercent, rectStyle, regionStatusType,
  segmentSeconds, versionAt, versionItems,
} from '@/utils/regionEdit'
import {
  adoptLabel, costLineText, rectLabelText, refusalLabel, regionLineText, regionStatusLabel, strategyLabel, versionMetaLabel, versionSourceLabel,
} from '@/components/shot/workbenchLabels'
import ShotInspector from '@/components/shot/ShotInspector.vue'
import ShotGenerateDialog from '@/components/shot/ShotGenerateDialog.vue'
import { useShotGeneration } from '@/components/shot/useShotGeneration'
import { chipKey, isShotBusy, shotChips } from '@/components/shot/shotInspectorModel'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const shotId = route.params.shotId // legacy storyboard id
const shot = ref(null)
const loading = ref(false)
const tab = ref('video')
const adoptedId = ref(null)
const slots = ref(toSlots([]))
const compare = ref(createCompare())
let timer = null

// ---------- kernel versions (list, A/B compare and adopt are all kernel versions) ----------
const regionList = ref(null) // GET /shots/:id/edit-regions: edit records + video node + length
const videoInfo = ref(null) // the shot's video node item in GET /episodes/:id/versions
const versions = computed(() => {
  const raw = Array.isArray(videoInfo.value?.versions) ? videoInfo.value.versions : []
  return versionItems(videoInfo.value, regionList.value?.items || []).map((v, i) => ({
    ...v,
    sourceText: versionSourceLabel(raw[i]?.source, t),
    metaText: versionMetaLabel(raw[i]?.metadata, t),
    regionLabel: v.region ? regionLineText(v.region, t) : '',
  }))
})
const playableVersions = computed(() => versions.value.filter((v) => v.playable))
const regionItems = computed(() => regionList.value?.items || [])
const adoptedVersion = computed(() => versions.value.find((v) => v.adopted) || null)

const firstFrame = computed(() => assetImageUrl(shot.value))
const legacyAdopted = computed(() => slots.value.find((c) => c && c.id === adoptedId.value) || null)
const adoptedSrc = computed(() => adoptedVersion.value?.src || (legacyAdopted.value ? candidateVideoSrc(legacyAdopted.value) : (shot.value?.video_url || '')))
const shownNo = computed(() => shownSlot(compare.value))
const shownVersion = computed(() => (shownNo.value ? versionAt(versions.value, shownNo.value) : null))
const compareSrc = computed(() => (shownVersion.value ? shownVersion.value.src : ''))

const episodeId = computed(() => Number(shot.value?.episode_id) || 0)
const views = useProjectViewsStore()
const kernelId = computed(() => views.index.shotByLegacy[shotId] || null)
const kernelShot = computed(() => (kernelId.value ? views.index.shotById[kernelId.value] : null))

// ---------- generation: queue only ----------
const gen = useShotGeneration(episodeId, { onChanged: () => { loadShot(); refreshVersions().catch(() => {}) } })
provide('storyboardGen', gen)
const genStatus = computed(() => gen.shotStatus(shotId))
const chips = computed(() => (shot.value ? shotChips({ imageState: kernelShot.value?.image, videoState: kernelShot.value?.video }, genStatus.value) : null))
const genBusy = computed(() => isShotBusy(genStatus.value))
const chipType = (s) => ({ none: 'info', queued: 'warning', running: 'primary', stale: 'warning', fresh: 'success', failed: 'danger' }[s] || 'info')
const genFailureText = computed(() => {
  const g = genStatus.value
  if (!g || g.state !== 'failed') return ''
  const n = [g.image, g.video].find((x) => x && x.state === 'failed')
  return (n && (n.error_message || n.error_code)) || t('storyboard.state.failedHint')
})

// undo / director / inspector edits change the kernel: re-read the shot (fields are materialized into the legacy table)
watch(() => views.revision, () => { if (!loading.value) { loadShot(); refreshVersions().catch(() => {}) } })

// ---------- consistency score (read only) ----------
const consistency = ref(null)
const consShot = computed(() => consistencyShotMap(consistency.value).get(Number(shotId)) || null)
const consBadge = computed(() => consistencyBadge(consShot.value))
const CONS_HINT = { ok: 'storyboard.cons.hint.ok', check: 'storyboard.cons.hint.check', retry: 'storyboard.cons.hint.retry' }
const consScore = computed(() => (consBadge.value && Number.isFinite(Number(consBadge.value.score)) ? Math.round(Number(consBadge.value.score)) : '-'))
const consLabel = computed(() => t('storyboard.cons.chip', { score: consScore.value }))
const consHint = computed(() => (consBadge.value ? t(CONS_HINT[consBadge.value.suggestion] || CONS_HINT.check, { score: consScore.value }) : ''))
let consTimer = null
async function loadConsistency() {
  if (!episodeId.value) return
  try { consistency.value = await consistencyAPI.episodeReport(episodeId.value) } catch (_) { /* request.js already reports */ }
}
// After a task finishes and writes back, re-read the shot (video_url / first frame are materialized into legacy columns)
watch(() => genStatus.value && genStatus.value.state, (now, before) => {
  if (shouldRefreshConsistency(before, now)) {
    loadShot()
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

/** Version list: the /versions node item wins (same list as the history drawer); fall back to the one the edit-regions API returns. */
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

async function loadShot() {
  try { shot.value = await storyboardsAPI.get(shotId) } catch (_) { /* request.js already reports */ }
}

async function load() {
  loading.value = true
  try {
    await loadShot()
    if (shot.value) {
      views.load(Number(shot.value.episode_id), { drama: route.params.dramaId })
      gen.refresh()
    }
    loadConsistency()
    await Promise.all([refreshCandidates().catch(() => {}), refreshVersions()])
  } finally {
    loading.value = false
  }
}

function goBack() {
  const ep = route.params.episodeId || episodeId.value
  if (ep) router.push({ name: 'episode-storyboard', params: { dramaId: route.params.dramaId, episodeId: ep } })
  else router.back()
}

/** Estimate -> confirm -> persistent queue; when the result is written back the state turns fresh and the shot reloads. */
function askGenerate(kind, regenerateSeed = false) {
  if (!episodeId.value || genBusy.value) return
  gen.ask({ shots: [Number(shotId)], kind, regenerate: regenerateSeed })
}

/** Regenerate video = new seed, redo only this shot's video (old versions stay, switch back in the list below). */
function regenerate() {
  askGenerate('video', true)
}

/** Adopt a kernel version: the server uses adoptShotVersion so node params follow the version's recipe. */
async function adoptVersion(v) {
  if (!v || !v.playable || v.adopted) return
  try {
    await regionEditAPI.adopt(shotId, v.id)
    await refreshVersions()
    await loadShot()
    gen.refresh()
    ElMessage.success(t('storyboard.wb.adoptedNamed', { name: v.label }))
  } catch (_) { /* request.js already reports */ }
}
const adoptById = (id) => adoptVersion(versions.value.find((v) => v.id === id))

/** Alt+N: adopt kernel version N; without kernel versions (pure legacy project) adopt the legacy candidate. */
function pick(n) {
  if (versions.value.length) {
    const v = versionAt(versions.value, n)
    if (!v) { ElMessage.warning(t('storyboard.wb.versionUnavailable', { n })); return }
    return adoptVersion(v)
  }
  return pickLegacy(n)
}

async function pickLegacy(n) {
  const c = pickableAt(slots.value, n)
  if (!c) { ElMessage.warning(t('storyboard.wb.candUnavailable', { n })); return }
  try {
    applyCandidates(await shotCandidatesAPI.adopt(shotId, c.id))
    await loadShot()
    ElMessage.success(t('storyboard.wb.adoptedCand', { n }))
  } catch (e) {
    ElMessage.error((e && e.message) || t('storyboard.wb.adoptFailed'))
  }
}

function doToggle() {
  compare.value = toggleCompare(compare.value)
  if (compare.value.a == null || compare.value.b == null) ElMessage.info(t('storyboard.wb.needTwoInfo'))
  else tab.value = 'compare'
}

// ---------- region edit ----------
const playerWrap = ref(null)
const playerEl = ref(null)
const playerMs = ref(0) // length read from the player (when the kernel has no duration)
const headMs = ref(0)
const dims = ref({ elWidth: 0, elHeight: 0, videoWidth: 0, videoHeight: 0 })
const drawMode = ref(false)
const drag = ref(null)
const submitting = ref(false)
const edit = ref({ range: { t0: 0, t1: 0 }, rect: null, prompt: '', mode: 'region', touched: false })
const estimateState = ref({ loading: false, data: null, error: '' })

const rectText = (rect) => rectLabelText(rect, t)
const totalMs = computed(() => Number(regionList.value?.total_ms) || playerMs.value || Math.round((Number(shot.value?.duration) || 0) * 1000))
const headPercent = computed(() => (totalMs.value ? `${Math.min(100, (headMs.value / totalMs.value) * 100).toFixed(2)}%` : '0%'))
const layerStyle = computed(() => {
  const b = contentBox(dims.value)
  return { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` }
})
const editBody = computed(() => editRequestBody({ range: edit.value.range, rect: edit.value.rect, prompt: edit.value.prompt, mode: edit.value.mode, total: totalMs.value }))
const refusal = computed(() => refusalLabel(estimateState.value.data, t))
const canSubmit = computed(() => canSubmitEdit({ total: totalMs.value, prompt: edit.value.prompt, range: edit.value.range, rect: edit.value.rect, mode: edit.value.mode, busy: submitting.value }) && !refusal.value)

const nowMs = () => Math.round((playerEl.value?.currentTime || 0) * 1000)
// Measure as soon as the player appears: when metadata is missing (or decode fails) contentBox falls back to the whole player area, so the layer is never 0x0
watch(playerEl, (el) => { if (el) nextTick(measure) })
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

// Re-estimate (debounced) whenever the form changes: confirm=false creates no task
let estTimer = null
watch(editBody, (body) => {
  clearTimeout(estTimer)
  if (!body) { estimateState.value = { loading: false, data: null, error: '' }; return }
  estimateState.value = { ...estimateState.value, loading: true }
  estTimer = setTimeout(async () => {
    try { estimateState.value = { loading: false, data: await regionEditAPI.estimate(shotId, body), error: '' } }
    catch (e) { estimateState.value = { loading: false, data: null, error: (e && e.message) || t('storyboard.wb.re.estimateFailed') } }
  }, 400)
})

async function submitEdit() {
  const body = editBody.value
  if (!body || !canSubmit.value) return
  submitting.value = true
  try {
    const r = await regionEditAPI.submit(shotId, body)
    ElMessage.success(t(r.outcome === 'created' ? 'storyboard.wb.re.created' : r.outcome === 'retried' ? 'storyboard.wb.re.retried' : 'storyboard.wb.re.queued'))
    edit.value.prompt = ''
    await refreshVersions()
  } catch (_) { /* quota errors are shown by request.js */ } finally {
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
.workbench { max-width: 1320px; margin: 0 auto; padding: 24px; }
.page-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.page-title { margin: 0; font-size: 18px; }
.spacer { flex: 1; }
.gen-fail { font-size: 12px; color: var(--el-color-danger); max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.grid { display: grid; grid-template-columns: 400px 1fr; gap: 20px; }
.panel h4 { margin: 0 0 8px; }
.frame { width: 100%; aspect-ratio: 16 / 9; background: var(--el-fill-color); border-radius: 6px; }
.cons-hint { font-size: 12px; margin: 4px 0 8px; color: var(--el-text-color-secondary); }
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
.ellipsis { min-height: 1.5em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cost { font-size: 13px; color: var(--el-color-warning-dark-2); }
.re-list { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.re-list li { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.re-line { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 900px) { .grid { grid-template-columns: 1fr; } .cands { grid-template-columns: repeat(2, 1fr); } }
</style>
