<template>
  <div class="batch-page" data-test="batch-page">
    <div class="page-head">
      <h1 class="page-title">{{ t('generate.batch.page.title') }}</h1>
      <span class="sub">{{ dramaTitle || t('generate.batch.page.project', { id: dramaId }) }}</span>
    </div>

    <div v-loading="loading" class="main">
      <el-alert v-if="loadError" type="error" :closable="false" show-icon :title="loadError" />

      <!-- 新建批次 -->
      <section class="panel" data-test="create-panel">
        <h2>{{ t('generate.batch.create.title') }}</h2>
        <div class="create-grid">
          <div class="col">
            <div class="field-title">
              {{ t('generate.batch.create.pickEpisodes') }}
              <el-button link type="primary" size="small" data-test="select-all" @click="selectAll">{{ t('generate.batch.create.selectAll') }}</el-button>
              <el-button link size="small" @click="form.episodeIds = []">{{ t('generate.batch.create.clear') }}</el-button>
              <span class="hint-inline">{{ t('generate.batch.create.selected', { n: form.episodeIds.length, total: episodes.length }) }}</span>
            </div>
            <div v-if="!episodes.length" class="empty">{{ t('generate.batch.create.noEpisodes') }}</div>
            <el-checkbox-group v-model="form.episodeIds" class="episode-list" data-test="episode-list">
              <el-checkbox v-for="ep in episodes" :key="ep.id" :value="ep.id" :label="ep.id" class="episode-row">
                <span class="ep-num">{{ t('generate.batch.create.epNum', { n: ep.episode_number ?? '?' }) }}</span>
                <span class="ep-title">{{ ep.title || t('generate.batch.create.untitled') }}</span>
                <span class="ep-meta">{{ t('generate.batch.create.shots', { n: ep.storyboards?.length ?? 0 }) }}</span>
              </el-checkbox>
            </el-checkbox-group>
          </div>

          <div class="col">
            <div class="field-title">{{ t('generate.batch.create.what') }}</div>
            <el-radio-group v-model="form.kinds" data-test="kinds">
              <el-radio v-for="k in KINDS_OPTIONS" :key="k.value" :value="k.value">{{ k.label }}</el-radio>
            </el-radio-group>

            <div class="field-title">{{ t('generate.batch.create.concurrency') }}</div>
            <div v-for="p in providers" :key="p.id" class="prov-row" :data-test="`concurrency-${p.id}`">
              <span class="prov-name">{{ p.label }}</span>
              <el-input-number v-model="form.concurrency[p.id]" :min="1" :max="p.limit" size="small" controls-position="right" @change="onConcurrency(p)" />
              <span class="hint-inline">{{ t('generate.batch.create.queueLimit', { limit: p.limit }) }}</span>
            </div>
            <div v-if="!providers.length" class="hint">{{ t('generate.batch.create.noProviders') }}</div>

            <div class="field-title">{{ t('generate.batch.create.budget') }}</div>
            <el-input v-model="form.budget" size="small" :placeholder="t('generate.batch.create.budgetPlaceholder')" class="budget-input" data-test="budget">
              <template #prepend>¥</template>
            </el-input>
            <div class="hint">{{ t('generate.batch.create.budgetHint') }}</div>
          </div>

          <div class="col">
            <div class="field-title">{{ t('generate.batch.create.failurePolicy') }}</div>
            <div class="policy-row">
              <span>{{ t('generate.batch.create.retryBefore') }}</span>
              <el-input-number v-model="form.retry" :min="0" :max="MAX_RETRY" size="small" controls-position="right" data-test="retry" />
              <span>{{ t('generate.batch.create.retryAfter') }}</span>
            </div>
            <el-radio-group v-model="form.on_fail" data-test="on-fail">
              <el-radio v-for="o in ON_FAIL_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</el-radio>
            </el-radio-group>
            <div class="policy-row">
              <el-switch v-model="form.night_enabled" data-test="night-switch" />
              <span>{{ t('generate.batch.create.nightOnly') }}</span>
            </div>
            <div v-if="form.night_enabled" class="policy-row">
              <el-input v-model="form.night_start" size="small" placeholder="22:00" class="time-input" data-test="night-start" />
              <span>{{ t('generate.batch.create.nightTo') }}</span>
              <el-input v-model="form.night_end" size="small" placeholder="06:00" class="time-input" data-test="night-end" />
              <span class="hint-inline">{{ t('generate.batch.create.nightHint') }}</span>
            </div>
            <div v-for="e in policy.errors" :key="e" class="warn">{{ e }}</div>
          </div>
        </div>

        <div class="estimate-row">
          <div class="estimate-text" data-test="estimate">
            <template v-if="!form.episodeIds.length">{{ t('generate.batch.create.pickFirst') }}</template>
            <template v-else-if="estimating">{{ t('generate.batch.create.estimating') }}</template>
            <template v-else-if="estimate">
              <b>{{ estimateText(estimate.totals, estimate.budget_cap_cents, estimate.currency) }}</b>
              <span v-if="estimate.refusal" class="warn">{{ estimate.refusal.message }}</span>
              <span v-for="w in estimate.warnings" :key="w" class="hint-inline">{{ w }}</span>
            </template>
            <template v-else-if="estimateError"><span class="warn">{{ estimateError }}</span></template>
          </div>
          <el-button type="primary" :loading="starting" :disabled="!canStart" data-test="start" @click="onStart">{{ t('generate.batch.create.start') }}</el-button>
        </div>
      </section>

      <!-- 批次列表 -->
      <section v-if="!batches.length" class="panel empty-panel">{{ t('generate.batch.list.empty') }}</section>
      <section v-for="b in batches" :key="b.id" class="panel batch" :data-test="`batch-${b.id}`">
        <div class="batch-head">
          <el-tag :type="batchStatusTag(b.status)" size="small" data-test="batch-status">{{ batchStatusLabel(b.status) }}</el-tag>
          <span class="batch-title">{{ t('generate.batch.list.title', { kinds: kindsLabel(b.kinds), n: b.episode_ids.length }) }}</span>
          <span class="batch-meta">{{ metaText(b) }}</span>
          <span class="spacer" />
          <el-button v-if="canPause(b)" size="small" :loading="acting === b.id" data-test="pause" @click="act(b, 'pause')">{{ t('generate.batch.act.pause') }}</el-button>
          <el-button v-if="canResume(b)" size="small" type="primary" :loading="acting === b.id" data-test="resume" @click="onResume(b)">{{ t('generate.batch.act.resume') }}</el-button>
          <el-button v-if="canRetryFailed(b)" size="small" type="warning" plain :loading="acting === b.id" data-test="retry-failed" @click="onRetry(b)">{{ t('generate.batch.act.retryFailed') }}</el-button>
          <el-button v-if="canCancel(b)" size="small" type="danger" plain :loading="acting === b.id" data-test="cancel" @click="onCancel(b)">{{ t('generate.batch.act.cancel') }}</el-button>
        </div>
        <el-alert v-if="b.error" type="warning" :closable="false" show-icon :title="b.error" class="batch-alert" data-test="batch-error" />
        <div v-else-if="b.waiting && waitingText(b.waiting)" class="hint waiting" data-test="batch-waiting">{{ waitingText(b.waiting) }}</div>

        <div class="cards">
          <div v-for="c in summaryCards(b)" :key="c.key" class="card" :data-test="`card-${c.key}`">
            <div class="card-label">{{ c.label }}</div>
            <div class="card-value">{{ c.value }}</div>
            <div class="card-sub">{{ c.sub }}</div>
          </div>
        </div>
        <el-progress :percentage="progressPercent(b)" :status="b.status === 'failed' ? 'exception' : b.status === 'completed' ? 'success' : undefined" :stroke-width="10" />

        <el-table :data="b.items" size="small" row-key="episode_id" class="items" data-test="items">
          <el-table-column :label="t('generate.batch.col.episode')" width="150">
            <template #default="{ row }">{{ t('generate.batch.create.epNum', { n: row.episode_number ?? '?' }) }} <span class="ep-title-sm">{{ row.title }}</span></template>
          </el-table-column>
          <el-table-column :label="t('generate.batch.col.status')" width="90">
            <template #default="{ row }"><el-tag size="small" :type="itemStatusTag(row.status)">{{ itemStatusLabel(row.status) }}</el-tag></template>
          </el-table-column>
          <el-table-column :label="t('generate.batch.col.shots')" width="90" align="center">
            <template #default="{ row }">{{ itemShotsText(row) }}</template>
          </el-table-column>
          <el-table-column :label="t('generate.batch.col.tasks')" min-width="150">
            <template #default="{ row }">{{ itemTasksText(row) }}<span v-if="row.attempts" class="hint-inline">{{ t('generate.batch.item.retried', { n: row.attempts }) }}</span></template>
          </el-table-column>
          <el-table-column :label="t('generate.batch.col.spent')" width="110" align="right">
            <template #default="{ row }">{{ formatCents(row.spent_cents, b.currency) }}</template>
          </el-table-column>
          <el-table-column :label="t('generate.batch.col.estimate')" width="140" align="right">
            <template #default="{ row }">{{ formatCents(row.estimate_min_cents, b.currency) }}–{{ formatCents(row.estimate_max_cents, b.currency).replace(/^¥/, '') }}</template>
          </el-table-column>
          <el-table-column :label="t('generate.batch.col.note')" min-width="220">
            <template #default="{ row }"><span :class="{ warn: row.status === 'failed' }">{{ row.error || '' }}</span></template>
          </el-table-column>
          <el-table-column :label="t('generate.batch.col.actions')" width="110" align="center">
            <template #default="{ row }">
              <el-button v-if="row.status === 'failed' && b.status !== 'cancelled'" link type="primary" size="small" data-test="retry-item" @click="onRetry(b, row)">{{ t('generate.batch.act.retryItem') }}</el-button>
              <el-button link size="small" @click="$router.push({ name: 'episode-storyboard', params: { dramaId, episodeId: row.episode_id } })">{{ t('generate.batch.act.storyboard') }}</el-button>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useI18n } from '@/i18n'
import { dramaAPI } from '@/api/drama'
import { batchesAPI } from '@/api/batches'
import {
  KINDS_OPTIONS, ON_FAIL_OPTIONS, MAX_RETRY, formatCents, estimateText, clampConcurrency, concurrencyBody, validatePolicy, parseBudgetYuan,
  buildCreateBody, batchStatusLabel, itemStatusLabel, batchStatusTag, itemStatusTag, waitingText, progressPercent, kindsLabel, nightText,
  pollInterval, summaryCards, canPause, canResume, canCancel, canRetryFailed, itemTasksText, itemShotsText,
} from '@/utils/batchView'

const route = useRoute()
const { t } = useI18n()
const dramaId = computed(() => Number(route.params.dramaId))

const dramaTitle = ref('')
const episodes = ref([])
const providers = ref([])
const batches = ref([])
const loading = ref(false)
const loadError = ref('')
const starting = ref(false)
const acting = ref(null)
const estimate = ref(null)
const estimateError = ref('')
const estimating = ref(false)
let pollTimer = null
let estimateTimer = null
let estimateSeq = 0

const form = reactive({ episodeIds: [], kinds: 'both', concurrency: {}, budget: '', retry: 1, on_fail: 'skip', night_enabled: false, night_start: '22:00', night_end: '06:00' })

const policy = computed(() => validatePolicy(form))
const budget = computed(() => parseBudgetYuan(form.budget))
const canStart = computed(() => form.episodeIds.length > 0 && policy.value.ok && !budget.value.error && !!estimate.value && estimate.value.allowed && !estimating.value)

function body() {
  return buildCreateBody({
    dramaId: dramaId.value, episodeIds: form.episodeIds, kinds: form.kinds,
    concurrency: concurrencyBody(providers.value, form.concurrency), budgetCents: budget.value.value ?? null, policy: policy.value.value,
  })
}

function selectAll() { form.episodeIds = episodes.value.map((e) => e.id) }
function onConcurrency(p) { form.concurrency[p.id] = clampConcurrency(form.concurrency[p.id], p.limit, p.limit) }
function concurrencyText(b) {
  return Object.entries(b.concurrency || {}).map(([p, n]) => `${(providers.value.find((x) => x.id === p) || {}).label || p} ${n}/${(b.provider_limits || {})[p] ?? '?'}`).join(', ') || '-'
}
function metaText(b) {
  const fp = b.failure_policy || {}
  const action = t(fp.on_fail === 'pause' ? 'generate.batch.list.actionPause' : 'generate.batch.list.actionSkip')
  const base = t('generate.batch.list.meta', { conc: concurrencyText(b), retry: fp.retry, action, night: nightText(fp.night) })
  return b.budget_cap_cents != null ? base + t('generate.batch.list.metaBudget', { v: formatCents(b.budget_cap_cents, b.currency) }) : base
}

/** 选择 / 参数变化后重新估算（防抖；只估算不建）。 */
function scheduleEstimate() {
  clearTimeout(estimateTimer)
  estimate.value = null
  estimateError.value = ''
  if (!form.episodeIds.length || !policy.value.ok || budget.value.error) return
  estimating.value = true
  const seq = ++estimateSeq
  estimateTimer = setTimeout(async () => {
    try {
      const r = await batchesAPI.estimate(body())
      if (seq !== estimateSeq) return
      estimate.value = r
    } catch (e) {
      if (seq !== estimateSeq) return
      estimateError.value = e?.message || t('generate.batch.create.estimateFailed')
    } finally {
      if (seq === estimateSeq) estimating.value = false
    }
  }, 400)
}
watch(() => [form.episodeIds.slice(), form.kinds, form.budget, form.retry, form.on_fail, form.night_enabled, form.night_start, form.night_end, JSON.stringify(form.concurrency)], scheduleEstimate, { deep: true })

async function loadBatches(silent = false) {
  try {
    const data = await batchesAPI.list(dramaId.value)
    batches.value = data.items || []
    providers.value = data.providers || []
    for (const p of providers.value) if (form.concurrency[p.id] == null) form.concurrency[p.id] = p.limit
  } catch (e) {
    if (!silent) loadError.value = e?.message || t('generate.batch.loadBatchesFailed')
  } finally {
    clearTimeout(pollTimer)
    pollTimer = setTimeout(() => loadBatches(true), pollInterval(batches.value))
  }
}

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const d = await dramaAPI.get(dramaId.value)
    dramaTitle.value = d.title || ''
    episodes.value = (d.episodes || []).slice().sort((a, b) => (a.episode_number ?? 0) - (b.episode_number ?? 0))
    await loadBatches()
  } catch (e) {
    loadError.value = e?.message || t('generate.batch.loadProjectFailed')
  } finally {
    loading.value = false
  }
}

async function onStart() {
  if (!canStart.value) return
  const est = estimate.value
  // 花钱之前一定先确认：显示预计费用（含上限）
  try {
    await ElMessageBox.confirm(
      t('generate.batch.confirm.body', { estimate: estimateText(est.totals, est.budget_cap_cents, est.currency) }),
      t('generate.batch.confirm.title', { n: form.episodeIds.length }),
      { confirmButtonText: t('generate.batch.confirm.start'), cancelButtonText: t('common.cancel'), type: 'warning' }
    )
  } catch (_) { return }
  starting.value = true
  try {
    await batchesAPI.create(body())
    ElMessage.success(t('generate.batch.created'))
    form.episodeIds = []
    await loadBatches(true)
  } catch (_) {
    /* request.js 已提示错误 */
  } finally {
    starting.value = false
  }
}

async function act(b, action, ...args) {
  acting.value = b.id
  try {
    await batchesAPI[action](b.id, ...args)
    await loadBatches(true)
  } catch (_) {
    /* 同上 */
  } finally {
    acting.value = null
  }
}

async function onResume(b) {
  // 预算不够而暂停：顺便问要不要提高预算（后端的暂停原因是中文文案，按“预算”二字判断）
  if (b.budget_cap_cents != null && /预算/.test(b.error || '')) { // i18n-ignore
    try {
      const { value } = await ElMessageBox.prompt(t('generate.batch.resume.message'), t('generate.batch.resume.title'), {
        inputValue: String(b.budget_cap_cents / 100), confirmButtonText: t('generate.batch.resume.confirm'), cancelButtonText: t('common.cancel'),
      })
      const r = parseBudgetYuan(value)
      if (r.error) return ElMessage.warning(r.error)
      return act(b, 'resume', r.value === null ? null : r.value)
    } catch (_) { return }
  }
  return act(b, 'resume')
}

async function onRetry(b, item) {
  return act(b, 'retryFailed', item ? [item.episode_id] : [])
}

async function onCancel(b) {
  try {
    await ElMessageBox.confirm(t('generate.batch.cancel.message'), t('generate.batch.cancel.title'), {
      confirmButtonText: t('generate.batch.cancel.confirm'), cancelButtonText: t('generate.batch.cancel.back'), type: 'warning',
    })
  } catch (_) { return }
  return act(b, 'cancel')
}

onMounted(load)
onBeforeUnmount(() => { clearTimeout(pollTimer); clearTimeout(estimateTimer) })
</script>

<style scoped>
.batch-page { padding: 16px 24px; color: var(--text-primary); }
.page-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; }
.page-title { margin: 0; font-size: 18px; }
.sub { color: var(--text-muted); font-size: 13px; }
.spacer { flex: 1; }
.main { display: flex; flex-direction: column; gap: 16px; }
.panel { background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 8px; padding: 16px; }
.panel h2 { margin: 0 0 12px; font-size: 15px; color: var(--text-bright); }
.empty-panel, .empty { color: var(--text-subtle); font-size: 13px; }
.create-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; }
.col { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.field-title { font-size: 13px; color: var(--text-muted); margin-top: 6px; display: flex; align-items: center; gap: 8px; }
.hint { font-size: 12px; color: var(--text-subtle); line-height: 1.5; }
.hint-inline { font-size: 12px; color: var(--text-subtle); margin-left: 8px; }
.warn { color: #e6a23c; font-size: 12px; margin-left: 8px; }
.episode-list { display: flex; flex-direction: column; gap: 2px; max-height: 320px; overflow: auto; border: 1px solid var(--border-color); border-radius: 6px; padding: 6px 10px; }
.episode-row { height: auto; margin-right: 0; }
.ep-num { font-weight: 600; margin-right: 8px; }
.ep-title { color: var(--text-primary); }
.ep-meta { color: var(--text-subtle); font-size: 12px; margin-left: 8px; }
.ep-title-sm { color: var(--text-subtle); font-size: 12px; margin-left: 4px; }
.prov-row, .policy-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.prov-name { min-width: 72px; }
.budget-input { max-width: 240px; }
.time-input { width: 90px; }
.estimate-row { display: flex; align-items: center; gap: 16px; margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border-color); flex-wrap: wrap; }
.estimate-text { flex: 1; font-size: 14px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.batch-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.batch-title { font-weight: 600; color: var(--text-bright); }
.batch-meta { font-size: 12px; color: var(--text-subtle); }
.batch-alert { margin-top: 10px; }
.waiting { margin-top: 8px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 12px 0; }
.card { background: var(--bg-inner); border: 1px solid var(--border-color); border-radius: 8px; padding: 12px; }
.card-label { font-size: 12px; color: var(--text-muted); }
.card-value { font-size: 22px; font-weight: 600; margin: 4px 0; color: var(--text-bright); font-variant-numeric: tabular-nums; }
.card-sub { font-size: 12px; color: var(--text-subtle); }
.items { margin-top: 12px; }
</style>
