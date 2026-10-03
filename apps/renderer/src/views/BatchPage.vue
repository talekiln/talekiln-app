<template>
  <div class="batch-page">
    <header class="header">
      <div class="header-inner">
        <el-button text @click="goProject"><el-icon><ArrowLeft /></el-icon>项目</el-button>
        <h1 class="logo">批量生成</h1>
        <span class="sub">{{ dramaTitle || `项目 ${dramaId}` }}</span>
        <span class="spacer" />
        <el-button text @click="$router.push('/task-center')">任务中心</el-button>
        <el-button text @click="$router.push('/spend')">花费统计</el-button>
      </div>
    </header>

    <main v-loading="loading" class="main">
      <el-alert v-if="loadError" type="error" :closable="false" show-icon :title="loadError" />

      <!-- 新建批次 -->
      <section class="panel" data-test="create-panel">
        <h2>新建批次</h2>
        <div class="create-grid">
          <div class="col">
            <div class="field-title">
              选择分集
              <el-button link type="primary" size="small" data-test="select-all" @click="selectAll">全选</el-button>
              <el-button link size="small" @click="form.episodeIds = []">清空</el-button>
              <span class="hint-inline">已选 {{ form.episodeIds.length }} / {{ episodes.length }} 集</span>
            </div>
            <div v-if="!episodes.length" class="empty">该项目还没有分集</div>
            <el-checkbox-group v-model="form.episodeIds" class="episode-list" data-test="episode-list">
              <el-checkbox v-for="ep in episodes" :key="ep.id" :value="ep.id" :label="ep.id" class="episode-row">
                <span class="ep-num">第 {{ ep.episode_number ?? '?' }} 集</span>
                <span class="ep-title">{{ ep.title || '未命名' }}</span>
                <span class="ep-meta">{{ ep.storyboards?.length ?? 0 }} 镜</span>
              </el-checkbox>
            </el-checkbox-group>
          </div>

          <div class="col">
            <div class="field-title">生成内容</div>
            <el-radio-group v-model="form.kinds" data-test="kinds">
              <el-radio v-for="k in KINDS_OPTIONS" :key="k.value" :value="k.value">{{ k.label }}</el-radio>
            </el-radio-group>

            <div class="field-title">每个服务商的并发上限</div>
            <div v-for="p in providers" :key="p.id" class="prov-row" :data-test="`concurrency-${p.id}`">
              <span class="prov-name">{{ p.label }}</span>
              <el-input-number v-model="form.concurrency[p.id]" :min="1" :max="p.limit" size="small" controls-position="right" @change="onConcurrency(p)" />
              <span class="hint-inline">队列上限 {{ p.limit }}（批次上限不能超过它）</span>
            </div>
            <div v-if="!providers.length" class="hint">还没有已启用的服务商</div>

            <div class="field-title">预算上限</div>
            <el-input v-model="form.budget" size="small" placeholder="留空 = 不限制" class="budget-input" data-test="budget">
              <template #prepend>¥</template>
            </el-input>
            <div class="hint">已花费 + 在途任务的最高价 + 下一镜头的最高价超过预算时停止提交；在途按最高价（示例价 × 1.2）记账，预算建议不低于「最多」那一档。</div>
          </div>

          <div class="col">
            <div class="field-title">失败策略</div>
            <div class="policy-row">
              <span>自动重试</span>
              <el-input-number v-model="form.retry" :min="0" :max="MAX_RETRY" size="small" controls-position="right" data-test="retry" />
              <span>次后</span>
            </div>
            <el-radio-group v-model="form.on_fail" data-test="on-fail">
              <el-radio v-for="o in ON_FAIL_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</el-radio>
            </el-radio-group>
            <div class="policy-row">
              <el-switch v-model="form.night_enabled" data-test="night-switch" />
              <span>只在夜间时段提交</span>
            </div>
            <div v-if="form.night_enabled" class="policy-row">
              <el-input v-model="form.night_start" size="small" placeholder="22:00" class="time-input" data-test="night-start" />
              <span>至</span>
              <el-input v-model="form.night_end" size="small" placeholder="06:00" class="time-input" data-test="night-end" />
              <span class="hint-inline">本机时间，结束早于开始表示跨午夜；时段外不提交新任务，已提交的照常完成</span>
            </div>
            <div v-for="e in policy.errors" :key="e" class="warn">{{ e }}</div>
          </div>
        </div>

        <div class="estimate-row">
          <div class="estimate-text" data-test="estimate">
            <template v-if="!form.episodeIds.length">先选择要生成的分集</template>
            <template v-else-if="estimating">估算中…</template>
            <template v-else-if="estimate">
              <b>{{ estimateText(estimate.totals, estimate.budget_cap_cents, estimate.currency) }}</b>
              <span v-if="estimate.refusal" class="warn">{{ estimate.refusal.message }}</span>
              <span v-for="w in estimate.warnings" :key="w" class="hint-inline">{{ w }}</span>
            </template>
            <template v-else-if="estimateError"><span class="warn">{{ estimateError }}</span></template>
          </div>
          <el-button type="primary" :loading="starting" :disabled="!canStart" data-test="start" @click="onStart">开始批量生成</el-button>
        </div>
      </section>

      <!-- 批次列表 -->
      <section v-if="!batches.length" class="panel empty-panel">还没有批次。选好分集后点「开始批量生成」。</section>
      <section v-for="b in batches" :key="b.id" class="panel batch" :data-test="`batch-${b.id}`">
        <div class="batch-head">
          <el-tag :type="batchStatusTag(b.status)" size="small" data-test="batch-status">{{ batchStatusLabel(b.status) }}</el-tag>
          <span class="batch-title">{{ kindsLabel(b.kinds) }} · {{ b.episode_ids.length }} 集</span>
          <span class="batch-meta">并发 {{ concurrencyText(b) }} · 重试 {{ b.failure_policy.retry }} 次后{{ b.failure_policy.on_fail === 'pause' ? '暂停' : '跳过' }} · {{ nightText(b.failure_policy.night) }}<template v-if="b.budget_cap_cents != null"> · 预算 {{ formatCents(b.budget_cap_cents, b.currency) }}</template></span>
          <span class="spacer" />
          <el-button v-if="canPause(b)" size="small" :loading="acting === b.id" data-test="pause" @click="act(b, 'pause')">暂停</el-button>
          <el-button v-if="canResume(b)" size="small" type="primary" :loading="acting === b.id" data-test="resume" @click="onResume(b)">继续</el-button>
          <el-button v-if="canRetryFailed(b)" size="small" type="warning" plain :loading="acting === b.id" data-test="retry-failed" @click="onRetry(b)">重试失败的集</el-button>
          <el-button v-if="canCancel(b)" size="small" type="danger" plain :loading="acting === b.id" data-test="cancel" @click="onCancel(b)">取消</el-button>
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
          <el-table-column label="分集" width="150">
            <template #default="{ row }">第 {{ row.episode_number ?? '?' }} 集 <span class="ep-title-sm">{{ row.title }}</span></template>
          </el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }"><el-tag size="small" :type="itemStatusTag(row.status)">{{ itemStatusLabel(row.status) }}</el-tag></template>
          </el-table-column>
          <el-table-column label="镜头" width="90" align="center">
            <template #default="{ row }">{{ itemShotsText(row) }}</template>
          </el-table-column>
          <el-table-column label="任务" min-width="150">
            <template #default="{ row }">{{ itemTasksText(row) }}<span v-if="row.attempts" class="hint-inline">已重试 {{ row.attempts }} 次</span></template>
          </el-table-column>
          <el-table-column label="花费" width="110" align="right">
            <template #default="{ row }">{{ formatCents(row.spent_cents, b.currency) }}</template>
          </el-table-column>
          <el-table-column label="预计" width="140" align="right">
            <template #default="{ row }">{{ formatCents(row.estimate_min_cents, b.currency) }}–{{ formatCents(row.estimate_max_cents, b.currency).replace(/^¥/, '') }}</template>
          </el-table-column>
          <el-table-column label="说明" min-width="220">
            <template #default="{ row }"><span :class="{ warn: row.status === 'failed' }">{{ row.error || '' }}</span></template>
          </el-table-column>
          <el-table-column label="操作" width="110" align="center">
            <template #default="{ row }">
              <el-button v-if="row.status === 'failed' && b.status !== 'cancelled'" link type="primary" size="small" data-test="retry-item" @click="onRetry(b, row)">重试本集</el-button>
              <el-button link size="small" @click="$router.push({ name: 'episode-storyboard', params: { dramaId, episodeId: row.episode_id } })">分镜</el-button>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </main>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowLeft } from '@element-plus/icons-vue'
import { dramaAPI } from '@/api/drama'
import { batchesAPI } from '@/api/batches'
import {
  KINDS_OPTIONS, ON_FAIL_OPTIONS, MAX_RETRY, formatCents, estimateText, clampConcurrency, concurrencyBody, validatePolicy, parseBudgetYuan,
  buildCreateBody, batchStatusLabel, itemStatusLabel, batchStatusTag, itemStatusTag, waitingText, progressPercent, kindsLabel, nightText,
  pollInterval, summaryCards, canPause, canResume, canCancel, canRetryFailed, itemTasksText, itemShotsText,
} from '@/utils/batchView'

const route = useRoute()
const router = useRouter()
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
  return Object.entries(b.concurrency || {}).map(([p, n]) => `${(providers.value.find((x) => x.id === p) || {}).label || p} ${n}/${(b.provider_limits || {})[p] ?? '?'}`).join('，') || '-'
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
      estimateError.value = e?.message || '估算失败'
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
    if (!silent) loadError.value = e?.message || '读取批次失败'
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
    loadError.value = e?.message || '读取项目失败'
  } finally {
    loading.value = false
  }
}

async function onStart() {
  if (!canStart.value) return
  const est = estimate.value
  try {
    await ElMessageBox.confirm(
      `${estimateText(est.totals, est.budget_cap_cents, est.currency)}。任务在后台队列里按并发与预算逐集提交，进度在本页与任务中心查看。`,
      `确认批量生成 ${form.episodeIds.length} 集`,
      { confirmButtonText: '开始', cancelButtonText: '取消', type: 'warning' }
    )
  } catch (_) { return }
  starting.value = true
  try {
    await batchesAPI.create(body())
    ElMessage.success('批次已创建，开始排队生成')
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
  // 预算不够而暂停：顺便问要不要提高预算
  if (b.budget_cap_cents != null && /预算/.test(b.error || '')) {
    try {
      const { value } = await ElMessageBox.prompt('提高预算上限后继续（元，留空 = 不限制）', '继续批次', { inputValue: String(b.budget_cap_cents / 100), confirmButtonText: '继续', cancelButtonText: '取消' })
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
    await ElMessageBox.confirm('取消后不再提交新任务；已提交给服务商的任务会跑完并照常写回（费用已产生）。', '取消批次', { confirmButtonText: '取消批次', cancelButtonText: '返回', type: 'warning' })
  } catch (_) { return }
  return act(b, 'cancel')
}

function goProject() { router.push({ name: 'project-home', params: { dramaId: dramaId.value } }) }

onMounted(load)
onBeforeUnmount(() => { clearTimeout(pollTimer); clearTimeout(estimateTimer) })
</script>

<style scoped>
.batch-page { min-height: 100vh; background: var(--bg-page); color: var(--text-primary); }
.header-inner { display: flex; align-items: center; gap: 12px; padding: 12px 24px; }
.logo { margin: 0; font-size: 18px; }
.sub { color: var(--text-muted); font-size: 13px; }
.spacer { flex: 1; }
.main { padding: 16px 24px; display: flex; flex-direction: column; gap: 16px; }
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
