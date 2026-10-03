<template>
  <section class="cands" data-test="asset-candidates">
    <h4 class="h">{{ t('assets.lock.title') }}</h4>

    <template v-if="lock">
      <div class="locked">
        <el-image v-if="lockSrc" :src="lockSrc" fit="contain" class="locked-img" :preview-src-list="[lockSrc]" preview-teleported />
        <div class="locked-side">
          <p class="hint">{{ t(`assets.lock.hint.${kind}`) }}</p>
          <el-button size="small" type="warning" plain data-test="unlock" @click="onUnlock">{{ t('assets.lock.unlock') }}</el-button>
        </div>
      </div>
    </template>
    <p v-else class="hint">{{ t('assets.lock.none') }}</p>

    <div class="bar">
      <el-tooltip :disabled="gate.allowed" :content="gateText" placement="top">
        <span>
          <el-button size="small" type="primary" :loading="generating" :disabled="!gate.allowed" data-test="cand-generate" @click="onGenerate">{{ t('assets.cand.generate', { n: CANDIDATE_COUNT }) }}</el-button>
        </span>
      </el-tooltip>
      <template v-if="kind === 'characters'">
        <el-button size="small" :loading="picking" data-test="auto-pick" @click="onAutoPick">{{ t('assets.cand.autoPick') }}</el-button>
        <el-checkbox v-model="autoLock" size="small" data-test="auto-pick-lock">{{ t('assets.cand.autoLock') }}</el-checkbox>
      </template>
    </div>
    <p v-if="!gate.allowed" class="hint">{{ gateText }}</p>
    <p v-else class="hint">{{ t('assets.cand.hint') }}</p>
    <p v-if="error" class="hint err" data-test="cand-error">{{ error }}</p>

    <div v-if="ordered.length" class="grid">
      <div v-for="c in ordered" :key="c.key" class="cand" :class="{ on: isLockedCandidate(c.rec, lock) }">
        <el-image v-if="src(c.rec)" :src="src(c.rec)" fit="cover" class="cand-img" :preview-src-list="[src(c.rec)]" preview-teleported />
        <div v-else class="cand-img wait">
          <span v-if="c.rec && c.rec.status === 'failed'">{{ t('assets.cand.failed', { msg: c.rec.error_msg || t('assets.cand.unknown') }) }}</span>
          <span v-else>{{ t('assets.cand.running') }}</span>
        </div>
        <div v-if="c.label" class="hint rank">{{ c.label }}</div>
        <el-button
          size="small"
          :type="isLockedCandidate(c.rec, lock) ? 'success' : 'primary'"
          :disabled="!isLockable(c.rec) || isLockedCandidate(c.rec, lock)"
          @click="onLock(c.rec)"
        >{{ isLockedCandidate(c.rec, lock) ? t('assets.lock.locked') : t('assets.lock.lockIt') }}</el-button>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useI18n } from '@/i18n'
import { assetsApi } from '@/api/assets'
import { consistencyAPI } from '@/api/consistency'
import { classifyGenerationError } from '@/utils/assetGeneration'
import { candidateOrder, singularKind } from '@/utils/assets'
import { CANDIDATE_COUNT, buildCandidateRequest, candidateImageSrc, isLockable, isLockedCandidate } from '@/utils/referenceLibrary'
import { useAssetScope } from './assetContext'
import { useImageModels } from './imageModels'

const props = defineProps({
  kind: { type: String, required: true }, // characters | scenes（道具后端不支持锁定，调用方不要渲染本组件）
  id: { type: [Number, String], required: true },
})
const { t } = useI18n()
const { dramaId, assets } = useAssetScope()
const { model } = useImageModels()

const cands = ref([])
const generating = ref(false)
const picking = ref(false)
const autoLock = ref(true)
const error = ref('')
let timer = null
let seq = 0

const item = computed(() => assets.find(props.kind, props.id))
const lock = computed(() => assets.lockOf(props.kind, props.id))
const lockSrc = computed(() => candidateImageSrc(lock.value))
const gate = computed(() => assets.gate)
const gateText = computed(() => t(gate.value.reasonKey || 'assets.gen.unknown'))
const src = candidateImageSrc

const ordered = computed(() => {
  const lockedIds = new Set(cands.value.filter((c) => isLockedCandidate(c.rec, lock.value)).map((c) => c.rec.id))
  const byRec = new Map(cands.value.map((c) => [c.rec, c]))
  return candidateOrder(cands.value.map((c) => c.rec), lockedIds).map((r) => byRec.get(r))
})

function reset() {
  stopPolling()
  cands.value = []
  error.value = ''
  generating.value = false
}
watch(() => [props.kind, props.id], reset)
onBeforeUnmount(stopPolling)

function stopPolling() {
  if (timer) clearInterval(timer)
  timer = null
}

function startPolling() {
  stopPolling()
  timer = setInterval(async () => {
    const pending = cands.value.filter((c) => c.rec && !['completed', 'failed'].includes(c.rec.status))
    if (!pending.length) return stopPolling()
    await Promise.all(pending.map(async (c) => {
      try {
        c.rec = await assetsApi.getCandidate(c.rec.id)
      } catch (_) { /* 下一轮再试 */ }
    }))
  }, 3000)
}

async function onGenerate() {
  if (!item.value || !gate.value.allowed) return
  error.value = ''
  generating.value = true
  const forId = props.id
  try {
    const body = buildCandidateRequest({ kind: singularKind(props.kind), entity: item.value, dramaId: dramaId.value, model: model.value })
    const recs = await Promise.all(Array.from({ length: CANDIDATE_COUNT }, () => assetsApi.createCandidate(body)))
    if (forId !== props.id) return
    cands.value = recs.map((rec) => ({ key: ++seq, rec, label: '' }))
    startPolling()
  } catch (e) {
    const c = classifyGenerationError(e)
    error.value = c.messageKey ? t(c.messageKey) : c.message || t('assets.gen.failed')
  } finally {
    generating.value = false
  }
}

async function onLock(rec) {
  try {
    const r = await assets.lock(props.kind, props.id, rec)
    if (r.ok) ElMessage.success(t('assets.lock.lockedOk'))
  } catch (e) {
    ElMessage.error((e && e.message) || t('assets.lock.lockFailed'))
  }
}

async function onUnlock() {
  try {
    await assets.unlock(props.kind, props.id)
    ElMessage.success(t('assets.lock.unlocked'))
  } catch (e) {
    ElMessage.error((e && e.message) || t('assets.lock.unlockFailed'))
  }
}

/** 内核给本机候选图（主图 / 额外图 / 已生成图）按清晰度、分辨率、四视图相似度排序；勾选时第一名同时锁定。不调用出图，所以不受出图开关限制。 */
async function onAutoPick() {
  if (props.kind !== 'characters' || !item.value) return
  picking.value = true
  error.value = ''
  try {
    const r = await consistencyAPI.autoPick(props.id, { lock: autoLock.value })
    stopPolling()
    const ranked = Array.isArray(r?.ranked) ? r.ranked : []
    cands.value = ranked.map((x) => ({
      key: ++seq,
      label: t('assets.cand.rank', { source: t(`assets.cand.source.${x.source || 'generated'}`), score: Math.round(Number(x.score) || 0) }),
      rec: {
        id: x.source_image_id ?? null,
        status: 'completed',
        image_url: x.image_url || null,
        local_path: x.local_path || null,
        score: x.score,
      },
    }))
    if (r?.lock) await assets.reload()
    if (!ranked.length) {
      ElMessage.info(t('assets.cand.pickEmpty'))
      return
    }
    const top = r.picked || ranked[0]
    let msg = t('assets.cand.pickDone', { n: ranked.length, source: t(`assets.cand.source.${top.source || 'generated'}`), score: Math.round(Number(top.score) || 0) })
    if (r.lock || r.locked) msg += t('assets.cand.pickLocked')
    ElMessage.success(msg)
  } catch (e) {
    ElMessage.error((e && e.message) || t('assets.cand.pickFailed'))
  } finally {
    picking.value = false
  }
}
</script>

<style scoped>
.cands { display: flex; flex-direction: column; gap: 8px; }
.h { margin: 0; font-size: 13px; font-weight: 600; color: var(--text-primary); }
.hint { margin: 0; font-size: 12px; color: var(--text-muted); line-height: 1.5; }
.hint.err { color: var(--el-color-danger); }
.locked { display: flex; gap: 10px; align-items: flex-start; }
.locked-img { width: 120px; height: 120px; border-radius: 8px; flex: 0 0 auto; background: var(--bg-hover); }
.locked-side { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
.cand { display: flex; flex-direction: column; gap: 4px; padding: 4px; border: 2px solid transparent; border-radius: 8px; }
.cand.on { border-color: var(--el-color-success); }
.cand-img { width: 100%; aspect-ratio: 1 / 1; border-radius: 6px; background: var(--bg-hover); }
.cand-img.wait { display: flex; align-items: center; justify-content: center; text-align: center; padding: 6px; font-size: 12px; color: var(--text-muted); }
.rank { font-size: 11px; }
</style>
